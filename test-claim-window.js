/* Claim window tests.
 *
 * The rule the asserts encode: the window is a property of the round a
 * claim lands in, so tightening it takes effect at a boundary and never
 * voids a receipt that was claimable the same morning.
 *
 *   DB_PATH=/tmp/t.db node test-claim-window.js
 */
process.env.DB_PATH ||= './test-claim-window.db';
process.env.CLAIM_WINDOW_DAYS ||= '5';

import { rmSync } from 'node:fs';
for (const suffix of ['', '-wal', '-shm']) rmSync(process.env.DB_PATH + suffix, { force: true });

const { db, now, currentRound, ensureWallet, claimWindowDays,
        CLAIM_WINDOW_DAYS, LEGACY_CLAIM_WINDOW_DAYS } = await import('./db.js');
const { submitClaim, createScan } = await import('./claims.js');

let failures = 0;
const ok = (name, cond) => { if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const eq = (name, got, want) =>
  ok(name + '  (' + JSON.stringify(got) + ')', JSON.stringify(got) === JSON.stringify(want));

const WALLET = '0x' + 'a'.repeat(40);
ensureWallet(WALLET);
db.prepare(`UPDATE wallet SET passport_ok=1, passport_at=?, passport_note='test' WHERE address=?`)
  .run(now(), WALLET);

db.prepare(`
  INSERT INTO product_version (barcode, version, status, name, protein_100g,
                               source_key, co2, mult, rules_hash, fetched_at)
  VALUES ('0000000000024',1,'ok','Chunk Light Tuna',25,'fish',6.1,0.33,'test',?)
`).run(now());

const DAY = 86400000;

/* Claim one receipt of a given age against the currently open round. */
async function claimAged(days){
  const round = currentRound();
  const scan = createScan({
    wallet: WALLET, roundId: round.id,
    receipt: { store:'TEST', txn:'T' + Math.random().toString(36).slice(2),
               purchased: now() - days * DAY, total_cents: 500, image_hash:null },
    lines: [{ barcode:'0000000000024', matched:1, line_text:'TUNA', grams:142 }],
  });
  return submitClaim({ wallet: WALLET, scan_id: scan, items: [{ barcode:'0000000000024' }] });
}

console.log('\n--- a fresh round carries the new window ---');
{
  const round = currentRound();
  eq('stamped at creation', round.claim_window_days, CLAIM_WINDOW_DAYS);
  eq('and read back as such', claimWindowDays(round), 5);

  const inside = await claimAged(4);
  ok('a four-day-old receipt is claimable', inside.ok);

  const outside = await claimAged(6);
  ok('a six-day-old one is not', !outside.ok);
  ok('and says how old is too old', /older than 5 days/.test(outside.error));
}

console.log('\n--- a round opened before the change keeps its own window ---');
{
  /* The production round at deploy time: the column did not exist when
     it opened, so it reads NULL. Tightening it now would void receipts
     people could have claimed that morning. */
  db.prepare(`UPDATE round SET state='settling' WHERE state='open'`).run();
  const legacy = db.prepare(
    `INSERT INTO round (opens_at, closes_at, claim_window_days) VALUES (?,?,NULL)`
  ).run(now() - 3 * DAY, now() + 4 * DAY);
  const id = Number(legacy.lastInsertRowid);
  db.prepare(`UPDATE round SET state='open' WHERE id=?`).run(id);

  const round = currentRound();
  eq('the open round is the legacy one', round.id, id);
  eq('its window is the one it ran under', claimWindowDays(round), LEGACY_CLAIM_WINDOW_DAYS);

  const old = await claimAged(20);
  ok('a twenty-day-old receipt is still claimable in it', old.ok);

  const tooOld = await claimAged(31);
  ok('but thirty-one days is not', !tooOld.ok);
  ok('and it names thirty, not five', /older than 30 days/.test(tooOld.error));
}

console.log('\n--- the change arrives when the next round opens ---');
{
  db.prepare(`UPDATE round SET state='settling' WHERE state='open'`).run();
  const next = currentRound();
  eq('the new round is stamped with the new window', next.claim_window_days, 5);

  const old = await claimAged(20);
  ok('and now a twenty-day-old receipt is refused', !old.ok);
  ok('naming the new window', /older than 5 days/.test(old.error));
}

console.log('\n--- a receipt dated in the future is still refused ---');
{
  const ahead = await claimAged(-3);
  ok('refused', !ahead.ok);
  ok('as a future date, not an age', /future/.test(ahead.error));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
