/* Smoke test with fake data — no chain, no receipts, no network.
   Proves the cap, the duplicate rejection and settlement all behave. */
import { db } from './db.js';
import { submitClaim, receiptKey } from './claims.js';
import { settle } from './settle.js';

const W1 = '0x' + '11'.repeat(20);
const W2 = '0x' + '22'.repeat(20);

// Skip the live passport call in the smoke test.
db.exec(`INSERT OR REPLACE INTO wallet (address, created_at, passport_ok, passport_at, passport_note)
         VALUES ('${W1}', ${Date.now() - 86400000 * 30}, 1, ${Date.now()}, 'seeded'),
                ('${W2}', ${Date.now() - 86400000 * 30}, 1, ${Date.now()}, 'seeded')`);

const rcpt = (txn, total) => ({ store:'store-1', txn, purchased: Date.now() - 3600000, total_cents: total });

const run = async () => {
  console.log('\n1. normal claim');
  console.log(await submitClaim({ wallet: W1, receipt: rcpt('T1', 2999), items: [
    { barcode:'874659000168', product:'Whey Isolate', source_key:'whey', protein_g:230, co2:3.6, mult:0.56 },
  ]}));

  console.log('\n2. same receipt again — must be refused');
  console.log(await submitClaim({ wallet: W1, receipt: rcpt('T1', 2999), items: [
    { barcode:'874659000168', product:'Whey Isolate', source_key:'whey', protein_g:230, co2:3.6, mult:0.56 },
  ]}));

  console.log('\n3. same receipt, different wallet — refused, and flagged');
  console.log(await submitClaim({ wallet: W2, receipt: rcpt('T1', 2999), items: [
    { barcode:'874659000168', product:'Whey Isolate', source_key:'whey', protein_g:230, co2:3.6, mult:0.56 },
  ]}));

  console.log('\n4. over the per-receipt limit');
  console.log(await submitClaim({ wallet: W2, receipt: rcpt('T9', 9999), items: [
    { barcode:'999', product:'Bulk', source_key:'pea', protein_g:1200, co2:0.4, mult:1.0 },
  ]}));

  console.log('\n5. cheese, second wallet');
  console.log(await submitClaim({ wallet: W2, receipt: rcpt('T2', 899), items: [
    { barcode:'032251167454', product:'Cheddar', source_key:'cheese', protein_g:430, co2:21, mult:0.10 },
  ]}));

  console.log('\n6. settle 1000 B3TR');
  const r = settle(1, 1000);
  for (const p of r.payouts){
    console.log('  ' + p.wallet.slice(0,8) + '  ' + Math.round(p.protein) + 'g  '
      + p.points.toFixed(0).padStart(5) + ' pts  ' + p.b3tr.toFixed(2).padStart(8) + ' B3TR');
  }
  console.log('\n  flags for review:',
    db.prepare('SELECT reason, wallet FROM review').all());
};
run();
