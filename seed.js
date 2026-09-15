/* Smoke test with fake data — no chain, no receipts, no network.
   Proves the cap, the duplicate rejection and settlement all behave.

   Products are seeded straight into the cache and receipt lines are
   handed to createScan directly, so nothing here reaches Open Food Facts
   or an OCR provider. Everything a claim is worth is still derived by
   the server from those two, exactly as it is in production. */
import { db, now, currentRound, weeklyCapG } from './db.js';
import { submitClaim, createScan } from './claims.js';
import { settle } from './settle.js';

const W1 = '0x' + '11'.repeat(20);
const W2 = '0x' + '22'.repeat(20);

// Skip the live passport call in the smoke test.
db.exec(`INSERT OR REPLACE INTO wallet (address, created_at, passport_ok, passport_at, passport_note)
         VALUES ('${W1}', ${Date.now() - 86400000 * 30}, 1, ${Date.now()}, 'seeded'),
                ('${W2}', ${Date.now() - 86400000 * 30}, 1, ${Date.now()}, 'seeded')`);

/* The product cache the server would have built from a lookup. */
const product = (barcode, name, protein100, source, co2, mult) =>
  db.prepare(`
    INSERT OR IGNORE INTO product_version
      (barcode, version, status, name, protein_100g, source_key, co2, mult, rules_hash, fetched_at)
    VALUES (?,1,'ok',?,?,?,?,?,'seed',?)
  `).run(barcode, name, protein100, source, co2, mult, now());

product('874659000168', 'Whey Isolate',    75, 'whey',   3.6, 0.56);
product('032251167454', 'Cheddar',         25, 'cheese', 21,  0.10);
product('000000000999', 'Bulk Pea Powder', 80, 'pea',    0.4, 1.00);

const round = currentRound();

/* One receipt, one line, with the grams the parse would have resolved.
   The claim's protein is derived from those grams and the cached
   protein-per-100g, never stated here. */
function scanFor(wallet, txn, total, barcode, grams){
  return createScan({
    wallet, roundId: round.id,
    receipt: { store:'store-1', txn, purchased: Date.now() - 3600000,
               total_cents: total, image_hash: 'seed-' + txn },
    lines: [{ barcode, matched: 1, line_text: barcode, grams, product_version: 1 }],
  });
}
const claim = (wallet, txn, total, barcode, grams) =>
  submitClaim({ wallet, scan_id: scanFor(wallet, txn, total, barcode, grams),
                items: [{ barcode }] });

const run = async () => {
  console.log('\ncap for this round: ' + weeklyCapG(round) + 'g protein per wallet, no rollover');

  console.log('\n1. normal claim — 300g of whey powder, so 225g of protein');
  console.log(await claim(W1, 'T1', 2999, '874659000168', 300));

  console.log('\n2. same receipt again — replayed, not counted twice');
  console.log(await claim(W1, 'T1', 2999, '874659000168', 300));

  console.log('\n3. same receipt, different wallet — refused, and flagged');
  console.log(await claim(W2, 'T1', 2999, '874659000168', 300));

  /* This step used to read "over the per-receipt limit", and was
     refused. There is no per-receipt limit now: one bulk tub is a real
     purchase and the cap has room for it. */
  console.log('\n4. a single bulk tub — 1500g of protein, once refused, now accepted');
  console.log(await claim(W2, 'T9', 9999, '000000000999', 1875));

  console.log('\n5. cheese, second wallet');
  console.log(await claim(W2, 'T2', 899, '032251167454', 400));

  console.log('\n6. settle 1000 B3TR');
  const r = settle(round.id, 1000);
  for (const p of r.payouts){
    console.log('  ' + p.wallet.slice(0,8) + '  ' + Math.round(p.protein) + 'g  '
      + p.points.toFixed(0).padStart(5) + ' pts  ' + p.b3tr.toFixed(2).padStart(8) + ' B3TR'
      + (p.capped ? '   (capped)' : ''));
  }
  console.log('\n  flags for review:',
    db.prepare('SELECT reason, wallet FROM review').all());
};
run();
