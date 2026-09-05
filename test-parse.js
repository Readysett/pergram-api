import { parseReceipt, matchProduct, extractGrams, scoreLine } from './receipt-parse.js';
import { ocr } from './ocr.js';

const text = await ocr(Buffer.from(''));
const r = parseReceipt(text);

console.log('\n--- header ---');
console.log('store      ', r.store);
console.log('date       ', r.purchased ? new Date(r.purchased).toISOString().slice(0,10) : null);
console.log('total      ', r.total_cents !== null ? '$' + (r.total_cents/100).toFixed(2) : null);
console.log('txn        ', r.txn);

console.log('\n--- line items ---');
for (const l of r.lines) console.log('  ' + l.text.padEnd(42) + '$' + (l.cents/100).toFixed(2));

console.log('\n--- matching scanned products to lines ---');
const scanned = [
  '100% GRASS-FED Whey Protein Isolate',
  'Mild Cheddar Cheese Fancy Shredded',
  'Creamy Peanut Butter',            // not on this receipt — must not match
];
for (const name of scanned){
  const m = matchProduct(name, r.lines);
  console.log('  ' + name.slice(0,36).padEnd(38)
    + (m ? '-> "' + m.text + '"  score ' + m.score + '  ' + (extractGrams(m.text) || '?') + 'g'
         : '-> no match (correct if not on receipt)'));
}

console.log('\n--- guards ---');
const empty = parseReceipt('');
console.log('  empty text          ', JSON.stringify({store:empty.store, total:empty.total_cents, lines:empty.lines.length}));
console.log('  subtotal not total  ', parseReceipt('SUBTOTAL 51.59\nTOTAL 51.97').total_cents === 5197 ? 'ok' : 'FAIL');
console.log('  card line ignored   ', parseReceipt('VISA 4417  51.97').lines.length === 0 ? 'ok' : 'FAIL');
console.log('  weak match refused  ', matchProduct('Bananas', [{text:'WHEY ISO CHOC 900G'}]) === null ? 'ok' : 'FAIL');
console.log('  one-token no match  ', matchProduct('Organic Whey Free Range Grass Fed Vanilla Powder Large',
    [{text:'WHEY ISO CHOC 900G'}]) ? 'matched (check)' : 'ok — one line cannot make a word distinctive');
console.log('  right line of many  ', (()=>{const m=matchProduct('Mild Cheddar Cheese Fancy Shredded', r.lines); return m && /CHDR/.test(m.text) ? 'ok' : 'FAIL';})());
console.log('  oz to grams         ', extractGrams('CHDR SHRD 8OZ') === 227 ? 'ok' : 'FAIL (' + extractGrams('CHDR SHRD 8OZ') + ')');
