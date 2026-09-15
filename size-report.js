#!/usr/bin/env node
/* How often a matched receipt line has no size anywhere.
 *
 * The question this answers: is it worth building a way for users to
 * supply a missing pack size? That decision should rest on a rate from
 * real receipts, not on the one receipt that happened to surface the
 * case — the first was from a truck stop, where lines are terse and
 * Open Food Facts coverage is thin, and supermarket receipts look
 * nothing like it. Hence the per-store breakdown: an average across both
 * would hide exactly the difference that matters.
 *
 *   node size-report.js           # the last 7 days
 *   node size-report.js 30        # the last 30 days
 */
import { db, now } from './db.js';

const days = Number(process.argv[2] || 7);
const since = now() - days * 86400000;

const total = db.prepare(`
  SELECT COUNT(*) AS n,
         SUM(outcome = 'size_unknown') AS unknown
  FROM quantity_outcome WHERE at >= ?
`).get(since);

if (!total.n){
  console.log(`\nNo matched lines recorded in the last ${days} day(s).`);
  console.log('Nothing to decide on yet — leave it running.\n');
  process.exit(0);
}

const pct = n => (100 * n / total.n).toFixed(1) + '%';
console.log(`\nMatched receipt lines, last ${days} day(s): ${total.n}`);
console.log(`  no size anywhere: ${total.unknown}  (${pct(total.unknown)})\n`);

const byStore = db.prepare(`
  SELECT COALESCE(store, '(store not read)') AS store,
         COUNT(*) AS n,
         SUM(outcome = 'size_unknown') AS unknown
  FROM quantity_outcome WHERE at >= ?
  GROUP BY store ORDER BY n DESC LIMIT 20
`).all(since);

console.log('by store');
for (const r of byStore){
  const share = (100 * r.unknown / r.n).toFixed(0) + '%';
  console.log('  ' + String(r.store).slice(0, 28).padEnd(30)
    + String(r.n).padStart(5) + ' lines   ' + String(r.unknown).padStart(5)
    + ' unsized   ' + share.padStart(4));
}

/* Which side of the lookup is missing tells you what would fix it: a
   record with no quantity is one edit in Open Food Facts, whereas a
   receipt that prints no size at all is not fixable from here. */
const why = db.prepare(`
  SELECT SUM(had_record_size = 0) AS no_record, COUNT(*) AS n
  FROM quantity_outcome WHERE at >= ? AND outcome = 'size_unknown'
`).get(since);

if (why.n){
  console.log('\nof the unsized');
  console.log('  product record had no quantity: ' + why.no_record + ' of ' + why.n);
  console.log('  (those are one edit in Open Food Facts away from working)');
}

/* Repeat offenders are worth more than the rate: a handful of barcodes
   accounting for most of it is a morning's data entry, not a feature. */
const worst = db.prepare(`
  SELECT barcode, COUNT(*) AS n FROM quantity_outcome
  WHERE at >= ? AND outcome = 'size_unknown'
  GROUP BY barcode ORDER BY n DESC LIMIT 10
`).all(since);

if (worst.length){
  console.log('\nmost frequent unsized barcodes');
  for (const r of worst) console.log('  ' + r.barcode.padEnd(16) + String(r.n).padStart(4));
  const top = worst.reduce((s, r) => s + r.n, 0);
  console.log(`\n  these ${worst.length} account for ${top} of ${total.unknown}`
    + ` (${(100 * top / total.unknown).toFixed(0)}%)`);
  if (top / total.unknown > 0.5){
    console.log('  more than half sits in a few products — filling those in by hand');
    console.log('  may be cheaper than building anything.');
  }
}
console.log('');
