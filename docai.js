/* Google Document AI — Expense Parser.
 *
 * Vision returns where every character is and leaves the reading of the
 * page to you. Five attempts at that reading order failed in five
 * different ways: text ordered by column, rows found by height, rows
 * found by spacing, rows carried across a gutter, rows interleaved by a
 * tilted page. None of those are receipt problems. They are page-layout
 * problems, and Document AI has already solved them — this processor
 * returns the supplier, the date, the total and the line items as fields.
 *
 * The cost is a different way in. Vision takes an API key on the request;
 * Document AI does not accept one at all, and wants an OAuth token from a
 * service account. That is the whole of the extra machinery below.
 */
import { createSign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 30_000;

/* Document AI's own ceiling on an inline document. */
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

function serviceAccount(){
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');

  let sa;
  try { sa = JSON.parse(raw); }
  catch (e){ throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); }

  if (!sa.client_email || !sa.private_key){
    throw new Error('service account JSON has no client_email or private_key');
  }
  return sa;
}

/* A token lasts an hour. Fetching one per receipt would add a round trip
   to every scan for nothing. */
let cached = { token: null, until: 0 };

async function accessToken(){
  if (cached.token && Date.now() < cached.until) return cached.token;

  const sa  = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');

  const body = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });

  const signed = body + '.' +
    createSign('RSA-SHA256').update(body).sign(sa.private_key, 'base64url');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signed,
    }),
  });

  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.access_token){
    /* Google says why in the body, and the reason is usually actionable:
       a clock out of step, a key that has been revoked, an account
       without the role. */
    const why = (j && (j.error_description || j.error)) || ('HTTP ' + res.status);
    throw new Error('could not get a token for the service account: ' + why);
  }

  cached = { token: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
  return cached.token;
}

/* ---------- reading what came back ---------- */

const centsFromText = t => {
  const m = String(t || '').match(/(\d{1,6}[.,]\d{2})/);
  return m ? Math.round(parseFloat(m[1].replace(',', '.')) * 100) : null;
};

/* Money arrives normalised when Document AI is sure of it, and as the
   text it saw when it is not. Prefer the first, fall back to the second
   rather than dropping the figure. */
function moneyCents(e){
  const m = e && e.normalizedValue && e.normalizedValue.moneyValue;
  if (m && (m.units != null || m.nanos != null)){
    return Math.round(Number(m.units || 0) * 100 + Number(m.nanos || 0) / 1e7);
  }
  return centsFromText(e && e.mentionText);
}

function dateMs(e){
  const d = e && e.normalizedValue && e.normalizedValue.dateValue;
  if (d && d.year){
    /* Midday, so a timezone cannot move it onto the day before. */
    return Date.UTC(d.year, (d.month || 1) - 1, d.day || 1, 12);
  }
  return null;
}

const numberFrom = t => {
  const m = String(t || '').match(/(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
};

const first = (ents, type) => (ents || []).find(e => e && e.type === type);

/* line_item entities carry their fields as properties, typed with the
   parent's name in front: line_item/description, line_item/amount. */
function lineItems(ents){
  const out = [];
  for (const e of ents || []){
    if (!e || e.type !== 'line_item') continue;

    const p = e.properties || [];
    const get = suffix => p.find(q => q && q.type === 'line_item/' + suffix);

    const desc = get('description');
    const text = (desc && desc.mentionText) || e.mentionText || '';
    if (!text.trim()) continue;

    const qty = get('quantity');

    out.push({
      text:  text.replace(/\s+/g, ' ').trim(),
      cents: moneyCents(get('amount')),
      qty:   qty ? numberFrom(qty.mentionText) : null,
      product_code: (get('product_code') || {}).mentionText || null,
    });
  }
  return out;
}

export function readExpense(doc){
  const ents = (doc && doc.entities) || [];
  const supplier = first(ents, 'supplier_name');
  const when     = first(ents, 'receipt_date');
  const total    = first(ents, 'total_amount');
  const currency = first(ents, 'currency');

  return {
    source:      "document-ai",
    store:       (supplier && supplier.mentionText) || null,
    purchased:   dateMs(when),
    total_cents: moneyCents(total),
    currency:    (currency && currency.mentionText) || null,
    items:       lineItems(ents),
    text:        (doc && doc.text) || '',
  };
}

/* ---------- the call itself ---------- */

export async function documentAi(buf, { mimeType = 'image/jpeg' } = {}){
  const project   = process.env.DOCAI_PROJECT_ID;
  const location  = process.env.DOCAI_LOCATION || 'us';
  const processor = process.env.DOCAI_PROCESSOR_ID;

  if (!project)   throw new Error('DOCAI_PROJECT_ID not set');
  if (!processor) throw new Error('DOCAI_PROCESSOR_ID not set');

  if (buf.length > MAX_INLINE_BYTES){
    throw new Error('image is ' + (buf.length / 1048576).toFixed(1)
      + 'MB; documents sent inline must stay under 20MB');
  }

  const token = await accessToken();
  const url = 'https://' + location + '-documentai.googleapis.com/v1/projects/'
            + project + '/locations/' + location + '/processors/' + processor + ':process';

  /* Same reason as the Vision adapter: node's fetch has no timeout of its
     own, and a phone is waiting on the other end of this. */
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        rawDocument: { content: buf.toString('base64'), mimeType },
      }),
      signal: ac.signal,
    });
  } catch (e){
    if (e.name === 'AbortError'){
      throw new Error('document ai timed out after ' + (TIMEOUT_MS / 1000) + 's');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const j = await res.json().catch(() => null);

  /* Say what Google said. A processor id that does not exist, a service
     account without the role, an API not enabled — each has its own
     message, and "no text found" for any of them sends you to the camera
     instead of the console. */
  if (j && j.error){
    throw new Error('document ai: ' + (j.error.message || JSON.stringify(j.error)));
  }
  if (!res.ok) throw new Error('document ai HTTP ' + res.status);

  const doc = j && j.document;
  if (!doc) throw new Error('document ai returned no document');

  return readExpense(doc);
}

/* For tests. */
export function __resetToken(){ cached = { token: null, until: 0 }; }
