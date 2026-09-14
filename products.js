/* Per Gram — server-side product resolution.
 *
 * The server used to take a product's protein, footprint and multiplier
 * from whatever the client sent. Everything that decides a reward is
 * derived here instead, from the barcode alone.
 *
 * Two rules govern this file, and both come from settle.js:
 *
 *   rate = pool / total points
 *
 * A payout is relative, so what one barcode is worth is not a private
 * fact about that claim — it moves the denominator, and therefore what
 * every other wallet in the round earns. Hence:
 *
 *   1. Cached figures are never updated in place. A new reading
 *      supersedes the old one; the old row stays, and any claim priced
 *      from it keeps pointing at exactly the numbers it was paid on.
 *   2. Within one open round a barcode resolves to one version for
 *      everyone. A correction that lands on Wednesday must not mean the
 *      person who claimed on Monday was paid on a different basis.
 *      New versions take effect at the round boundary, where the
 *      denominator resets anyway.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import classifier from './vendor/classifier.js';
import { db, now } from './db.js';

const { classifyProduct, SOURCES, FALLBACK, MIN_PROTEIN_100G, multFor } = classifier;

/* Which rules produced a row. The vendored classifier is the canonical
   frontend file, so hashing it records precisely the ruleset in force —
   enough to find every row that predates a rules change without
   guessing from dates. */
const RULES_HASH = createHash('sha256')
  .update(readFileSync(new URL('./vendor/classifier.js', import.meta.url)))
  .digest('hex').slice(0, 16);

const OFF_HOST    = process.env.OFF_HOST || 'world.openfoodfacts.org';
const OFF_TIMEOUT = Number(process.env.OFF_TIMEOUT_MS || 8000);

/* How long a settled reading is used before we look again. Refreshes
   only ever take effect at a round boundary, so there is nothing to gain
   from a short window and a real cost to a long one: a genuine Open Food
   Facts correction should not take a season to arrive. */
const REFRESH_MS = Number(process.env.OFF_REFRESH_MS || 30 * 86400000);

const FIELDS = ['product_name','brands','nutriments','ingredients_text',
                'categories','labels_tags','serving_size','serving_quantity',
                'quantity'].join(',');

/* Per Gram's contact address travels with every request. Open Food Facts
   asks for it, and an anonymous scraper is the first thing they block. */
const UA = process.env.OFF_USER_AGENT
  || 'PerGram/1.0 (VeBetterDAO x2Earn; contact via github.com/Readysett)';

/* A lookup that did not settle. Distinct from "no such product", which
   is an answer: this one means we do not know, and nothing may be
   priced, cached or claimed on the strength of it. Caching a network
   blip would turn it into a permanent zero for that barcode. */
export class LookupUnavailable extends Error {
  constructor(barcode, cause){
    super('could not reach the product database for ' + barcode);
    this.name = 'LookupUnavailable';
    this.barcode = barcode;
    this.cause = cause;
  }
}

/* US barcodes are 12-digit UPC; Open Food Facts stores most records as
   13-digit EAN with a leading zero. Same product, different string.
   Mirrors what the app already tries, so a product that resolves in the
   scanner resolves here too. */
export function variants(barcode){
  const b = String(barcode);
  const out = [b];
  if (b.length === 12) out.push('0' + b);
  if (b.length === 13 && b[0] === '0') out.push(b.slice(1));
  if (b.length === 8)  out.push(b.padStart(13, '0'));
  return out;
}

export function isBarcode(v){
  return /^[0-9]{8,14}$/.test(String(v || ''));
}

async function getOne(code){
  const url = 'https://' + OFF_HOST + '/api/v2/product/' + code + '.json?fields=' + FIELDS;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(OFF_TIMEOUT),
  });

  /* 404 is an answer — that barcode is not in the database. Everything
     else in the failure range is the service having a bad day, and must
     not be recorded as a fact about the product. */
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('HTTP ' + res.status);

  const j = await res.json();
  if (!j || !j.product) return null;
  if (!j.product.product_name && !j.product.ingredients_text) return null;
  return j.product;
}

/* Read the barcode from Open Food Facts and price it.
 *
 * Returns a row shape, never throws for a product that simply is not
 * there — that is `absent`, a settled answer. Throws LookupUnavailable
 * when the question could not be asked. */
export async function fetchProduct(barcode){
  let product = null, foundAs = null, transient = null;

  for (const code of variants(barcode)){
    try {
      const p = await getOne(code);
      if (p){ product = p; foundAs = code; break; }
    } catch (e){
      transient = e;   // keep trying the other variants before giving up
    }
  }

  /* No record found, but at least one variant failed to answer: we
     cannot tell "not in the database" from "did not load". Refusing to
     guess is the whole point. */
  if (!product && transient) throw new LookupUnavailable(barcode, transient);

  if (!product){
    return { status:'absent', found_as:null, name:null, brands:null, quantity:null,
             protein_100g:null, ingredients:null, categories:null, vegan:0,
             source_key:null, co2:null, mult:null };
  }

  const n = product.nutriments || {};
  const protein = n.proteins_100g ?? n.proteins ?? null;

  const base = {
    found_as:     foundAs,
    name:         product.product_name || null,
    brands:       product.brands || null,
    quantity:     product.quantity || null,
    protein_100g: (protein === null || protein === undefined) ? null : Number(protein),
    ingredients:  product.ingredients_text || null,
    categories:   product.categories || null,
    vegan:        veganOf(product) ? 1 : 0,
  };

  /* Protein has to be the point of the food. Green beans are 0.8g per
     100g — a vegetable, not a protein source. A real product under the
     threshold is a settled answer worth caching, not an error: it earns
     nothing and should not be re-fetched on every scan. A missing
     protein figure lands here too — unscoreable, so unpaid. */
  if (!(base.protein_100g >= MIN_PROTEIN_100G)){
    return { ...base, status:'below_min', source_key:null, co2:null, mult:null };
  }

  const { key } = classifyProduct({
    name:        base.name || '',
    ingredients: base.ingredients || '',
    categories:  base.categories || '',
    vegan:       !!base.vegan,
  });

  /* Unresolved never defaults to the top tier — that would be the
     cheapest thing in the app to exploit. FALLBACK is not a member of
     SOURCES, so its multiplier is derived here rather than read off it. */
  const src  = key ? SOURCES[key] : FALLBACK;
  const co2  = src.co2;
  const mult = key ? src.mult : multFor(FALLBACK.co2);

  return { ...base, status:'ok', source_key: key || 'unresolved', co2, mult };
}

