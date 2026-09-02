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

  db.prepare(`UPDATE round SET pool_b3tr=?, state='settling' WHERE id=?`).run(poolB3tr, roundId);
  db.prepare(`UPDATE claim SET state='settled' WHERE round_id=? AND state='verified'`).run(roundId);

  return {
    round: roundId,
    pool_b3tr: poolB3tr,
    total_points: total,
    rate_b3tr_per_point: rate,
    payouts: scaled.map(s => ({ ...s, b3tr: s.points * rate })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`){
  const id   = Number(process.argv[2] || currentRound().id);
  const pool = Number(process.argv[3] || 0);
  if (!pool){ console.error('usage: node settle.js <roundId> <poolB3TR>'); process.exit(1); }
  const r = settle(id, pool);
  console.log(`\nRound ${r.round} — pool ${r.pool_b3tr} B3TR over ${r.total_points.toFixed(0)} points`);
  console.log(`rate ${r.rate_b3tr_per_point.toFixed(6)} B3TR per point\n`);
  for (const p of r.payouts){
    console.log(p.wallet.slice(0,10) + '…  ' + Math.round(p.protein) + 'g  '
      + p.points.toFixed(0).padStart(6) + ' pts  '
      + p.b3tr.toFixed(4).padStart(10) + ' B3TR' + (p.capped ? '   (capped)' : ''));
  }
  console.log('\nDistribution to the X2EarnRewardsPool is a separate, deliberate step.');
}
