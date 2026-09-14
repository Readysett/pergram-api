/* Scan-before-receipt tests.
 *
 * The rule the asserts encode: a barcode has to have been registered
 * before the receipt was uploaded, the requirement arrives at a round
 * boundary rather than mid-round, and nothing is auto-rejected on a
 * timing heuristic.
 *
 *   DB_PATH=/tmp/t.db node test-scan-order.js
 */
process.env.DB_PATH ||= './test-scan-order.db';

import { rmSync } from 'node:fs';
for (const suffix of ['', '-wal', '-shm']) rmSync(process.env.DB_PATH + suffix, { force: true });

const { db, now, currentRound, ensureWallet, requiresScanOrder } = await import('./db.js');
const { scanReceipt, registerScan, earliestScan, submitClaim,
        sweepScanRegistrations, SCAN_ORDER_TTL_MS,
        SCAN_ORDER_SUSPICIOUS_MS } = await import('./claims.js');

let failures = 0;
const ok = (name, cond) => { if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const eq = (name, got, want) =>
  ok(name + '  (' + JSON.stringify(got) + ')', JSON.stringify(got) === JSON.stringify(want));

const WALLET = '0x' + 'a'.repeat(40);
ensureWallet(WALLET);
db.prepare(`UPDATE wallet SET passport_ok=1, passport_at=?, passport_note='test' WHERE address=?`)
  .run(now(), WALLET);

const TUNA = '0000000000024';
const BEEF = '0000000000017';
for (const [bc, name, p, src, co2, mult] of [
  [TUNA, 'Chunk Light Tuna', 25, 'fish', 6.1, 0.33],
  [BEEF, 'Ground Beef',      26, 'beef', 50,  0.04],
]){
  db.prepare(`
    INSERT INTO product_version (barcode, version, status, name, protein_100g,
                                 source_key, co2, mult, rules_hash, fetched_at)
    VALUES (?,1,'ok',?,?,?,?,?,'test',?)
  `).run(bc, name, p, src, co2, mult, now());
}

const parsed = {
  store:'TEST MART', txn:'T-BASE', purchased: now() - 86400000, total_cents: 1200,
  /* Three lines, not two. Matching requires a word that is rare across
     the receipt's own lines (GENERIC_SHARE = 0.34), and on a two-line
     receipt every word appears on half of them, so nothing is ever
     distinctive and nothing matches. That is the matcher working as
     designed — a fixture short enough to defeat it is not a receipt. */
  lines: [{ text:'CHUNK LIGHT TUNA 142G', qty:1 },
          { text:'GROUND BEEF 500G', qty:1 },
          { text:'BANANAS 1.2 LB', qty:1 }],
};
const read = (over = {}) => scanReceipt({
  wallet: WALLET, roundId: currentRound().id, image_hash:'h',
  parsed: { ...parsed, txn: 'T' + Math.random().toString(36).slice(2) },
  barcodes: [TUNA], ...over,
});

/* Register a scan at a chosen point in the past, so a test can describe
   a shopping trip without waiting for one. */
function registerAt(barcode, msAgo){
  registerScan(WALLET, barcode);
  db.prepare(`UPDATE product_scan SET scanned_at=? WHERE id=(SELECT MAX(id) FROM product_scan)`)
    .run(now() - msAgo);
}

console.log('\n--- registering a scan ---');
{
  const at = registerScan(WALLET, TUNA);
  ok('returns when it happened', typeof at === 'number');
  ok('and it is readable back', earliestScan(WALLET, TUNA, now() + 1) !== null);
  eq('a non-barcode registers nothing', registerScan(WALLET, 'not-a-barcode'), null);
  eq('and another wallet sees nothing',
     earliestScan('0x' + 'b'.repeat(40), TUNA, now() + 1), null);
}

console.log('\n--- the earliest registration is the one that counts ---');
{
  db.prepare(`DELETE FROM product_scan`).run();
  registerAt(TUNA, 60_000);
  const first = earliestScan(WALLET, TUNA, now() + 1);
  registerScan(WALLET, TUNA);                       // re-scanned just now
  eq('a re-scan cannot move it later', earliestScan(WALLET, TUNA, now() + 1), first);
}

console.log('\n--- a stale registration stops counting ---');
{
  db.prepare(`DELETE FROM product_scan`).run();
  registerAt(TUNA, SCAN_ORDER_TTL_MS + 60_000);
  eq('past the window it is not usable', earliestScan(WALLET, TUNA, now()), null);
  sweepScanRegistrations();
  eq('and it is swept', db.prepare(`SELECT COUNT(*) n FROM product_scan`).get().n, 0);
}

console.log('\n--- a round that does not require it refuses nothing ---');
{
  db.prepare(`DELETE FROM product_scan`).run();
  const round = currentRound();
  ok('this round does not require it', !requiresScanOrder(round));

  const out = await read();
  eq('the barcode is read normally', out.matches[0].status, 'ok');
  ok('and it matched its line', out.matches[0].matched);
  eq('the report says enforcement is off', out.scan_order.enforced, false);
  eq('while still naming what was unregistered', out.scan_order.not_scanned_first, [TUNA]);
}

console.log('\n--- a round that requires it refuses a barcode scanned after ---');
{
  db.prepare(`UPDATE round SET state='settling' WHERE state='open'`).run();
  const r = db.prepare(
    `INSERT INTO round (opens_at, closes_at, claim_window_days, require_scan_order)
     VALUES (?,?,5,1)`).run(now(), now() + 7 * 86400000);
  db.prepare(`UPDATE round SET state='open' WHERE id=?`).run(Number(r.lastInsertRowid));

  const round = currentRound();
  ok('the new round requires it', requiresScanOrder(round));

  db.prepare(`DELETE FROM product_scan`).run();
  const out = await read();
  eq('refused', out.matches[0].status, 'not_scanned_first');
  ok('and not matched', !out.matches[0].matched);
  eq('the report says why', out.scan_order.not_scanned_first, [TUNA]);

  /* No product lookup for something already refused — the Open Food
     Facts call is the expensive part of reading a receipt. */
  ok('and nothing was looked up for it', out.matches[0].name === null);
}

console.log('\n--- registered first, and it goes through ---');
{
  db.prepare(`DELETE FROM product_scan`).run();
  registerAt(TUNA, 5 * 60_000);
  const out = await read();
  eq('accepted', out.matches[0].status, 'ok');
  ok('matched its line', out.matches[0].matched);
  eq('quantity still from the line', out.matches[0].grams, 142);
  eq('nothing outstanding', out.scan_order.not_scanned_first, []);
}

console.log('\n--- one registered, one not ---');
{
  db.prepare(`DELETE FROM product_scan`).run();
  registerAt(TUNA, 5 * 60_000);
  const out = await read({ barcodes: [TUNA, BEEF] });
  const byCode = Object.fromEntries(out.matches.map(m => [m.barcode, m.status]));
  eq('the registered one is read', byCode[TUNA], 'ok');
  eq('the other is refused',       byCode[BEEF], 'not_scanned_first');
  eq('and only it is named',       out.scan_order.not_scanned_first, [BEEF]);
}

console.log('\n--- a refused barcode cannot then be claimed ---');
{
  db.prepare(`DELETE FROM product_scan`).run();
  const out = await read({ barcodes: [TUNA] });
  eq('refused at the read', out.matches[0].status, 'not_scanned_first');

  const claim = await submitClaim({ wallet: WALLET, scan_id: out.scan_id,
                                    items: [{ barcode: TUNA }] });
  ok('and refused at the claim', !claim.ok);
  ok('with nothing written',
     !db.prepare(`SELECT 1 FROM claim WHERE barcode=?`).get(TUNA));
}

console.log('\n--- hurried registration is flagged, never rejected ---');
{
  db.prepare(`DELETE FROM product_scan`).run();
  db.prepare(`DELETE FROM review`).run();

  /* Registered and uploaded in the same breath: what a modified client
     doing both in one script looks like. */
  registerAt(TUNA, Math.floor(SCAN_ORDER_SUSPICIOUS_MS / 3));
  const out = await read();

  eq('still accepted — a person can be quick', out.matches[0].status, 'ok');
  const flags = db.prepare(`SELECT * FROM review WHERE reason='scan-order-hurried'`).all();
  eq('but flagged for review', flags.length, 1);
  ok('naming the barcode', flags[0].detail.includes(TUNA));
}
{
  db.prepare(`DELETE FROM product_scan`).run();
  db.prepare(`DELETE FROM review`).run();
  registerAt(TUNA, 10 * 60_000);
  await read();
  eq('an unhurried one is not flagged',
     db.prepare(`SELECT COUNT(*) n FROM review WHERE reason='scan-order-hurried'`).get().n, 0);
}

console.log('\n--- a registration made after the upload does not count ---');
{
  db.prepare(`DELETE FROM product_scan`).run();
  const uploadedAt = now();
  registerScan(WALLET, TUNA);                       // i.e. after the upload began
  const out = await scanReceipt({
    wallet: WALLET, roundId: currentRound().id, image_hash:'h',
    parsed: { ...parsed, txn: 'T-AFTER' },
    barcodes: [TUNA],
    uploadedAt: uploadedAt - 1000,
  });
  eq('refused', out.matches[0].status, 'not_scanned_first');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
