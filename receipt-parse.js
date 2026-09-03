/* Turning receipt text into a claim.
 *
 * Header extraction (store, date, total, transaction id) is what makes
 * the anti-replay hash real: without a transaction id and a date, two
 * different shops at the same store collide, or the same receipt hashes
 * differently on a second upload.
 *
 * Line matching is deliberately NOT attempted cold. A receipt line says
 * "WHEY ISO CHOC 900G" — no barcode, no brand, abbreviations that differ
 * by retailer. Parsing that into a product from nothing needs a large
 * corpus of receipts nobody has on day one. Instead the user scans the
 * barcode (which classifies exactly), and the receipt only has to
 * confirm a matching line exists and supply the quantity. Matching a
 * known name against candidate lines is a far smaller problem than
 * reading them blind.
 */

const MONEY = /(\d{1,4}[.,]\d{2})\s*$/;

/* Common receipt lines that are never products. */
const NOT_A_PRODUCT = /^(subtotal|sub total|total|tax|balance|change|cash|visa|mastercard|debit|credit|amex|tender|savings|discount|coupon|loyalty|points|thank you|transaction|auth|ref|store|tel|phone|www|http)/i;

export function parseReceipt(text){
  const raw   = String(text || '');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  return {
    store:       findStore(lines),
    purchased:   findDate(raw),
    total_cents: findTotal(lines),
    txn:         findTxn(raw),
    lines:       findItems(lines),
    raw:         raw,
  };
}

function findStore(lines){
  /* The store name is almost always the first line that is not an
     address, a phone number, or a date. */
  for (const l of lines.slice(0, 5)){
    if (/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(l)) continue;   // phone
    if (/\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}/.test(l)) continue; // date
    if (/^\d+\s/.test(l)) continue;                           // street number
    if (l.length < 3) continue;
    return l.replace(/\s+/g, ' ').slice(0, 60);
  }
  return null;
}

function findDate(raw){
  /* Prefer an unambiguous ISO date; fall back to US ordering, which is
     what US receipts use. A misread date is not fatal — the claim window
     check will reject anything implausible. */
  let m = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);

  m = raw.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (m){
    let [, a, b, y] = m;
    if (y.length === 2) y = '20' + y;
    const mm = String(a).padStart(2, '0');
    const dd = String(b).padStart(2, '0');
    const t = Date.parse(`${y}-${mm}-${dd}T12:00:00Z`);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

function findTotal(lines){
  /* Read from the bottom: the last TOTAL is the one that was paid, and
     "SUBTOTAL" must not win. */
  for (let i = lines.length - 1; i >= 0; i--){
    const l = lines[i];
    if (!/\btotal\b/i.test(l)) continue;
    if (/sub\s*total/i.test(l)) continue;
    const m = l.match(MONEY);
    if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * 100);
  }
  return null;
}

function findTxn(raw){
  const pats = [
    /transaction\s*#?\s*([A-Z0-9-]{4,})/i,
    /trans\s*#?\s*([A-Z0-9-]{4,})/i,
    /\bTC#?\s*([A-Z0-9-]{6,})/i,
    /invoice\s*#?\s*([A-Z0-9-]{4,})/i,
    /receipt\s*#?\s*([A-Z0-9-]{4,})/i,
    /\bref\s*#?\s*([A-Z0-9-]{6,})/i,
  ];
  for (const p of pats){
    const m = raw.match(p);
    if (m) return m[1].replace(/-/g, '');
  }
  return null;
}

function findItems(lines){
  const out = [];
  for (const l of lines){
    if (NOT_A_PRODUCT.test(l)) continue;
    const m = l.match(MONEY);
    if (!m) continue;
    const desc = l.slice(0, l.length - m[0].length).trim();
    if (desc.length < 3) continue;
    out.push({
      text: desc,
      cents: Math.round(parseFloat(m[1].replace(',', '.')) * 100),
      qty: extractCount(l),          // null when the receipt does not say
    });
  }
  return out;
}

