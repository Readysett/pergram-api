#!/usr/bin/env node
/* Classifier drift check.
 *
 * vendor/classifier.js must be byte-identical to the canonical copy in
 * the frontend repo. The two live in separate repositories and separate
 * deploys, so nothing structural stops them diverging — and they already
 * had: the API was carrying a copy with bucketed per-tier multipliers
 * long after the app had replaced them with a rate derived from the
 * footprint. A cheese claim priced by the app and the same claim priced
 * by the server disagreed by a factor of two.
 *
 *   node check-classifier.js                        # against GitHub
 *   node check-classifier.js ../pergram/classifier.js   # against a checkout
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const CANON = process.env.CLASSIFIER_URL
  || 'https://raw.githubusercontent.com/Readysett/pergram/main/classifier.js';

const sha = b => createHash('sha256').update(b).digest('hex');

const local = readFileSync(new URL('./vendor/classifier.js', import.meta.url));
const arg   = process.argv[2];

let canonical, where;
if (arg){
  canonical = readFileSync(arg);
  where = arg;
} else {
  const res = await fetch(CANON);
  if (!res.ok){
    console.error('could not read the canonical classifier: HTTP ' + res.status);
    console.error('(pass a path to a frontend checkout to check offline)');
    process.exit(2);
  }
  canonical = Buffer.from(await res.arrayBuffer());
  where = CANON;
}

if (sha(local) === sha(canonical)){
  console.log('ok   vendor/classifier.js matches ' + where);
  console.log('     sha256 ' + sha(local).slice(0, 16));
  process.exit(0);
}

console.error('FAIL vendor/classifier.js has drifted from ' + where);
console.error('     vendored  sha256 ' + sha(local).slice(0, 16) + '  (' + local.length + ' bytes)');
console.error('     canonical sha256 ' + sha(canonical).slice(0, 16) + '  (' + canonical.length + ' bytes)');
console.error('');
console.error('The frontend copy is canonical. Re-vendor it:');
console.error('  cp ../pergram/classifier.js vendor/classifier.js');
process.exit(1);
