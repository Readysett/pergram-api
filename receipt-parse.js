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
    out.push({ text: desc, cents: Math.round(parseFloat(m[1].replace(',', '.')) * 100) });
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

/* Package size off the line or the product name: 900G, 8OZ, 2 LB. */
export function extractGrams(text){
  const s = String(text || '').toUpperCase();
  let m = s.match(/(\d{2,5})\s*G\b/);        if (m) return +m[1];
  m = s.match(/(\d{1,3}(?:\.\d+)?)\s*KG\b/); if (m) return Math.round(+m[1] * 1000);
  m = s.match(/(\d{1,3}(?:\.\d+)?)\s*OZ\b/); if (m) return Math.round(+m[1] * 28.35);
  m = s.match(/(\d{1,3}(?:\.\d+)?)\s*LBS?\b/); if (m) return Math.round(+m[1] * 453.6);
  return null;
}
