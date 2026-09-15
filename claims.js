import { createHash, randomUUID } from 'node:crypto';
import { db, now, currentRound, ensureWallet, flagForReview,
         claimWindowDays, weeklyCapG, WEEKLY_CAP_G, requiresScanOrder } from './db.js';
import { isPerson } from './passport.js';
import { resolveProduct, isBarcode, LookupUnavailable } from './products.js';
import { matchProduct, resolveQuantity } from './receipt-parse.js';
import { record } from './audit.js';

/* Re-exported so callers keep importing the cap from here. The value and
   the per-round accessor live in db.js, beside the column they are
   stamped on.
 *
 * There is no rollover and no per-receipt limit. ROLLOVER_MAX_G was
 * declared here and never read by anything — a documented behaviour the
 * code did not have. PER_RECEIPT_G existed to stop one shop being a
 * month's claim, and the weekly cap and the five-day window now do that
 * between them; at a 3000g cap it would have refused a single bulk tub
 * the cap has room for. Both are gone rather than adjusted to numbers
 * that make them redundant. */
export { WEEKLY_CAP_G, weeklyCapG };

/* A scan is a reading of a receipt, not a claim. It exists only long
   enough for the user to look at the matches and confirm them. */
export const SCAN_TTL_MS = Number(process.env.SCAN_TTL_MS || 3600000);

/* Every barcode on a scan costs an Open Food Facts lookup on a cache
   miss, so the list a caller can send is bounded. A real shop is a
   handful of scanned products; a thousand is someone using the endpoint
   as a free lookup service against a third party's rate limit. */
export const MAX_SCAN_BARCODES = Number(process.env.MAX_SCAN_BARCODES || 50);

/* How long a registered barcode stays usable. Long enough to scan the
   shopping in the evening and photograph the receipt the next day; short
   enough that nobody accumulates a standing library of barcodes to reach
   for when a receipt happens to suit one. */
export const SCAN_ORDER_TTL_MS = Number(process.env.SCAN_ORDER_TTL_MS || 3 * 86400000);

/* Below this, the registration and the upload are too close together to
   have been a person walking to a receipt. Not a rejection — the app can
   be quick and a person can be quick with it — but the one shape a
   modified client cannot avoid leaving, so it is worth a look. */
export const SCAN_ORDER_SUSPICIOUS_MS = Number(process.env.SCAN_ORDER_SUSPICIOUS_MS || 1500);

/**
 * Record that a wallet scanned a barcode, now.
 *
 * Deliberately does not look the product up. That keeps the endpoint
 * cheap and stops it becoming a free Open Food Facts proxy; resolution
 * still happens once, when a receipt is read.
 */
export function registerScan(wallet, barcode){
  const addr = String(wallet || '').toLowerCase();
  const code = String(barcode || '');
  if (!isBarcode(code)) return null;
  const at = now();
  db.prepare(`INSERT INTO product_scan (wallet, barcode, scanned_at) VALUES (?,?,?)`)
    .run(addr, code, at);
  return at;
}

/**
 * The earliest live registration of this barcode by this wallet.
 * Earliest rather than latest: a re-scan must not be able to move the
 * ordering, only to keep it alive.
 */
export function earliestScan(wallet, barcode, before = now()){
  const r = db.prepare(`
    SELECT MIN(scanned_at) AS at FROM product_scan
    WHERE wallet=? AND barcode=? AND scanned_at < ? AND scanned_at >= ?
  `).get(String(wallet).toLowerCase(), String(barcode), before, before - SCAN_ORDER_TTL_MS);
  return r && r.at !== null ? r.at : null;
}

