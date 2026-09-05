/* The Document AI adapter. The point of it is that the fields arrive as
 * fields, so most of these are about reading them back faithfully — and
 * the rest are about saying what went wrong when they do not arrive. */
import { generateKeyPairSync } from 'node:crypto';
import { readExpense, documentAi, __resetToken } from './docai.js';
import { parseReceipt } from './receipt-parse.js';

let failures = 0;
const ok = (name, cond) => { if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const eq = (name, got, want) =>
  ok(name + (JSON.stringify(got) === JSON.stringify(want) ? '' : '  got ' + JSON.stringify(got)),
     JSON.stringify(got) === JSON.stringify(want));

/* A real key, because the adapter really signs with it. */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: 'pergram@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});
process.env.DOCAI_PROJECT_ID   = 'proj';
process.env.DOCAI_PROCESSOR_ID = 'abc123';
process.env.DOCAI_LOCATION     = 'us';

const doc = {
  text: 'RALPHS\n09/03/2026\nTRANSACTION # 7781-2233\nBARILLA PLUS 3.49\nTOTAL 12.47\n',
  entities: [
    { type: 'supplier_name', mentionText: 'RALPHS' },
    { type: 'receipt_date',  mentionText: '09/03/2026',
      normalizedValue: { dateValue: { year: 2026, month: 9, day: 3 } } },
    { type: 'total_amount',  mentionText: '$12.47',
      normalizedValue: { moneyValue: { currencyCode: 'USD', units: '12', nanos: 470000000 } } },
    { type: 'currency', mentionText: 'USD' },
    { type: 'line_item', mentionText: 'BARILLA PLUS PROTEIN 3.49', properties: [
        { type: 'line_item/description', mentionText: 'BARILLA PLUS PROTEIN' },
        { type: 'line_item/amount', mentionText: '3.49',
          normalizedValue: { moneyValue: { units: '3', nanos: 490000000 } } },
        { type: 'line_item/quantity', mentionText: '2' },
      ] },
    { type: 'line_item', mentionText: 'BAREBELLS 2.99', properties: [
        { type: 'line_item/description', mentionText: 'BAREBELLS  COOKIES' },
        { type: 'line_item/amount', mentionText: '2.99' },      // no normalised value
      ] },
  ],
};

console.log('\n--- reading the fields back ---');
{
  const r = readExpense(doc);
  eq('the supplier',            r.store, 'RALPHS');
  eq('the date, at midday',     new Date(r.purchased).toISOString(), '2026-09-03T12:00:00.000Z');
  eq('the total in cents',      r.total_cents, 1247);
  eq('the currency',            r.currency, 'USD');
  eq('two line items',          r.items.length, 2);
  eq('description, not the whole mention',
     r.items[0].text, 'BARILLA PLUS PROTEIN');
  eq('its amount',              r.items[0].cents, 349);
  eq('its quantity',            r.items[0].qty, 2);
  eq('run-together spacing is tidied', r.items[1].text, 'BAREBELLS COOKIES');
  eq('an amount with no normalised value is still read',
     r.items[1].cents, 299);
  ok('and no quantity is null, not zero', r.items[1].qty === null);
}

console.log('\n--- and what the parser makes of them ---');
{
  const p = parseReceipt({ parsed: readExpense(doc) });
  eq('it says which provider read it', p.source, 'document-ai');
  ok('nothing was reconstructed',    p.reconstructed === false);
  eq('the lines are the line items',
     p.lines.map(l => l.text + '|' + l.cents + '|' + l.qty),
     ['BARILLA PLUS PROTEIN|349|2', 'BAREBELLS COOKIES|299|null']);

  /* The one field the Expense Parser does not return. Without it a
     receipt is identified by its pixels alone. */
  eq('the transaction id is read out of the text', p.txn, '77812233');
  eq('and the total comes straight through', p.total_cents, 1247);
  ok('nothing was dropped',                  p.dropped.length === 0);
}

console.log('\n--- the call ---');
{
  const real = globalThis.fetch;
  let tokenCalls = 0, seen = null;

  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('oauth2')){
      tokenCalls++;
      return { ok: true, status: 200,
               json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    }
    seen = { url: String(url), opts };
    return { ok: true, status: 200, json: async () => ({ document: doc }) };
  };

  __resetToken();
  const r = await documentAi(Buffer.from('jpeg'), { mimeType: 'image/jpeg' });
  eq('the supplier survives the round trip', r.store, 'RALPHS');
  ok('it went to the regional endpoint',
     seen.url === 'https://us-documentai.googleapis.com/v1/projects/proj/locations/us/processors/abc123:process');
  ok('with a bearer token, not a key',
     seen.opts.headers.Authorization === 'Bearer tok' && !seen.url.includes('key='));
  ok('and the document inline',
     JSON.parse(seen.opts.body).rawDocument.mimeType === 'image/jpeg');
  ok('the request can be aborted', !!seen.opts.signal);

  await documentAi(Buffer.from('jpeg'));
  ok('the token is reused rather than refetched', tokenCalls === 1);

  globalThis.fetch = real;
}

console.log('\n--- when it goes wrong ---');
{
  const real = globalThis.fetch;
  const say = async fn => { try { await fn(); return null; } catch (e){ return e.message; } };

  globalThis.fetch = async url => String(url).includes('oauth2')
    ? { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) }
    : { ok: false, status: 403, json: async () => ({ error: {
        code: 403,
        message: 'Permission denied on resource project proj.' } }) };

  __resetToken();
  const denied = await say(() => documentAi(Buffer.from('x')));
  ok('a permission problem says so', !!denied && denied.includes('Permission denied'));
  ok('rather than only a status code', !!denied && !/^document ai HTTP/.test(denied));

  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({
    error: 'invalid_grant', error_description: 'Invalid JWT: token expired' }) });
  __resetToken();
  const badToken = await say(() => documentAi(Buffer.from('x')));
  ok('a token that will not mint says why',
     !!badToken && badToken.includes('Invalid JWT'));

  globalThis.fetch = real;

  const saved = process.env.DOCAI_PROCESSOR_ID;
  delete process.env.DOCAI_PROCESSOR_ID;
  __resetToken();
  const noProc = await say(() => documentAi(Buffer.from('x')));
  ok('a missing processor id is named', !!noProc && noProc.includes('DOCAI_PROCESSOR_ID'));
  process.env.DOCAI_PROCESSOR_ID = saved;

  const savedSa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = 'not json';
  __resetToken();
  const badSa = await say(() => documentAi(Buffer.from('x')));
  ok('a malformed service account is named', !!badSa && badSa.includes('not valid JSON'));
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = savedSa;

  const big = await say(() => documentAi(Buffer.alloc(21 * 1024 * 1024)));
  ok('an oversized document is refused before the call',
     !!big && big.includes('20MB'));
}

console.log('\n--- an empty read ---');
{
  const r = readExpense({ text: '', entities: [] });
  eq('nothing found is nothing claimed', [r.store, r.total_cents, r.items.length], [null, null, 0]);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