function veganOf(product){
  const tags = (product.labels_tags || []).join(' ');
  return /\bvegan\b/i.test(tags) && !/non-vegan|maybe-vegan/i.test(tags);
}

/* ---------- versioned cache ---------- */

export function currentVersion(barcode){
  return db.prepare(
    `SELECT * FROM product_version WHERE barcode=? AND superseded_at IS NULL`
  ).get(String(barcode));
}

export function versionAt(barcode, version){
  return db.prepare(
    `SELECT * FROM product_version WHERE barcode=? AND version=?`
  ).get(String(barcode), version);
}

/* The version this round is already committed to, if any. One barcode,
   one price, for everyone who claims it this week. */
export function pinnedVersion(barcode, roundId){
  const row = db.prepare(`
    SELECT product_version AS v FROM claim
    WHERE barcode=? AND round_id=? AND product_version IS NOT NULL
    ORDER BY id LIMIT 1
  `).get(String(barcode), roundId);
  return row ? row.v : null;
}

function insertVersion(barcode, version, row){
  db.prepare(`
    INSERT INTO product_version
      (barcode, version, status, found_as, name, brands, quantity, protein_100g,
       ingredients, categories, vegan, source_key, co2, mult, rules_hash,
       locked, fetched_at, superseded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,NULL)
  `).run(String(barcode), version, row.status, row.found_as, row.name, row.brands,
         row.quantity, row.protein_100g, row.ingredients, row.categories,
         row.vegan ? 1 : 0, row.source_key, row.co2, row.mult, RULES_HASH, now());
  return versionAt(barcode, version);
}

/* What actually decides a reward. Anything else may change freely
   between versions without superseding one — a corrected brand string is
   not worth repricing a round over. */
function pricingDiffers(a, b){
  const near = (x, y) => (x === null || x === undefined ? x === y
                        : Math.abs(Number(x) - Number(y)) < 1e-9);
  return a.status !== b.status
      || a.source_key !== b.source_key
      || !near(a.protein_100g, b.protein_100g)
      || !near(a.co2,  b.co2)
      || !near(a.mult, b.mult)
      || (a.quantity || null) !== (b.quantity || null);   // pack size sets the grams
}

/**
 * Resolve a barcode to the cached version this round must price it from,
 * fetching from Open Food Facts only when there is nothing usable.
 *
 * Throws LookupUnavailable when there is no cached version and the
 * lookup did not settle — the caller must not write anything.
 */
export async function resolveProduct(barcode, roundId){
  const code = String(barcode);

  /* Already priced in this round: that decision stands for the week. */
  const pin = pinnedVersion(code, roundId);
  if (pin !== null){
    const row = versionAt(code, pin);
    if (row) return row;
  }

  const cur = currentVersion(code);

  /* A human looked at this and pinned it. Never superseded automatically;
     that is what the review is for. */
  if (cur && cur.locked) return cur;

  if (cur && (now() - cur.fetched_at) < REFRESH_MS) return cur;

  let fresh;
  try {
    fresh = await fetchProduct(code);
  } catch (e){
    if (e instanceof LookupUnavailable){
      /* A stale reading is a far better answer than none: it is what the
         previous claimants were paid on, and it is not attacker-chosen.
         Only a barcode we have never resolved has nothing to fall back
         to, and that one must fail rather than invent a figure. */
      if (cur) return cur;
      throw e;
    }
    throw e;
  }

  if (!cur) return insertVersion(code, 1, fresh);

  if (!pricingDiffers(cur, fresh)){
    /* Same price. Reset the clock in place — fetched_at decides when to
       look again and has no bearing on what anyone earns, so this is not
       the kind of mutation the versioning exists to prevent. */
    db.prepare(`UPDATE product_version SET fetched_at=? WHERE barcode=? AND version=?`)
      .run(now(), code, cur.version);
    return currentVersion(code);
  }

  /* The price moved. If this barcode has already been claimed in the
     open round, the round is committed and the new reading waits for the
     boundary — superseding now would reprice a week that is part-paid. */
  if (claimedInRound(code, roundId)) return cur;

  db.prepare(`UPDATE product_version SET superseded_at=? WHERE barcode=? AND version=?`)
    .run(now(), code, cur.version);
  return insertVersion(code, cur.version + 1, fresh);
}

function claimedInRound(barcode, roundId){
  return !!db.prepare(
    `SELECT 1 FROM claim WHERE barcode=? AND round_id=? LIMIT 1`
  ).get(String(barcode), roundId);
}

export { RULES_HASH, MIN_PROTEIN_100G };
