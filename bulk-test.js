#!/usr/bin/env node
/* Per Gram — bulk classifier test.
 *
 * Runs the classifier over the Open Food Facts dump and reports where it
 * is confident, where it is guessing, and where it is probably wrong.
 *
 * Reads the .gz directly — no decompression step, and it stops when it
 * has seen enough, so you do not need the whole file on disk uncompressed
 * (which is several times larger than the download).
 *
 * 1. Download the dump (~9 GB). Paste this into a browser if curl is
 *    awkward on your machine:
 *
 *      https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz
 *
 * 2. Put it in the same folder as this script, then:
 *
 *      node bulk-test.js openfoodfacts-products.jsonl.gz --limit 200000
 *
 *    Drop --limit to read the whole file. Start with the limit.
 *
 * Also accepts piped input, if you prefer:
 *
 *      zcat dump.jsonl.gz | node bulk-test.js
 */

const readline = require('readline');
const fs   = require('fs');
const zlib = require('zlib');
const { classify, SOURCES, TIERS, MIN_PROTEIN_100G } = require('./classifier.js');

const args  = process.argv.slice(2);
const file  = args.find(a => !a.startsWith('--'));
const limIx = args.indexOf('--limit');
const LIMIT = limIx > -1 ? parseInt(args[limIx + 1], 10) : Infinity;

let input;
if (file){
  if (!fs.existsSync(file)){
    console.error('No such file: ' + file);
    console.error('Download it first, and keep it in this folder.');
    process.exit(1);
  }
  const raw = fs.createReadStream(file);
  input = file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  console.error('Reading ' + file + (LIMIT === Infinity ? '' : ', first ' + LIMIT.toLocaleString() + ' products') + ' …');
} else {
  if (process.stdin.isTTY){
    console.error('Usage: node bulk-test.js <dump.jsonl.gz> [--limit 200000]');
    process.exit(1);
  }
  input = process.stdin;
}

const counts     = {};          // key -> n
const samples    = {};          // key -> up to N example names
const suspicious = [];          // classified animal, labelled vegan
const unresolved = [];          // in scope, no rule matched

const SAMPLE_N = 6;
const SUSPECT_N = 40;

let seen = 0, inScope = 0, noProtein = 0, noName = 0;

const rl = readline.createInterface({ input, crlfDelay: Infinity });

let done = false;
rl.on('line', line => {
  if (done || !line.trim()) return;
  if (seen >= LIMIT){ done = true; rl.close(); return; }
  let p;
  try { p = JSON.parse(line); } catch { return; }
  seen++;

  const name = p.product_name || '';
  if (!name){ noName++; return; }

  const protein = p.nutriments && (p.nutriments.proteins_100g ?? p.nutriments.proteins);
  if (!(protein >= MIN_PROTEIN_100G)){ noProtein++; return; }
  inScope++;

  const hay = [name, p.brands, p.ingredients_text, p.categories].filter(Boolean).join(' ');
  const key = classify(hay) || 'UNRESOLVED';

  counts[key] = (counts[key] || 0) + 1;
  if (!samples[key]) samples[key] = [];
  if (samples[key].length < SAMPLE_N) samples[key].push(name.slice(0, 62));

  // Strongest automatic signal of a wrong call: the product declares
  // itself vegan, and we decided it is an animal protein.
  const tags = (p.labels_tags || []).join(' ') + ' ' + (p.ingredients_analysis_tags || []).join(' ');
  const claimsVegan = /\bvegan\b/i.test(tags) && !/non-vegan|maybe-vegan/i.test(tags);
  const animal = ['beef','pork','chicken','fish','egg','whey','dairy','cheese'].includes(key);
  if (claimsVegan && animal && suspicious.length < SUSPECT_N){
    suspicious.push(key + '  ' + name.slice(0, 54));
  }

  if (key === 'UNRESOLVED' && unresolved.length < SUSPECT_N){
    unresolved.push(name.slice(0, 62));
  }
});

process.on('uncaughtException', e => {
  if (done && /premature|EPIPE|ERR_STREAM/i.test(String(e && e.message))) return;
  throw e;
});

rl.on('close', () => {
  const pct = n => (100 * n / Math.max(1, inScope)).toFixed(1).padStart(5) + '%';

  console.log('\n' + '='.repeat(64));
  console.log('PER GRAM — bulk classifier report');
  console.log('='.repeat(64));
  console.log('products read          ' + seen.toLocaleString());
  console.log('  no name              ' + noName.toLocaleString());
  console.log('  under ' + MIN_PROTEIN_100G + 'g protein    ' + noProtein.toLocaleString());
  console.log('in scope               ' + inScope.toLocaleString());

  console.log('\n--- classified as ---');
  const rows = Object.entries(counts).sort((a,b) => b[1] - a[1]);
  for (const [k, n] of rows){
    const s = SOURCES[k];
    const tier = s ? 't' + s.tier + ' ' + TIERS[s.tier].mult.toFixed(2) + '×' : 't3 0.25× (fallback)';
    console.log(k.padEnd(12) + String(n).padStart(8) + '  ' + pct(n) + '   ' + tier);
  }

  const unres = counts.UNRESOLVED || 0;
  console.log('\nunresolved rate        ' + pct(unres));
  console.log(unres / Math.max(1, inScope) > 0.25
    ? '  → over a quarter unmatched. Add rules before this pays anyone.'
    : '  → acceptable. Unresolved falls to tier 3, so it under-pays rather than over-pays.');

  console.log('\n--- samples per class (eyeball these) ---');
  for (const [k] of rows){
    console.log('\n' + k);
    for (const s of samples[k] || []) console.log('   ' + s);
  }

  if (suspicious.length){
    console.log('\n--- LIKELY WRONG: labelled vegan, classified animal ---');
    for (const s of suspicious) console.log('   ' + s);
  } else {
    console.log('\nNo vegan/animal contradictions found.');
  }

  if (unresolved.length){
    console.log('\n--- unresolved samples (each suggests a missing rule) ---');
    for (const s of unresolved) console.log('   ' + s);
  }
  console.log('');
});