/* ---------- matching a scanned product to a receipt line ---------- */

const STOP = /\b(the|and|with|organic|natural|fresh|great|value|brand)\b/gi;

const tokens = s => String(s || '')
  .toUpperCase()
  .replace(STOP, ' ')
  .replace(/[^A-Z0-9]+/g, ' ')
  .split(' ')
  .filter(t => t.length > 2);

/* Receipts abbreviate by dropping vowels: CHDR for cheddar, SHRD for
   shredded, ISO for isolate. Prefix matching cannot see that — but
   abbreviations preserve letter order, so the short form is a
   subsequence of the long one. Requiring a shared first letter and
   three characters keeps that from matching everything. */
function isSubsequence(short, long){
  let i = 0;
  for (const ch of long){
    if (ch === short[i]) i++;
    if (i === short.length) return true;
  }
  return false;
}

function tokenHit(a, b){
  if (a === b) return 1;
  const short = a.length < b.length ? a : b;
  const long  = a.length < b.length ? b : a;
  if (short.length < 3) return 0;
  if (short[0] !== long[0]) return 0;
  if (long.startsWith(short)) return 0.9;
  if (isSubsequence(short, long)) return 0.75;
  return 0;
}

export function scoreLine(productName, lineText){
  const p = tokens(productName), l = tokens(lineText);
  if (!p.length || !l.length) return { score: 0, hits: 0 };
  let hit = 0, hits = 0;
  for (const pt of p){
    let best = 0;
    for (const lt of l) best = Math.max(best, tokenHit(pt, lt));
    hit += best;
    if (best >= 0.7) hits++;
  }
  return { score: hit / p.length, hits };
}

/**
 * Find the receipt line for a product the user has already scanned.
 * Returns null rather than a weak guess — a wrong match pays for
 * something that was not bought.
 */
export function matchProduct(productName, lines, { min = 0.25, minHits = 2 } = {}){
  /* Two independent conditions. The score alone is fragile — a long
     product name with one accidental hit could clear a low threshold —
     so a match must also land on at least two distinct tokens. On real
     receipts, true matches score 0.30+ with 2 hits and false ones score
     0.00 with none, so this is set from evidence rather than taste. */
  let best = null, bestScore = 0, bestHits = 0;
  for (const line of lines){
    const { score, hits } = scoreLine(productName, line.text);
    if (score > bestScore){ bestScore = score; bestHits = hits; best = line; }
  }
  if (!best || bestScore < min || bestHits < minHits) return null;
  return { ...best, score: Number(bestScore.toFixed(2)), hits: bestHits };
}

/* Weight units seen in package descriptions. Volume is converted as if it
   were water: milk is denser, so the result comes out slightly low, which
   is the direction to be wrong in. */
const UNIT_G = {
  G:1, GR:1, GRAM:1, GRAMS:1, KG:1000, KGS:1000,
  OZ:28.3495, LB:453.592, LBS:453.592, ML:1, L:1000, LT:1000, LTR:1000,
};

/* Pack size from free text: "6 x 142 g", "900g", "2 LB".
 *
 * Returns { count, unit_g, total_g }, where total_g already includes the
 * multiplier. Callers use total_g and never re-apply count — applying it
 * twice is how a six-pack becomes thirty-six tins.
 */
export function parsePackSize(text){
  const s = String(text || '').toUpperCase().replace(/,/g, '.');
  if (!s.trim()) return null;

  const grams = (n, unit) => {
    const f = UNIT_G[unit];
    return f ? Math.round(parseFloat(n) * f) : null;
  };

  /* "6 x 142 g" — the barcode denotes the whole pack. */
  let m = s.match(/(\d{1,3})\s*[X\u00D7]\s*(\d+(?:\.\d+)?)\s*([A-Z]+)/);
  if (m){
    const count  = parseInt(m[1], 10);
    const unit_g = grams(m[2], m[3]);
    if (unit_g && count > 0) return { count, unit_g, total_g: unit_g * count };
  }

  /* A plain weight: one unit of whatever this is. */
  m = s.match(/(\d+(?:\.\d+)?)\s*([A-Z]+)/);
  if (m){
    const unit_g = grams(m[1], m[2]);
    if (unit_g) return { count: 1, unit_g, total_g: unit_g };
  }
  return null;
}

