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

async function googleVision(buf){
  const key = process.env.GOOGLE_VISION_KEY;
  if (!key) throw new Error('GOOGLE_VISION_KEY not set');
  const res = await fetch(
    'https://vision.googleapis.com/v1/images:annotate?key=' + key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: buf.toString('base64') },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        }],
      }),
    });
  if (!res.ok) throw new Error('vision HTTP ' + res.status);
  const j = await res.json();
  const t = j.responses?.[0]?.fullTextAnnotation?.text;
  if (!t) throw new Error('vision returned no text');
  return t;
}

export async function ocr(buf, { provider = process.env.OCR_PROVIDER || 'fake' } = {}){
  if (provider === 'google')   return googleVision(buf);
  if (provider === 'textract') throw new Error('textract adapter not written yet');
  return FIXTURES.default;     // fake
}
