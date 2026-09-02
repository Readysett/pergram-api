import { createHash } from 'node:crypto';
import { db, now, currentRound, ensureWallet, flagForReview } from './db.js';
import { isPerson } from './passport.js';

export const WEEKLY_CAP_G   = 1500;   // g protein per wallet per round
export const PER_RECEIPT_G  = 1000;   // one shop is not a month's claim
export const ROLLOVER_MAX_G = 3000;

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

/**
 * Submit one receipt with its line items.
 *
 * Every rejection is deliberate about what it reveals. "Already claimed"
 * tells a farmer which field to vary next time, so the caller gets a
 * generic refusal and the detail goes to the log.
 */
export async function submitClaim({ wallet, receipt, items }){
  const addr = String(wallet || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return { ok:false, error:'bad wallet address' };
  if (!Array.isArray(items) || !items.length) return { ok:false, error:'no items' };

  ensureWallet(addr);
  const w = db.prepare(`SELECT * FROM wallet WHERE address=?`).get(addr);
  if (w.suspended) return { ok:false, error:'account under review' };

  const person = await isPerson(addr);
  if (!person.ok) return { ok:false, error:'personhood check not passed', note: person.note };

  const round = currentRound();
  const key   = receiptKey(receipt);

  const seen = db.prepare(`SELECT wallet FROM receipt WHERE key=?`).get(key);
  if (seen){
    if (seen.wallet !== addr){
      flagForReview(addr, 'receipt-reuse', 'key ' + key.slice(0,12) + ' first seen on ' + seen.wallet);
    }
    return { ok:false, error:'receipt could not be accepted' };
  }

  /* A receipt dated in the future, or long in the past, is either a bad
     OCR read or someone working through a shoebox. Neither should pay. */
  const age = now() - (receipt.purchased || 0);
  if (age < -86400000)        return { ok:false, error:'receipt date is in the future' };
  if (age > 30 * 86400000)    return { ok:false, error:'receipt is older than 30 days' };

  let batchProtein = 0;
  for (const it of items) batchProtein += Number(it.protein_g) || 0;
  if (batchProtein > PER_RECEIPT_G){
    return { ok:false, error:`one receipt may claim at most ${PER_RECEIPT_G}g of protein` };
  }

  const before = weekTotals(addr, round.id);
  const room   = Math.max(0, WEEKLY_CAP_G - before.protein);

  db.prepare(`INSERT INTO receipt (key, wallet, store, txn, purchased, total_cents, image_hash, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(key, addr, receipt.store || null, receipt.txn || null,
         receipt.purchased || now(), receipt.total_cents || null,
         receipt.image_hash || null, now());

  const insert = db.prepare(`
    INSERT INTO claim (wallet, round_id, receipt_key, barcode, product, source_key,
                       protein_g, co2_kg, mult, points, state, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const accepted = [];
  for (const it of items){
    const protein = Number(it.protein_g) || 0;
    if (protein <= 0) continue;
    const points  = protein * Number(it.mult || 0);
    const co2     = protein / 100 * Number(it.co2 || 0);
    try {
      insert.run(addr, round.id, key, String(it.barcode), it.product || null,
                 it.source_key || 'unresolved', protein, co2,
                 Number(it.mult || 0), points, 'verified', now());
      accepted.push({ barcode: it.barcode, protein_g: protein, points });
    } catch (e){
      // UNIQUE(receipt_key, barcode) — the same line claimed twice.
      continue;
    }
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
    week: {
      protein_g: after.protein,
      counted_g: Math.min(after.protein, WEEKLY_CAP_G),
      cap_g: WEEKLY_CAP_G,
      room_before_g: room,
      points_raw: after.points,
      co2_kg: after.co2,
      over_cap: after.protein > WEEKLY_CAP_G,
    },
  };
}
