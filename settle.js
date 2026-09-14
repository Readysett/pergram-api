import { db, now, currentRound } from './db.js';
import { WEEKLY_CAP_G } from './claims.js';

/* Round settlement.
 *
 * The rate is pool / total points, computed at close. Never a fixed
 * B3TR per gram: the pool varies every round with the allocation vote,
 * so a fixed rate makes a growth week insolvent.
 *
 *   node settle.js <roundId> <poolB3TR>
 */

export function settle(roundId, poolB3tr){
  const round = db.prepare(`SELECT * FROM round WHERE id=?`).get(roundId);
  if (!round) throw new Error('no such round');
  if (round.state === 'paid') throw new Error('round already paid');

  /* Settling twice would find no verified claims the second time — they
     are settled by then — compute a rate of zero over an empty set, and
     overwrite the pool with it. The first run's record is the one that
     is true, so refuse rather than replace it. */
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM payout WHERE round_id=?`).get(roundId);
  if (existing.n > 0){
    throw new Error(`round ${roundId} is already settled — ${existing.n} payout(s) recorded. ` +
                    `Read them with: node settle.js --show ${roundId}`);
  }

  const wallets = db.prepare(`
    SELECT wallet, SUM(protein_g) AS protein, SUM(points) AS points
    FROM claim WHERE round_id=? AND state='verified'
    GROUP BY wallet
  `).all(roundId);

  /* The cap scales a wallet's points proportionally rather than
     truncating whichever claim happened to be last. Scan order must not
     change what anyone earns. */
  let total = 0;
  const scaled = wallets.map(w => {
    const scale = w.protein > WEEKLY_CAP_G ? WEEKLY_CAP_G / w.protein : 1;
    const pts = w.points * scale;
    total += pts;
    return { wallet: w.wallet, protein: w.protein, points: pts, capped: scale < 1 };
  });

  const rate = total > 0 ? poolB3tr / total : 0;
  const payouts = scaled.map(s => ({ ...s, b3tr: s.points * rate }));

  /* One transaction. A state where claims read 'settled' and no payout
     explains them is exactly the gap this closes, so it must not be
     reachable through a crash between two writes either. */
  const insert = db.prepare(`
    INSERT INTO payout (round_id, wallet, protein_g, points, capped, b3tr, created_at)
    VALUES (?,?,?,?,?,?,?)
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE round SET pool_b3tr=?, total_points=?, rate_b3tr_per_point=?,
                                 settled_at=?, state='settling' WHERE id=?`)
      .run(poolB3tr, total, rate, now(), roundId);
    db.prepare(`UPDATE claim SET state='settled' WHERE round_id=? AND state='verified'`).run(roundId);
    for (const p of payouts){
      insert.run(roundId, p.wallet, p.protein, p.points, p.capped ? 1 : 0, p.b3tr, now());
    }
    db.exec('COMMIT');
  } catch (e){
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    round: roundId,
    pool_b3tr: poolB3tr,
    total_points: total,
    rate_b3tr_per_point: rate,
    payouts,
  };
}

/* Read back a settled round. The point of writing payouts down is being
   able to answer "what did this round pay, and why" without rerunning
   anything — least of all the settlement itself. */
export function payoutsFor(roundId){
  const round = db.prepare(`SELECT * FROM round WHERE id=?`).get(roundId);
  if (!round) throw new Error('no such round');
  return {
    round: roundId,
    pool_b3tr: round.pool_b3tr,
    total_points: round.total_points,
    rate_b3tr_per_point: round.rate_b3tr_per_point,
    settled_at: round.settled_at,
    state: round.state,
    payouts: db.prepare(`
      SELECT wallet, protein_g AS protein, points, capped, b3tr
      FROM payout WHERE round_id=? ORDER BY b3tr DESC, wallet
    `).all(roundId).map(p => ({ ...p, capped: !!p.capped })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`){
  const args = process.argv.slice(2);

  /* Reading a settled round must never be a rerun of settlement. */
  if (args[0] === '--show'){
    const r = payoutsFor(Number(args[1] || currentRound().id));
    console.log(`\nRound ${r.round} — ${r.state}, pool ${r.pool_b3tr} B3TR over ` +
                `${(r.total_points || 0).toFixed(0)} points`);
    console.log(`rate ${(r.rate_b3tr_per_point || 0).toFixed(6)} B3TR per point` +
                (r.settled_at ? `, settled ${new Date(r.settled_at).toISOString()}` : '') + '\n');
    for (const p of r.payouts){
      console.log(p.wallet.slice(0,10) + '…  ' + Math.round(p.protein) + 'g  '
        + p.points.toFixed(0).padStart(6) + ' pts  '
        + p.b3tr.toFixed(4).padStart(10) + ' B3TR' + (p.capped ? '   (capped)' : ''));
    }
    if (!r.payouts.length) console.log('(no payouts recorded for this round)');
    process.exit(0);
  }

  const id   = Number(args[0] || currentRound().id);
  const pool = Number(args[1] || 0);
  if (!pool){
    console.error('usage: node settle.js <roundId> <poolB3TR>');
    console.error('       node settle.js --show <roundId>');
    process.exit(1);
  }
  let r;
  try {
    r = settle(id, pool);
  } catch (e){
    /* Refusing to re-settle is an expected outcome, not a crash. A stack
       trace here reads as a bug in the tool and buries the one line that
       says what to do instead. */
    console.error('\n' + e.message + '\n');
    process.exit(1);
  }
  console.log(`\nRound ${r.round} — pool ${r.pool_b3tr} B3TR over ${r.total_points.toFixed(0)} points`);
  console.log(`rate ${r.rate_b3tr_per_point.toFixed(6)} B3TR per point\n`);
  for (const p of r.payouts){
    console.log(p.wallet.slice(0,10) + '…  ' + Math.round(p.protein) + 'g  '
      + p.points.toFixed(0).padStart(6) + ' pts  '
      + p.b3tr.toFixed(4).padStart(10) + ' B3TR' + (p.capped ? '   (capped)' : ''));
  }
  console.log('\nRecorded. Read it back at any time with: node settle.js --show ' + r.round);
  console.log('Distribution to the X2EarnRewardsPool is a separate, deliberate step.');
}