export function sweepScanRegistrations(){
  db.prepare(`DELETE FROM product_scan WHERE scanned_at < ?`).run(now() - SCAN_ORDER_TTL_MS);
}

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
export async function scanReceipt({ wallet, roundId, parsed, image_hash, barcodes,
                                    uploadedAt = now() }){
  const asked = [...new Set((barcodes || []).map(String).filter(isBarcode))]
    .slice(0, MAX_SCAN_BARCODES);

  /* ---------- the ordering ----------
   *
   * A barcode has to have been registered before this receipt was
   * uploaded. Reading the receipt first and then finding products to fit
   * its lines is the thing this refuses: scanning something you did not
   * buy, because a line happens to read PROT PWDR, costs nothing
   * otherwise.
   *
   * Whether it is enforced belongs to the round, not to a constant read
   * here — switching it on mid-round would refuse receipts from every
   * app version that has not shipped the call yet. Until a round is
   * stamped with it, the gap is measured and recorded but nothing is
   * refused. */
  const round = db.prepare(`SELECT * FROM round WHERE id=?`).get(roundId);
  const enforce = requiresScanOrder(round);

  const order = new Map();
  for (const barcode of asked){
    const at = earliestScan(wallet, barcode, uploadedAt);
    order.set(barcode, at === null ? null : uploadedAt - at);
  }

  const unregistered = asked.filter(b => order.get(b) === null);
  const hurried = asked.filter(b => {
    const gap = order.get(b);
    return gap !== null && gap < SCAN_ORDER_SUSPICIOUS_MS;
  });

  /* Registration and upload in the same breath is the one shape a
     modified client cannot avoid leaving. Flagged, never auto-rejected:
     the app can be quick, and banning on a heuristic catches real
     people. */
  if (hurried.length){
    flagForReview(wallet, 'scan-order-hurried',
      hurried.length + ' barcode(s) registered under '
      + SCAN_ORDER_SUSPICIOUS_MS + 'ms before the receipt: ' + hurried.join(', '));
  }

  const products = new Map();
  const unavailable = [];
  for (const barcode of asked){
    /* No lookup for something that will be refused anyway — an Open Food
       Facts call is the expensive part of reading a receipt. */
    if (enforce && order.get(barcode) === null) continue;
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
    /* Refused before the product is even considered: whether the scan
       came first is a fact about this wallet's history, not about the
       product, and answering it needs no lookup. */
    if (enforce && order.get(barcode) === null){
      return {
        barcode, name: null, status: 'not_scanned_first',
        matched: false, line: null, score: 0,
        count: null, pack: null, grams: null, ask: null, protein_g: null,
      };
    }

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
      /* A matched line whose size is nowhere — not on the line, not in
         the product record — is a different failure from no line at all,
         and reporting both as a match failure said something false about
         a line that matched fine. The user can act on this one: adding
         the quantity in Open Food Facts fixes the record for everyone. */
      status: (line && q.grams === null) ? 'size_unknown' : 'ok',
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

  /* Counted, not just reported. How often a matched line has no size
     anywhere is a question about real receipts, and the honest way to
     answer it is to count it for a while rather than infer it from
     whichever receipt happened to surface it. Each row is one barcode on
     one receipt, with the store, so the rate can be read per retailer —
     a truck stop and a supermarket print very different lines. */
  const insertOutcome = db.prepare(`
    INSERT INTO quantity_outcome (at, wallet, barcode, store, outcome, had_line_size, had_record_size)
    VALUES (?,?,?,?,?,?,?)
  `);
  for (const m of matches){
    if (!m.matched && m.status !== 'size_unknown') continue;
    const prod = products.get(m.barcode);
    insertOutcome.run(now(), String(wallet).toLowerCase(), m.barcode,
      parsed.store || null,
      m.status === 'size_unknown' ? 'size_unknown' : 'sized',
      m.grams !== null ? 1 : 0,
      prod && prod.quantity ? 1 : 0);
  }

  return { scan_id, matches, unavailable,
           scan_order: {
             enforced: enforce,
             not_scanned_first: unregistered,
           } };
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

/* The cap is the round's, not the constant's: a round settles under the
   figure it was opened with, so a raise must not reach back into one
   that is already part-claimed. */
function weekView(t, cap, extra = {}){
  return {
    protein_g: t.protein,
    counted_g: Math.min(t.protein, cap),
    cap_g: cap,
    points_raw: t.points,
    co2_kg: t.co2,
    over_cap: t.protein > cap,
    ...extra,
  };
}

function replay(addr, key, round){
  const prior = db.prepare(`
    SELECT barcode, protein_g, points FROM claim WHERE wallet=? AND receipt_key=?
  `).all(addr, key);
  const t = weekTotals(addr, round.id);
  return {
    ok: true,
    round: round.id,
    replayed: true,
    accepted: prior.map(c => ({ barcode: c.barcode, protein_g: c.protein_g, points: c.points })),
    week: weekView(t, weeklyCapG(round)),
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
    return replay(addr, key, round);
  }

  /* A receipt dated in the future, or long in the past, is either a bad
     OCR read or someone working through a shoebox. Neither should pay.
     Read off the stored parse, not off the request.

     The window comes from the round the claim lands in, not from a
     constant read at claim time, so tightening it takes effect at a
     round boundary rather than voiding receipts mid-round that were
     claimable the same morning. */
  const windowDays = claimWindowDays(round);
  const age = now() - (scan.purchased || 0);
  if (age < -86400000) return { ok:false, error:'receipt date is in the future' };
  if (age > windowDays * 86400000){
    return { ok:false,
             error:`receipt is older than ${windowDays} day${windowDays === 1 ? '' : 's'}` };
  }

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
    if (!line.matched){
      return { ok:false, error:'the receipt does not show a line for ' + barcode };
    }

    /* The line matched and nothing anywhere says what it weighed: no size
       on the receipt line, none in the product record. Saying "no
       matching line" here was simply untrue, and the two call for quite
       different things from the user — one is a bad match, the other is
       a gap in a database anyone can fill. */
    if (line.grams === null){
      return { ok:false,
               error:'no size on the receipt or in the product record for ' + barcode
                   + ' — add the quantity in the Open Food Facts app and it will work next time' };
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

  const cap    = weeklyCapG(round);
  const before = weekTotals(addr, round.id);
  const room   = Math.max(0, cap - before.protein);

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
      let claimId;
      try {
        claimId = insert.run(addr, round.id, key, p.barcode, p.product_name, p.source_key,
                             p.protein, p.co2, p.mult, p.points, p.version, 'verified', now())
                        .lastInsertRowid;
        accepted.push({ barcode: p.barcode, protein_g: p.protein, points: p.points });
      } catch (e){
        // UNIQUE(receipt_key, barcode) — the same line claimed twice.
        continue;
      }

      /* Inside the transaction, so the entry and the claim commit
         together. An entry for a claim that rolled back would be a lie,
         and a claim with no entry is the gap this closes. Every figure
         that decided the reward is here, including the product version
         it was priced from — enough to recompute the claim from the
         cache row without trusting the claim row. */
      record({
        subject: 'claim', subject_id: claimId, event: 'created',
        to_state: 'verified', round_id: round.id, wallet: addr, actor: 'claim-api',
        detail: {
          barcode: p.barcode, source_key: p.source_key,
          product_version: p.version,
          protein_g: p.protein, mult: p.mult, points: p.points, co2_kg: p.co2,
          receipt_key: key.slice(0, 16), scan_id,
        },
      });
    }

    db.prepare(`UPDATE receipt_scan SET consumed_at=? WHERE id=?`).run(now(), scan_id);
    db.exec('COMMIT');
  } catch (e){
    db.exec('ROLLBACK');
    /* Two requests raced on the same receipt. The winner's claims stand;
       report those rather than a failure the caller would store offline. */
    if (db.prepare(`SELECT 1 FROM receipt WHERE key=?`).get(key)) return replay(addr, key, round);
    throw e;
  }

  const after = weekTotals(addr, round.id);

  /* New wallet claiming the maximum immediately is the signature of a
     farm. Flag it; never auto-reject on a heuristic. */
  if ((now() - w.created_at) < 3600000 && after.protein >= cap * 0.8){
    flagForReview(addr, 'fast-max', 'hit ' + Math.round(after.protein) + 'g within an hour of signup');
  }

  return {
    ok: true,
    round: round.id,
    accepted,
    week: weekView(after, cap, { room_before_g: room }),
  };
}
