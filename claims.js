import { createHash, randomUUID } from 'node:crypto';
import { db, now, currentRound, ensureWallet, flagForReview } from './db.js';
import { isPerson } from './passport.js';
import { resolveProduct, isBarcode, LookupUnavailable } from './products.js';
import { matchProduct, resolveQuantity } from './receipt-parse.js';

export const WEEKLY_CAP_G   = 1500;   // g protein per wallet per round
export const PER_RECEIPT_G  = 1000;   // one shop is not a month's claim
export const ROLLOVER_MAX_G = 3000;

/* A scan is a reading of a receipt, not a claim. It exists only long
   enough for the user to look at the matches and confirm them. */
export const SCAN_TTL_MS = Number(process.env.SCAN_TTL_MS || 3600000);

/* Every barcode on a scan costs an Open Food Facts lookup on a cache
   miss, so the list a caller can send is bounded. A real shop is a
   handful of scanned products; a thousand is someone using the endpoint
   as a free lookup service against a third party's rate limit. */
export const MAX_SCAN_BARCODES = Number(process.env.MAX_SCAN_BARCODES || 50);

/* A receipt's identity is the transaction it records, not the photo of
   it. Two photos of one receipt must collide; two genuine shops on the
   same day at the same store must not. */
export function receiptKey({ store, txn, purchased, total_cents, image_hash }){
  const basis = txn
    ? [store, txn, new Date(purchased).toISOString().slice(0, 10), total_cents].join('|')
    : ['img', image_hash].join('|');   // weaker fallback when the txn id is unreadable
  return createHash('sha256').update(basis).digest('hex');
}

export function weekTotals(wallet, roundId){
  const r = db.prepare(`
    SELECT COALESCE(SUM(protein_g),0) AS protein,
           COALESCE(SUM(points),0)    AS points,
           COALESCE(SUM(co2_kg),0)    AS co2,
           COUNT(*)                   AS n
    FROM claim
    WHERE wallet = ? AND round_id = ? AND state IN ('verified','settled','paid')
  `).get(String(wallet).toLowerCase(), roundId);
  return r;
}

/* ---------- scans ----------
 *
 * /api/receipt records what it read here; /api/claim prices from it and
 * nowhere else. The parse already resolves each quantity correctly at
 * read time — it used to compute that, return it and throw it away,
 * which left the claim endpoint with no matched line to take a quantity
 * FROM and no option but to believe the client's number.
 */
