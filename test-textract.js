/* The Textract adapter.
 *
 * Two halves: the fields come back already labelled, so most of this is
 * about reading them faithfully — and the request is signed by hand, so
 * the rest is about the signature being right and the secret never
 * leaving the process.
 */
import { readExpense, analyzeExpense } from './textract.js';
import { parseReceipt } from './receipt-parse.js';

let failures = 0;
const ok = (name, cond) => { if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const eq = (name, got, want) =>
  ok(name + (JSON.stringify(got) === JSON.stringify(want) ? '' : '  got ' + JSON.stringify(got)),
     JSON.stringify(got) === JSON.stringify(want));

const sf = (type, text, currency) => ({
  Type: { Text: type, Confidence: 99 },
  ValueDetection: { Text: text, Confidence: 99 },
  ...(currency ? { Currency: { Code: currency } } : {}),
});
const lf = (type, text) => ({ Type: { Text: type }, ValueDetection: { Text: text } });

const DOC = {
  SummaryFields: [
    sf('VENDOR_NAME', 'RALPHS'),
    sf('INVOICE_RECEIPT_DATE', '09/03/2026'),
    sf('INVOICE_RECEIPT_ID', '7781-2233-0091'),
    sf('TOTAL', '$12.47', 'USD'),
    sf('SUBTOTAL', '$11.48'),
    sf('TAX', '$0.99'),
  ],
  LineItemGroups: [
    { LineItemGroupIndex: 1, LineItems: [
      { LineItemExpenseFields: [
        /* The bleed, verbatim: a savings line above the product landed
           inside the product's own description. */
        lf('ITEM', 'You Just Saved $0\nBAREBELLE PROTEIN'),
        lf('PRICE', '2.99'),
        lf('EXPENSE_ROW', 'You Just Saved $0 BAREBELLE PROTEIN 2.99 F'),
      ] },
      { LineItemExpenseFields: [
        lf('ITEM', 'BARILLA PLUS PROTEIN'),
        lf('PRICE', '$3.49'),
        lf('QUANTITY', '2'),
        lf('PRODUCT_CODE', '076808002102'),
      ] },
      /* No ITEM at all — the row text is all there is. */
      { LineItemExpenseFields: [
        lf('EXPENSE_ROW', 'CHUNK LIGHT TUNA 1.29'),
        lf('PRICE', '1.29'),
      ] },
    ] },
  ],
  Blocks: [
    { BlockType: 'PAGE' },
    { BlockType: 'LINE', Text: 'RALPHS' },
    { BlockType: 'LINE', Text: 'BARILLA PLUS PROTEIN 3.49' },
    { BlockType: 'WORD', Text: 'ignored' },
  ],
};

console.log('\n--- reading the labelled fields ---');
{
  const r = readExpense(DOC);
  eq('the vendor',        r.store, 'RALPHS');
  eq('the total in cents', r.total_cents, 1247);
  eq('the subtotal',      r.subtotal_cents, 1148);
  eq('the tax',           r.tax_cents, 99);
  eq('the currency',      r.currency, 'USD');

  // Labelled, so nothing has to go hunting for it in the text.
  eq('the transaction id comes from its own field', r.txn, '7781-2233-0091');

  const d = new Date(r.purchased);
  ok('the date', d.getUTCFullYear() === 2026 && d.getUTCMonth() === 8 && d.getUTCDate() === 3);

  // Only LINE blocks, so the raw text reads like the receipt.
  eq('raw text is the lines it read', r.text, 'RALPHS\nBARILLA PLUS PROTEIN 3.49');
}

console.log('\n--- the line items ---');
{
  const r = readExpense(DOC);
  eq('three of them', r.items.length, 3);

  /* The whole point: the noise stays. The product name and its price are
     both present, which is all the matcher needs, and deciding which half
     is the product is the one thing that must not be guessed. */
  eq('a bled description is kept verbatim',
     r.items[0].text, 'You Just Saved $0 BAREBELLE PROTEIN');
  ok('and only its whitespace is touched', !r.items[0].text.includes('\n'));
  eq('with the right price anyway', r.items[0].cents, 299);

  eq('a clean one is unchanged', r.items[1].text, 'BARILLA PLUS PROTEIN');
  eq('a dollar sign does not break the price', r.items[1].cents, 349);
  eq('quantity is read',        r.items[1].qty, 2);
  eq('and the product code',    r.items[1].product_code, '076808002102');

  eq('a row with no ITEM falls back to the row text',
     r.items[2].text, 'CHUNK LIGHT TUNA 1.29');
  ok('a missing quantity is null, not zero', r.items[2].qty === null);
}

console.log('\n--- what the parser makes of it ---');
{
  const p = parseReceipt({ parsed: readExpense(DOC) });
  eq('it says which provider read it', p.source, 'textract');
  ok('nothing was reconstructed', p.reconstructed === false);
  eq('the transaction id survives, unmangled', p.txn, '7781-2233-0091');
  eq('the lines are the line items',
     p.lines.map((l) => l.text + '|' + l.cents),
     ['You Just Saved $0 BAREBELLE PROTEIN|299',
      'BARILLA PLUS PROTEIN|349',
      'CHUNK LIGHT TUNA 1.29|129']);
}

console.log('\n--- the signature ---');
{
  const real = globalThis.fetch;
  const SECRET = 'wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY';
  process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = SECRET;
  process.env.AWS_REGION = 'us-west-2';
  delete process.env.AWS_SESSION_TOKEN;

  let seen = null;
  globalThis.fetch = async (url, opts) => {
    seen = { url: String(url), opts };
    return { ok: true, status: 200, json: async () => ({ ExpenseDocuments: [DOC] }) };
  };

  const r = await analyzeExpense(Buffer.from('jpeg-ish'));
  eq('it round-trips', r.store, 'RALPHS');

  ok('it goes to the regional endpoint',
     seen.url === 'https://textract.us-west-2.amazonaws.com/');
  ok('with the operation named in the target header',
     seen.opts.headers['x-amz-target'] === 'Textract.AnalyzeExpense');
  ok('and the json-1.1 content type',
     seen.opts.headers['content-type'] === 'application/x-amz-json-1.1');
  ok('the document is base64 in Bytes',
     JSON.parse(seen.opts.body).Document.Bytes === Buffer.from('jpeg-ish').toString('base64'));
  ok('the request can be aborted', !!seen.opts.signal);

  const auth = seen.opts.headers.Authorization;
  ok('signed with SigV4', auth.startsWith('AWS4-HMAC-SHA256 '));
  ok('crediting the right key and scope',
     auth.includes('Credential=AKIAIOSFODNN7EXAMPLE/') &&
     auth.includes('/us-west-2/textract/aws4_request'));
  ok('over the headers it actually sent',
     auth.includes('SignedHeaders=content-type;host;x-amz-date;x-amz-target'));
  ok('and carries a signature', /Signature=[0-9a-f]{64}$/.test(auth));

  /* The one that matters: a signature proves the secret without
     transmitting it. If it ever appears in the request, it has leaked to
     every proxy and log between here and AWS. */
  const whole = seen.url + JSON.stringify(seen.opts.headers) + seen.opts.body;
  ok('the secret is nowhere in the request', !whole.includes(SECRET));

  /* Temporary credentials must be signed as well as sent, or AWS rejects
     the request as tampered with. */
  process.env.AWS_SESSION_TOKEN = 'FQoGZXIvYXdzEXAMPLETOKEN';
  await analyzeExpense(Buffer.from('x'));
  ok('a session token is sent',
     seen.opts.headers['x-amz-security-token'] === 'FQoGZXIvYXdzEXAMPLETOKEN');
  ok('and included in the signed headers',
     seen.opts.headers.Authorization.includes('x-amz-security-token'));
  delete process.env.AWS_SESSION_TOKEN;

  globalThis.fetch = real;
}

console.log('\n--- when it goes wrong ---');
{
  const real = globalThis.fetch;
  const say = async (fn) => { try { await fn(); return null; } catch (e){ return e.message; } };

  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({
    __type: 'com.amazon.textract#AccessDeniedException',
    Message: 'User is not authorized to perform: textract:AnalyzeExpense',
  }) });
  const denied = await say(() => analyzeExpense(Buffer.from('x')));
  ok('an IAM refusal says so', !!denied && denied.includes('AccessDeniedException'));
  ok('and quotes the reason', !!denied && denied.includes('not authorized'));

  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({
    __type: 'UnsupportedDocumentException', Message: 'Request has unsupported document format',
  }) });
  const bad = await say(() => analyzeExpense(Buffer.from('x')));
  ok('an unreadable document is named', !!bad && bad.includes('UnsupportedDocumentException'));

  globalThis.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const slow = await say(() => analyzeExpense(Buffer.from('x')));
  ok('a hang is reported as a timeout', !!slow && slow.includes('timed out'));

  globalThis.fetch = real;

  const savedId = process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_ACCESS_KEY_ID;
  const noKey = await say(() => analyzeExpense(Buffer.from('x')));
  ok('a missing key id is named', !!noKey && noKey.includes('AWS_ACCESS_KEY_ID'));
  process.env.AWS_ACCESS_KEY_ID = savedId;

  const big = await say(() => analyzeExpense(Buffer.alloc(11 * 1024 * 1024)));
  ok('an oversized document is refused before the call',
     !!big && big.includes('10MB'));
}

console.log('\n--- an empty read ---');
{
  const r = readExpense({ SummaryFields: [], LineItemGroups: [] });
  eq('nothing found is nothing claimed',
     [r.store, r.total_cents, r.txn, r.items.length], [null, null, null, 0]);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