/* How many of a line were bought. Only forms a receipt states plainly:
   inferring a count from a stray digit is worse than defaulting to one. */
export function extractCount(text){
  const s = String(text || '').toUpperCase();

  let m = s.match(/(\d{1,3})\s*@\s*\$?\d/);          // "2 @ 3.49"
  if (m && +m[1] > 0) return +m[1];

  m = s.match(/\bQTY\b\s*[:X]?\s*(\d{1,3})\b/);      // "QTY 2"
  if (m && +m[1] > 0) return +m[1];

  return null;
}

/* Package size off the line or the product name: 900G, 8OZ, 2 LB. */
export function extractGrams(text){
  const s = String(text || '').toUpperCase();
  let m = s.match(/(\d{2,5})\s*G\b/);        if (m) return +m[1];
  m = s.match(/(\d{1,3}(?:\.\d+)?)\s*KG\b/); if (m) return Math.round(+m[1] * 1000);
  m = s.match(/(\d{1,3}(?:\.\d+)?)\s*OZ\b/); if (m) return Math.round(+m[1] * 28.35);
  m = s.match(/(\d{1,3}(?:\.\d+)?)\s*LBS?\b/); if (m) return Math.round(+m[1] * 453.6);
  return null;
}

/* Below this ratio the two readings are close enough that asking costs
   more than it settles. */
export const ASK_RATIO = 2;

/* How much food a receipt line represents.
 *
 * Three separate facts arrive from three places: the barcode says what the
 * product is, the receipt says it was bought and how many, and the pack
 * size comes from whichever of them states one. None is authoritative for
 * all three, so they are combined rather than ranked.
 */
export function resolveQuantity({ line, quantity, productName } = {}){
  const linePack = line ? parsePackSize(line.text) : null;
  const offPack  = parsePackSize(quantity);

  /* A pack printed on the receipt line — "6 X 142G" — states how many
     units were bought, not what one weighs. It multiplies the count; it
     does not compete with the product record over unit size. */
  const count = ((line && line.qty) || 1) * (linePack ? linePack.count : 1);

  /* Readings of what one unit weighs. These genuinely compete: the record
     may describe a pack while the receipt describes a tin. */
  const lineSize = linePack ? linePack.unit_g
                 : line   ? (extractGrams(line.text) || extractGrams(productName))
                          : null;
  const readings = [lineSize, offPack && offPack.total_g].filter(n => n > 0);

  /* Take the lowest. Someone underpaid can be corrected later; an
     overpayment cannot be recovered, so doubt resolves downward. */
  const per_unit = readings.length ? Math.min(...readings) : null;

  /* per_unit already carries any pack multiplier from the product record,
     and count carries any stated on the receipt. Neither is applied twice
     — doing that is how a six-pack becomes thirty-six tins. */
  const grams = per_unit === null ? null : per_unit * count;

  /* An answer must never be able to raise the claim, which leaves exactly
     one question worth asking: a multipack from the product record that
     nothing else corroborates. Scanning a single tin from inside a pack
     looks identical to buying the pack, and no parsing separates them.
     Confirming keeps the figure, correcting lowers it.

     Where a lower reading was already taken there is nothing to ask, and
     that line stays underpaid until a receipt settles it. */
  const ask = (offPack && offPack.count > 1
               && !lineSize                       // the receipt said nothing about size
               && per_unit === offPack.total_g
               && offPack.total_g > offPack.unit_g * ASK_RATIO)
    ? {
        question: 'Did you buy the ' + offPack.count + '-pack, or a single unit?',
        keep_g:  offPack.total_g * count,
        lower_g: offPack.unit_g  * count,
      }
    : null;

  return { count, per_unit, grams, pack: offPack || linePack || null, ask };
}