export function createScan({ wallet, roundId, receipt, lines }){
  const id = randomUUID();
  db.prepare(`
    INSERT INTO receipt_scan (id, wallet, round_id, store, txn, purchased,
                              total_cents, image_hash, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(id, String(wallet).toLowerCase(), roundId,
         receipt.store || null, receipt.txn || null,
         receipt.purchased || now(), receipt.total_cents || null,
         receipt.image_hash || null, now());

  const ins = db.prepare(`
    INSERT INTO receipt_scan_line
      (scan_id, barcode, matched, line_text, grams, lower_g, ask_question, product_version)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  for (const l of lines){
    try {
      ins.run(id, String(l.barcode), l.matched ? 1 : 0, l.line_text || null,
              l.grams ?? null, l.lower_g ?? null, l.ask_question || null,
              l.product_version ?? null);
    } catch (e){
      continue;   // the same barcode twice in one basket; the first stands
    }
  }
  return id;
}

/**
 * Turn a parsed receipt and a list of barcodes into a stored scan.
 *
 * Both halves of the old hole close here. The product is resolved from
 * the barcode against the server's own cache, so the name matched
 * against the receipt lines is the server's and not one the caller chose
 * — a client-supplied name can bind a cheap barcode to an expensive
 * line. And the quantity the match produces is written down rather than
 * returned and forgotten, which is what gives /api/claim a matched line
 * to price from.
 *
 * @returns {{ scan_id: string, matches: object[], unavailable: string[] }}
 */
export async function scanReceipt({ wallet, roundId, parsed, image_hash, barcodes }){
  const asked = [...new Set((barcodes || []).map(String).filter(isBarcode))]
    .slice(0, MAX_SCAN_BARCODES);

  const products = new Map();
  const unavailable = [];
  for (const barcode of asked){
    try {
      products.set(barcode, await resolveProduct(barcode, roundId));
    } catch (e){
      /* A lookup that did not settle. Reported, never cached, and
         retried at claim time — it must not become a priced zero. */
      if (e instanceof LookupUnavailable){ unavailable.push(barcode); continue; }
      throw e;
    }
  }

  const matches = asked.map(barcode => {
    const prod = products.get(barcode);

    /* Nothing usable known about the product means no name to match on
       and no unit weight to apply. Report it; do not guess. */
    if (!prod || prod.status !== 'ok'){
      return {
        barcode, name: prod ? prod.name : null,
        status: prod ? prod.status : 'unavailable',
        matched: false, line: null, score: 0,
        count: null, pack: null, grams: null, ask: null, protein_g: null,
      };
    }

    const line = matchProduct(prod.name || '', parsed.lines);
    const q    = resolveQuantity({ line, quantity: prod.quantity, productName: prod.name });
    return {
      barcode,
      name: prod.name,
      status: 'ok',
      matched: !!line,
      line: line ? line.text : null,
      score: line ? line.score : 0,
      count: q.count,
      pack:  q.pack,
      grams: q.grams,
      ask:   q.ask,
      source_key: prod.source_key,
      protein_g: (q.grams && prod.protein_100g)
        ? +(q.grams * prod.protein_100g / 100).toFixed(1) : null,
    };
  });

  const scan_id = createScan({
    wallet, roundId,
    receipt: {
      store: parsed.store, txn: parsed.txn,
      purchased: parsed.purchased || now(),
      total_cents: parsed.total_cents, image_hash,
    },
    lines: matches.map(m => ({
      barcode: m.barcode,
      matched: m.matched,
      line_text: m.line,
      grams: m.grams,
      lower_g: m.ask ? m.ask.lower_g : null,
      ask_question: m.ask ? m.ask.question : null,
      product_version: products.has(m.barcode) ? products.get(m.barcode).version : null,
    })),
  });

  return { scan_id, matches, unavailable };
}

export function getScan(id){
  return db.prepare(`SELECT * FROM receipt_scan WHERE id=?`).get(String(id || ''));
}

export function scanLines(id){
  return db.prepare(`SELECT * FROM receipt_scan_line WHERE scan_id=?`).all(String(id || ''));
}

export function sweepScans(){
  db.prepare(`DELETE FROM receipt_scan_line WHERE scan_id IN
                (SELECT id FROM receipt_scan WHERE created_at < ?)`)
    .run(now() - SCAN_TTL_MS);
  db.prepare(`DELETE FROM receipt_scan WHERE created_at < ?`).run(now() - SCAN_TTL_MS);
}

function weekView(t, extra = {}){
  return {
    protein_g: t.protein,
    counted_g: Math.min(t.protein, WEEKLY_CAP_G),
    cap_g: WEEKLY_CAP_G,
    points_raw: t.points,
    co2_kg: t.co2,
    over_cap: t.protein > WEEKLY_CAP_G,
    ...extra,
  };
}

function replay(addr, key, roundId){
  const prior = db.prepare(`
    SELECT barcode, protein_g, points FROM claim WHERE wallet=? AND receipt_key=?
  `).all(addr, key);
  const t = weekTotals(addr, roundId);
  return {
    ok: true,
    round: roundId,
    replayed: true,
    accepted: prior.map(c => ({ barcode: c.barcode, protein_g: c.protein_g, points: c.points })),
    week: weekView(t),
  };
}

/**
 * Claim the lines of a receipt the server has already read.
 *
 * The request carries a scan id and a list of barcodes. Nothing else it
 * sends bears on the reward, because nothing else is read: the quantity
 * comes from the matched receipt line, the product from the versioned
 * cache, and the rate from that product's footprint. A client that sends
 * a protein figure, a multiplier or a footprint is not rejected for it —
 * those fields are simply never looked at.
 *
 * Every rejection is deliberate about what it reveals. "Already claimed"
 * tells a farmer which field to vary next time, so the caller gets a
 * generic refusal and the detail goes to the log.
 */
export async function submitClaim({ wallet, scan_id, items }){
  const addr = String(wallet || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return { ok:false, error:'bad wallet address' };
  if (!Array.isArray(items) || !items.length) return { ok:false, error:'no items' };

  ensureWallet(addr);
  const w = db.prepare(`SELECT * FROM wallet WHERE address=?`).get(addr);
  if (w.suspended) return { ok:false, error:'account under review' };

  const person = await isPerson(addr);
  if (!person.ok) return { ok:false, error:'personhood check not passed', note: person.note };

  const round = currentRound();

  const scan = getScan(scan_id);
  if (!scan) return { ok:false, error:'send the receipt again' };

  /* A scan belongs to the wallet that uploaded it. Without this, one
     account's confirmed receipt is a token another can spend. */
  if (scan.wallet !== addr) return { ok:false, error:'send the receipt again' };

  if ((now() - scan.created_at) > SCAN_TTL_MS){
    return { ok:false, error:'that receipt reading has expired — send it again' };
  }

  /* Prices are pinned per round. A scan read in a round that has since
     closed would carry last week's figures into this week's pool. */
  if (scan.round_id !== round.id){
    return { ok:false, error:'that receipt reading is from a closed round — send it again' };
  }

  const receipt = {
    store: scan.store, txn: scan.txn, purchased: scan.purchased,
    total_cents: scan.total_cents, image_hash: scan.image_hash,
  };
  const key = receiptKey(receipt);

  const seen = db.prepare(`SELECT wallet FROM receipt WHERE key=?`).get(key);
  if (seen){
    if (seen.wallet !== addr){
      flagForReview(addr, 'receipt-reuse', 'key ' + key.slice(0,12) + ' first seen on ' + seen.wallet);
      return { ok:false, error:'receipt could not be accepted' };
    }

    /* The same wallet sending the same receipt again is a retry, not a
       second claim. Refusing it would be honest and still wrong: the
       caller treats a refusal as "store this on the device instead", so
       a receipt accepted once ends up counted twice. Replay the original
       result — sending the request twice must leave the same state as
       sending it once. */
    return replay(addr, key, round.id);
  }

  /* A receipt dated in the future, or long in the past, is either a bad
     OCR read or someone working through a shoebox. Neither should pay.
     Read off the stored parse, not off the request. */
  const age = now() - (scan.purchased || 0);
  if (age < -86400000)        return { ok:false, error:'receipt date is in the future' };
  if (age > 30 * 86400000)    return { ok:false, error:'receipt is older than 30 days' };

  const byBarcode = new Map(scanLines(scan_id).map(l => [l.barcode, l]));

  /* ---------- price everything before writing anything ----------
   *
   * A receipt is consumed atomically: its key is the anti-replay
   * control, so a partial write leaves the lines that failed permanently
   * unclaimable. Any line that cannot be priced fails the whole
   * submission, and the user retries with nothing spent.
   */
  const priced = [];
  const done = new Set();
  for (const it of items){
    const barcode = String((it && it.barcode) || '');

    /* The same line sent twice is one claim. Without this the duplicate
       would be counted against the per-receipt cap and then dropped by
       the unique constraint, so a repeated barcode could refuse a
       legitimate receipt. */
    if (done.has(barcode)) continue;
    done.add(barcode);
    const line = byBarcode.get(barcode);

    /* Not on the scan at all: a barcode the receipt reading never saw. */
    if (!line) return { ok:false, error:'that receipt reading does not cover ' + barcode };

    /* No matching line means the receipt does not show this being
       bought. The product record alone says what a unit weighs, never
       that one was purchased. */
    if (!line.matched || line.grams === null){
      return { ok:false, error:'the receipt does not show a line for ' + barcode };
    }

    /* Re-resolving rather than trusting the version recorded on the scan
       line: the round pin is authoritative, and a lookup that did not
       settle at read time gets its second chance here — cheaply, and
       without the user re-photographing anything. */
    let product;
    try {
      product = await resolveProduct(barcode, round.id);
    } catch (e){
      if (e instanceof LookupUnavailable){
        /* Never a zero-value claim and never a burnt receipt: the whole
           submission fails, retryably, and the receipt stays claimable. */
        return { ok:false, retryable:true,
                 error:'could not check one of these products just now — try again in a moment' };
      }
      throw e;
    }

    if (product.status !== 'ok'){
      return { ok:false, error: product.status === 'absent'
        ? barcode + ' is not in the product database yet'
        : barcode + ' is not a protein source, so it earns nothing' };
    }

    /* The quantity is the matched line's, never the request's. The one
       thing the caller may say is the answer to a question the scan
       asked, and answering can only ever lower the figure. */
    const answeredLower = it && it.answer === 'lower'
                       && line.lower_g !== null && line.lower_g < line.grams;
    const grams = answeredLower ? line.lower_g : line.grams;

    const protein = +(grams * product.protein_100g / 100).toFixed(3);
    if (!(protein > 0)) continue;

    priced.push({
      barcode,
      product_name: product.name,
      version: product.version,
      source_key: product.source_key,
      protein,
      co2: protein / 100 * product.co2,
      mult: product.mult,
      points: protein * product.mult,
    });
  }

  if (!priced.length) return { ok:false, error:'nothing on this receipt could be claimed' };

  const batchProtein = priced.reduce((s, p) => s + p.protein, 0);
  if (batchProtein > PER_RECEIPT_G){
    return { ok:false, error:`one receipt may claim at most ${PER_RECEIPT_G}g of protein` };
  }

  const before = weekTotals(addr, round.id);
  const room   = Math.max(0, WEEKLY_CAP_G - before.protein);

  /* ---------- write ---------- */
  const insert = db.prepare(`
    INSERT INTO claim (wallet, round_id, receipt_key, barcode, product, source_key,
                       protein_g, co2_kg, mult, points, product_version, state, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const accepted = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO receipt (key, wallet, store, txn, purchased, total_cents, image_hash, created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(key, addr, receipt.store, receipt.txn,
           receipt.purchased || now(), receipt.total_cents,
           receipt.image_hash, now());

    for (const p of priced){
      try {
        insert.run(addr, round.id, key, p.barcode, p.product_name, p.source_key,
                   p.protein, p.co2, p.mult, p.points, p.version, 'verified', now());
        accepted.push({ barcode: p.barcode, protein_g: p.protein, points: p.points });
      } catch (e){
        // UNIQUE(receipt_key, barcode) — the same line claimed twice.
        continue;
      }
    }

    db.prepare(`UPDATE receipt_scan SET consumed_at=? WHERE id=?`).run(now(), scan_id);
    db.exec('COMMIT');
  } catch (e){
    db.exec('ROLLBACK');
    /* Two requests raced on the same receipt. The winner's claims stand;
       report those rather than a failure the caller would store offline. */
    if (db.prepare(`SELECT 1 FROM receipt WHERE key=?`).get(key)) return replay(addr, key, round.id);
    throw e;
  }

  const after = weekTotals(addr, round.id);

  /* New wallet claiming the maximum immediately is the signature of a
     farm. Flag it; never auto-reject on a heuristic. */
  if ((now() - w.created_at) < 3600000 && after.protein >= WEEKLY_CAP_G * 0.8){
    flagForReview(addr, 'fast-max', 'hit ' + Math.round(after.protein) + 'g within an hour of signup');
  }

  return {
    ok: true,
    round: round.id,
    accepted,
    week: weekView(after, { room_before_g: room }),
  };
}
