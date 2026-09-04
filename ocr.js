import { createHash } from 'node:crypto';

/* OCR is a swappable adapter, chosen by OCR_PROVIDER:
 *
 *   fake    — no network, no key. Returns fixtures so the whole pipeline
 *             can be exercised offline. The default.
 *   google  — Google Cloud Vision DOCUMENT_TEXT_DETECTION.
 *   textract— AWS Textract (expects the raw text response passed through).
 *
 * Keeping this behind one interface matters: the parser and the claim
 * logic are the parts worth testing, and neither should care which
 * vendor produced the text, or whether one was involved at all.
 */

export const imageHash = buf => createHash('sha256').update(buf).digest('hex');

const FIXTURES = {
  default: `
WHOLE FOODS MARKET
LAKE ELSINORE CA
08/30/2026  02:14 PM

TRANSPARENT LABS WHEY ISO CHOC 900G      44.99
CHESTNUT HILL CHDR SHRD 8OZ               4.29
BANANAS ORGANIC 2.1 LB                    2.31

SUBTOTAL                                 51.59
TAX                                       0.38
TOTAL                                    51.97

VISA ************4417
TRANSACTION #  4471-8823-0091
THANK YOU FOR SHOPPING
`,
};

const VISION_TIMEOUT_MS = 20_000;

/* Vision refuses a JSON request over 10MB, and base64 inflates by a
   third, so the image itself has to stay under about 7.5MB. The 20MB
   figure in the documentation is for files hosted elsewhere, not for
   content sent inline. Refusing here names the actual limit; Vision's
   own refusal does not mention base64 and reads like a corrupt upload. */
const MAX_INLINE_BYTES = 7 * 1024 * 1024;

async function googleVision(buf){
  const key = process.env.GOOGLE_VISION_KEY;
  if (!key) throw new Error('GOOGLE_VISION_KEY not set');

  if (buf.length > MAX_INLINE_BYTES){
    throw new Error('image is ' + (buf.length / 1048576).toFixed(1)
      + 'MB; inline images must stay under 7MB once base64 encoded');
  }

  /* Node's fetch has no timeout of its own, so without this a call that
     hangs holds the request and its buffer for as long as the socket
     lives — and the caller is a phone waiting on a receipt. */
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), VISION_TIMEOUT_MS);

  let res;
  try {
    res = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST',
      /* The key rides in a header, not the query string. URLs are the
         part that ends up in access logs and proxy traces, and this one
         is a credential. */
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify({
        requests: [{
          image: { content: buf.toString('base64') },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        }],
      }),
      signal: ac.signal,
    });
  } catch (e){
    if (e.name === 'AbortError'){
      throw new Error('vision timed out after ' + (VISION_TIMEOUT_MS / 1000) + 's');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const j = await res.json().catch(() => null);

  /* Vision reports per-image failures inside a 200 response: billing not
     enabled, a key restricted to the wrong referrer, an exhausted quota.
     Checking only for text turned every one of those into "no text",
     which reads like a bad photograph and sends you looking at the
     camera instead of the console. Say what Vision said. */
  const err = (j && j.error) || (j && j.responses && j.responses[0] && j.responses[0].error);
  if (err) throw new Error('vision: ' + (err.message || JSON.stringify(err)));

  if (!res.ok) throw new Error('vision HTTP ' + res.status);

  const first = (j && j.responses && j.responses[0]) || {};
  const text  = first.fullTextAnnotation && first.fullTextAnnotation.text;
  if (!text) throw new Error('vision found no text in that image');

  /* The text alone is not enough. Vision orders it by the blocks it
     segmented, and on a receipt those are columns — every description,
     then every price — so the reading order it hands back is not the
     order the receipt was printed in. The word positions are what make
     rows recoverable, so they travel with the text. */
  const words = Array.isArray(first.textAnnotations)
    ? wordBoxes(first.textAnnotations.slice(1))    // [0] is the whole text
    : [];

  return { text, words: words.length ? words : null };
}

/* Each annotation carries four corners. The documentation is explicit
   that zero coordinates are omitted rather than sent as zero, so a word
   flush against the left edge arrives with no x field at all — and
   `v.x` would be undefined, which turns every later comparison into NaN
   and silently drops the word. Default, do not assume. */
function wordBoxes(annotations){
  const out = [];
  for (const a of annotations || []){
    const vs = (a && a.boundingPoly && a.boundingPoly.vertices) || [];
    if (!a.description || vs.length < 4) continue;

    const xs = vs.map(v => (v && v.x) || 0);
    const ys = vs.map(v => (v && v.y) || 0);
    const top = Math.min(...ys), bottom = Math.max(...ys);

    /* The corners come round the word in order, so the step from the
       first to the second runs along the text. On a page photographed
       square that is horizontal; on one held at an angle it is not, and
       the angle is the page's rotation. Collapsing the quad to an
       upright box throws that away — and it is the only thing that says
       which row a word is on once the rows overlap. */
    const [v0, v1, , v3] = vs;
    const dx = ((v1 && v1.x) || 0) - ((v0 && v0.x) || 0);
    const dy = ((v1 && v1.y) || 0) - ((v0 && v0.y) || 0);

    /* Down the left edge is the height of the text itself, which stays
       right however the page is turned. The upright box does not: turn a
       word and its box grows taller than the letters in it. */
    const ex = ((v3 && v3.x) || 0) - ((v0 && v0.x) || 0);
    const ey = ((v3 && v3.y) || 0) - ((v0 && v0.y) || 0);
    const side = Math.hypot(ex, ey);

    out.push({
      text: a.description,
      angle: Math.hypot(dx, dy) > 0 ? Math.atan2(dy, dx) : 0,
      x: Math.min(...xs),
      /* The right edge as well as the left. A gap between two words is
         the distance from where one ends to where the next begins, and
         with only left edges that distance cannot be measured at all. */
      x2: Math.max(...xs),
      /* The centre, not the top edge: a photograph is never quite square
         to the page, and a tall word beside a short one shares a centre
         long before it shares an edge. */
      y: (top + bottom) / 2,
      h: side > 0 ? side : bottom - top,
    });
  }
  return out;
}

/* Returns { text, words }. words is null when the provider cannot say
   where anything was — the fixture, for one — and the caller then has
   nothing to reconstruct from and falls back to the text's own line
   breaks. */
export async function ocr(buf, { provider = process.env.OCR_PROVIDER || 'fake' } = {}){
  if (provider === 'google')   return googleVision(buf);
  if (provider === 'textract') throw new Error('textract adapter not written yet');
  return { text: FIXTURES.default, words: null };   // fake
}
