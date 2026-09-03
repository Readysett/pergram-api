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

  const text = j && j.responses && j.responses[0]
            && j.responses[0].fullTextAnnotation
            && j.responses[0].fullTextAnnotation.text;
  if (!text) throw new Error('vision found no text in that image');
  return text;
}

export async function ocr(buf, { provider = process.env.OCR_PROVIDER || 'fake' } = {}){
  if (provider === 'google')   return googleVision(buf);
  if (provider === 'textract') throw new Error('textract adapter not written yet');
  return FIXTURES.default;     // fake
}
