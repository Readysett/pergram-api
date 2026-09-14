/* Audit log tests.
 *
 * The rule the asserts encode: every state a claim or a round passes
 * through is recorded, the record commits with the thing it describes,
 * and it cannot be quietly altered afterwards.
 *
 *   DB_PATH=/tmp/t.db node test-audit.js
 */
process.env.DB_PATH ||= './test-audit.db';

import { rmSync } from 'node:fs';
for (const suffix of ['', '-wal', '-shm']) rmSync(process.env.DB_PATH + suffix, { force: true });

const { db, now, currentRound, ensureWallet } = await import('./db.js');
const { submitClaim, createScan } = await import('./claims.js');
const { settle } = await import('./settle.js');
const { record, verifyChain, historyOfClaim, historyOfRound,
        historyOfWallet, GENESIS } = await import('./audit.js');

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

const round = currentRound();

console.log('\n--- a round opening is the first entry in its own history ---');
{
  const h = historyOfRound(round.id);
  eq('one entry so far', h.length, 1);
  eq('and it is the opening', [h[0].subject, h[0].event, h[0].to_state],
     ['round', 'opened', 'open']);
  eq('recording the window it will be claimed under',
     JSON.parse(h[0].detail).claim_window_days, round.claim_window_days);
  eq('the chain starts at genesis', h[0].prev_hash, GENESIS);
}

console.log('\n--- a claim records the figures that decided it ---');
{
  const scan = createScan({
    wallet: WALLET, roundId: round.id,
    receipt: { store:'TEST', txn:'TXN-A1', purchased: now() - 86400000,
               total_cents: 500, image_hash:null },
    lines: [{ barcode:'0000000000024', matched:1, line_text:'TUNA', grams:142,
              product_version:1 }],
  });
  const out = await submitClaim({ wallet: WALLET, scan_id: scan,
                                  items: [{ barcode:'0000000000024' }] });
  ok('claim accepted', out.ok);

  const claim = db.prepare(`SELECT * FROM claim WHERE barcode='0000000000024'`).get();
  const h = historyOfClaim(claim.id);
  eq('one entry', h.length, 1);
  eq('created, into verified', [h[0].event, h[0].from_state, h[0].to_state],
     ['created', null, 'verified']);

  const d = JSON.parse(h[0].detail);
  eq('with every figure that set the reward',
     [d.protein_g, d.mult, d.points, d.source_key, d.product_version],
     [claim.protein_g, claim.mult, claim.points, 'fish', 1]);

  /* The point of recording the version: the claim can be recomputed from
     the cache row rather than taken on trust from the claim row. */
  const pv = db.prepare(`SELECT * FROM product_version WHERE barcode=? AND version=?`)
               .get('0000000000024', d.product_version);
  eq('and the claim recomputes from it', +(142 * pv.protein_100g / 100).toFixed(3), d.protein_g);

  eq('the wallet can be traced', historyOfWallet(WALLET).length, 1);
}

console.log('\n--- a refused claim leaves no entry ---');
{
  const before = verifyChain().checked;
  const scan = createScan({
    wallet: WALLET, roundId: round.id,
    receipt: { store:'TEST', txn:'TXN-A2', purchased: now() - 86400000,
               total_cents: 500, image_hash:null },
    lines: [{ barcode:'0000000000024', matched:0, line_text:null, grams:null }],
  });
  const out = await submitClaim({ wallet: WALLET, scan_id: scan,
                                  items: [{ barcode:'0000000000024' }] });
  ok('refused', !out.ok);
  eq('and nothing was logged', verifyChain().checked, before);
}

console.log('\n--- a rolled-back write leaves no entry either ---');
{
  /* The entry and the fact commit together or not at all. An entry for a
     claim that rolled back would be a lie. */
  const before = verifyChain().checked;
  db.exec('BEGIN IMMEDIATE');
  record({ subject:'claim', subject_id:'999', event:'created',
           to_state:'verified', actor:'test' });
  eq('written inside the transaction', verifyChain().checked, before + 1);
  db.exec('ROLLBACK');
  eq('and gone with it', verifyChain().checked, before);
}

console.log('\n--- settlement records the round, each claim and each payout ---');
{
  const r = settle(round.id, 1000);
  ok('settled', r.payouts.length === 1);

  const claim = db.prepare(`SELECT * FROM claim WHERE barcode='0000000000024'`).get();
  const ch = historyOfClaim(claim.id);
  eq('the claim now has two entries', ch.length, 2);
  eq('the second is the settlement', [ch[1].event, ch[1].from_state, ch[1].to_state],
     ['settled', 'verified', 'settled']);

  const rh = historyOfRound(round.id);
  const settled = rh.find(e => e.subject === 'round' && e.event === 'settled');
  ok('the round records its settlement', !!settled);
  const d = JSON.parse(settled.detail);
  eq('with the rate and what it divided',
     [d.pool_b3tr, d.rate_b3tr_per_point, d.claims_settled],
     [1000, r.rate_b3tr_per_point, 1]);

  const pay = rh.find(e => e.subject === 'payout');
  ok('and each payout is recorded', !!pay);
  eq('with what that wallet is owed', JSON.parse(pay.detail).b3tr, r.payouts[0].b3tr);

  /* A settled round reads back from the log alone, without rerunning
     anything and without trusting the claim rows. */
  eq('claim state agrees with its last entry', claim.state, ch[ch.length - 1].to_state);
}

console.log('\n--- the log cannot be edited ---');
{
  let threw = null;
  try { db.prepare(`UPDATE audit SET detail='{}' WHERE id=1`).run(); }
  catch (e){ threw = e; }
  ok('UPDATE is refused', !!threw && /append-only/.test(threw.message));

  threw = null;
  try { db.prepare(`DELETE FROM audit WHERE id=1`).run(); }
  catch (e){ threw = e; }
  ok('DELETE is refused', !!threw && /append-only/.test(threw.message));

  eq('and the chain is intact', verifyChain().ok, true);
}

console.log('\n--- tampering past the triggers is still detectable ---');
{
  /* Someone with a SQLite prompt can drop a trigger. The chain is what
     survives that: it is recomputed from content, so an altered row
     fails its own hash and a removed one orphans its successor. */
  const before = verifyChain();
  ok('intact to begin with', before.ok);

  db.exec('DROP TRIGGER audit_no_update');
  db.prepare(`UPDATE audit SET detail='{"protein_g":9999}' WHERE id=2`).run();

  const after = verifyChain();
  ok('the edit is caught', !after.ok);
  eq('at the row that was changed', after.broken_at, 2);
  ok('and says the content changed', /content was changed/.test(after.why));

  db.exec(`CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
           BEGIN SELECT RAISE(ABORT, 'audit is append-only: entries cannot be changed'); END`);
}

console.log('\n--- a removed row orphans its successor ---');
{
  db.exec('DROP TRIGGER audit_no_delete');
  /* Undo the edit above so the only fault left is the deletion. */
  db.exec('DROP TRIGGER audit_no_update');
  const row2 = db.prepare(`SELECT * FROM audit WHERE id=2`).get();
  db.prepare(`DELETE FROM audit WHERE id=2`).run();

  const v = verifyChain();
  ok('the gap is caught', !v.ok);
  eq('at the row that followed it', v.broken_at, 3);
  ok('and says a row is missing', /removed or reordered/.test(v.why));
  ok('the deleted row is genuinely gone', !db.prepare(`SELECT 1 FROM audit WHERE id=2`).get()
     && !!row2);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
