/* Claim cap tests.
 *
 * The rule the asserts encode: one hard cap per round, belonging to the
 * round, with nothing carrying between rounds and no separate limit on
 * a single receipt.
 *
 *   DB_PATH=/tmp/t.db node test-caps.js
 */
process.env.DB_PATH ||= './test-caps.db';

import { rmSync } from 'node:fs';
for (const suffix of ['', '-wal', '-shm']) rmSync(process.env.DB_PATH + suffix, { force: true });

const { db, now, currentRound, ensureWallet, weeklyCapG,
        WEEKLY_CAP_G, LEGACY_WEEKLY_CAP_G } = await import('./db.js');
const claims = await import('./claims.js');
const { submitClaim, createScan, weekTotals } = claims;

let failures = 0;
const ok = (name, cond) => { if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const eq = (name, got, want) =>
  ok(name + '  (' + JSON.stringify(got) + ')', JSON.stringify(got) === JSON.stringify(want));

const WALLET = '0x' + 'a'.repeat(40);
ensureWallet(WALLET);
db.prepare(`UPDATE wallet SET passport_ok=1, passport_at=?, passport_note='test' WHERE address=?`)
  .run(now(), WALLET);

/* A 2kg tub of whey: 75g protein per 100g, so 2000g of powder is 1500g
   of protein. Exactly the purchase the old 1000g per-receipt limit
   refused, and exactly the one the old 1500g weekly cap swallowed whole. */
const WHEY = '0000000000062';
db.prepare(`
  INSERT INTO product_version (barcode, version, status, name, protein_100g,
                               source_key, co2, mult, rules_hash, fetched_at)
  VALUES (?,1,'ok','Whey Protein 2kg',75,'whey',3.6,0.56,'test',?)
`).run(WHEY, now());

let n = 0;
async function claimGrams(grams){
  const round = currentRound();
  const scan = createScan({
    wallet: WALLET, roundId: round.id,
    receipt: { store:'TEST', txn:'T' + (++n), purchased: now() - 86400000,
               total_cents: 4999, image_hash:null },
    lines: [{ barcode: WHEY, matched:1, line_text:'WHEY 2KG', grams, product_version:1 }],
  });
  return submitClaim({ wallet: WALLET, scan_id: scan, items: [{ barcode: WHEY }] });
}

console.log('\n--- the cap is 3000g and belongs to the round ---');
{
  const round = currentRound();
  eq('the constant is 3000', WEEKLY_CAP_G, 3000);
  eq('and the round is stamped with it', round.weekly_cap_g, 3000);
  eq('read back through the accessor', weeklyCapG(round), 3000);
}

console.log('\n--- rollover is gone, in the code as well as the docs ---');
{
  ok('no ROLLOVER_MAX_G is exported', claims.ROLLOVER_MAX_G === undefined);
  /* It was declared and never read by anything, so the documented
     behaviour and the running behaviour disagreed. They agree now. */
}

console.log('\n--- there is no per-receipt limit ---');
{
  ok('no PER_RECEIPT_G is exported', claims.PER_RECEIPT_G === undefined);

  /* A single 2kg tub is 1500g of protein: over the old 1000g
     per-receipt limit, and well inside the new weekly cap. */
  const out = await claimGrams(2000);
  ok('a single bulk tub is accepted', out.ok);
  eq('at its full protein', out.accepted[0].protein_g, 1500);
  eq('and it counts against the week', weekTotals(WALLET, currentRound().id).protein, 1500);
}

console.log('\n--- the cap is a backstop, not a refusal ---');
{
  /* Going over does not refuse the claim. Settlement scales a wallet's
     points down proportionally instead — refusing here would truncate
     whichever claim happened to be last, and scan order must not decide
     what anyone earns. */
  const out = await claimGrams(2000);          // another 1500g, so 3000g total
  ok('a claim taking the wallet to the cap is accepted', out.ok);
  eq('the week is at the cap', out.week.protein_g, 3000);
  eq('counted equals the cap', out.week.counted_g, 3000);
  eq('and it is not over', out.week.over_cap, false);

  const over = await claimGrams(2000);         // 4500g total
  ok('and one past it is still accepted', over.ok);
  eq('the week reports the excess', over.week.protein_g, 4500);
  eq('counted stops at the cap', over.week.counted_g, 3000);
  eq('and says so', over.week.over_cap, true);
}

console.log('\n--- nothing carries into the next round ---');
{
  const spent = weekTotals(WALLET, currentRound().id).protein;
  ok('the round just used is well over the cap', spent > 3000);

  db.prepare(`UPDATE round SET state='settling' WHERE state='open'`).run();
  const next = currentRound();

  eq('the new round starts empty', weekTotals(WALLET, next.id).protein, 0);
  eq('with a full cap', weeklyCapG(next), 3000);

  const out = await claimGrams(2000);
  ok('and the first claim in it is accepted', out.ok);
  eq('room was the whole cap', out.week.room_before_g, 3000);
}

console.log('\n--- a round opened before the column keeps the cap it ran under ---');
{
  db.prepare(`UPDATE round SET state='settling' WHERE state='open'`).run();
  const legacy = db.prepare(
    `INSERT INTO round (opens_at, closes_at, claim_window_days, weekly_cap_g)
     VALUES (?,?,5,NULL)`).run(now(), now() + 7 * 86400000);
  const id = Number(legacy.lastInsertRowid);
  db.prepare(`UPDATE round SET state='open' WHERE id=?`).run(id);

  const round = currentRound();
  eq('the open round is the legacy one', round.id, id);
  eq('and it is capped where it ran', weeklyCapG(round), LEGACY_WEEKLY_CAP_G);

  const out = await claimGrams(2000);          // 1500g, exactly the old cap
  ok('accepted', out.ok);
  eq('the cap it reports is the old one', out.week.cap_g, 1500);
  eq('and it sits exactly on it', out.week.counted_g, 1500);

  const over = await claimGrams(2000);
  eq('a second tub is over that cap', over.week.over_cap, true);
  eq('counted still stops at 1500', over.week.counted_g, 1500);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
