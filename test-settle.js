/* Settlement tests.
 *
 * The rule the asserts encode: a round that has been settled can be
 * reconstructed from the database afterwards, and nothing can quietly
 * replace that record.
 *
 *   DB_PATH=/tmp/t.db node test-settle.js
 */
process.env.DB_PATH ||= './test-settle.db';

import { rmSync } from 'node:fs';
rmSync(process.env.DB_PATH, { force: true });
rmSync(process.env.DB_PATH + '-wal', { force: true });
rmSync(process.env.DB_PATH + '-shm', { force: true });

const { db, now, currentRound, ensureWallet } = await import('./db.js');
const { settle, payoutsFor } = await import('./settle.js');
const { weeklyCapG } = await import('./db.js');

let failures = 0;
const ok = (name, cond) => { if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const eq = (name, got, want) =>
  ok(name + '  (' + JSON.stringify(got) + ')', JSON.stringify(got) === JSON.stringify(want));
const near = (name, got, want) =>
  ok(name + '  (' + got + ')', Math.abs(got - want) < 1e-6);

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const round = currentRound();
const CAP = weeklyCapG(round);

function claim(wallet, barcode, protein, mult){
  ensureWallet(wallet);
  const key = 'k-' + wallet.slice(2,6) + '-' + barcode;
  db.prepare(`INSERT OR IGNORE INTO receipt (key, wallet, purchased, created_at)
              VALUES (?,?,?,?)`).run(key, wallet, now(), now());
  db.prepare(`
    INSERT INTO claim (wallet, round_id, receipt_key, barcode, product, source_key,
                       protein_g, co2_kg, mult, points, state, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'verified', ?)
  `).run(wallet, round.id, key, barcode, 'P'+barcode, 'whey',
         protein, protein/100*3.6, mult, protein*mult, now());
}

/* A is under the cap. B is well over it, so its points scale down. */
claim(A, '111', 200, 0.56);                 // 112 points
claim(B, '222', CAP, 0.56);                 // at the cap exactly
claim(B, '333', 500, 1.00);                 // pushes B over

console.log('\n--- settling records what it paid ---');
const r = settle(round.id, 1000);

eq('two wallets paid', r.payouts.length, 2);

const stored = payoutsFor(round.id);
eq('the rate was written down',   stored.rate_b3tr_per_point, r.rate_b3tr_per_point);
eq('and the pool beside it',      stored.pool_b3tr, 1000);
eq('and the total it divided by', stored.total_points, r.total_points);
ok('and when',                    stored.settled_at > 0);

/* The whole point: the split survives the process that computed it. */
eq('the stored split matches what settle returned',
   stored.payouts.map(p => [p.wallet, +p.b3tr.toFixed(9)]).sort(),
   r.payouts.map(p => [p.wallet, +p.b3tr.toFixed(9)]).sort());

near('the pool is fully distributed',
     stored.payouts.reduce((s, p) => s + p.b3tr, 0), 1000);

const bRow = stored.payouts.find(p => p.wallet === B);
ok('the capped wallet is marked as capped', bRow.capped === true);
const aRow = stored.payouts.find(p => p.wallet === A);
ok('the uncapped one is not',               aRow.capped === false);

/* Cap scaling is proportional, so B's points are its raw points times
   the cap over its protein — not truncated to whichever claim was last. */
const bProtein = CAP + 500;
const bRaw     = CAP * 0.56 + 500 * 1.00;
near('capped points scale proportionally', bRow.points, bRaw * (CAP / bProtein));
eq('and the protein recorded is what was claimed, before scaling', bRow.protein, bProtein);

console.log('\n--- claims and payouts move together ---');
eq('every claim is settled',
   db.prepare(`SELECT COUNT(*) AS n FROM claim WHERE round_id=? AND state='verified'`).get(round.id).n, 0);
eq('and the round says so', db.prepare(`SELECT state FROM round WHERE id=?`).get(round.id).state, 'settling');

console.log('\n--- a settled round cannot be quietly re-settled ---');
{
  /* Running it again would find no verified claims, divide by nothing,
     and overwrite the pool with a rate of zero. */
  let threw = null;
  try { settle(round.id, 9999); } catch (e){ threw = e; }
  ok('refused', !!threw);
  ok('and said where to read the real one', /--show/.test(threw.message));

  const after = payoutsFor(round.id);
  eq('the pool is untouched', after.pool_b3tr, 1000);
  eq('the rate is untouched', after.rate_b3tr_per_point, stored.rate_b3tr_per_point);
  eq('and the split is untouched',
     after.payouts.map(p => +p.b3tr.toFixed(9)), stored.payouts.map(p => +p.b3tr.toFixed(9)));
}

console.log('\n--- a round settles under the cap it was opened with ---');
{
  /* Not the current constant: a round already part-claimed must not be
     re-capped by a later raise. */
  const old = db.prepare(`INSERT INTO round (opens_at, closes_at, weekly_cap_g)
                          VALUES (?,?,1500)`).run(now(), now() + 1);
  const id = Number(old.lastInsertRowid);
  eq('the round carries its own cap', weeklyCapG(
     db.prepare(`SELECT * FROM round WHERE id=?`).get(id)), 1500);

  ensureWallet(A);
  db.prepare(`INSERT OR IGNORE INTO receipt (key, wallet, purchased, created_at)
              VALUES ('oldk',?,?,?)`).run(A, now(), now());
  db.prepare(`
    INSERT INTO claim (wallet, round_id, receipt_key, barcode, product, source_key,
                       protein_g, co2_kg, mult, points, state, created_at)
    VALUES (?,?,'oldk','888','P','whey',3000,108,1.0,3000,'verified',?)
  `).run(A, id, now());

  const r = settle(id, 100);
  /* 3000g against a 1500g cap scales points by a half. */
  near('scaled against 1500, not 3000', r.payouts[0].points, 1500);
  eq('and the cap is recorded in the log',
     JSON.parse(db.prepare(
       `SELECT detail FROM audit WHERE round_id=? AND subject='round' AND event='settled'`
     ).get(id).detail).weekly_cap_g, 1500);
}

console.log('\n--- a round with nothing in it settles to nothing, not a crash ---');
{
  const empty = db.prepare(`INSERT INTO round (opens_at, closes_at) VALUES (?,?)`).run(now(), now()+1);
  const id = Number(empty.lastInsertRowid);
  const e = settle(id, 500);
  eq('no payouts', e.payouts.length, 0);
  eq('and a rate of zero rather than a division by it', e.rate_b3tr_per_point, 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
