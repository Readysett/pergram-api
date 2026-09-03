/* The Vision adapter. Every case here is a way the first real call fails,
 * and the point of each is that the message says which one it was. */
import { ocr } from './ocr.js';

let failures = 0;
const ok = (name, cond) => { if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };

const real = globalThis.fetch;
let seen = null;                       // what the adapter sent
const stub = impl => { globalThis.fetch = async (url, opts) => { seen = { url, opts }; return impl(url, opts); }; };
const res  = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const img = Buffer.from('not really a jpeg');
const call = async () => {
  try { return { text: await ocr(img, { provider: 'google' }) }; }
  catch (e){ return { err: e.message }; }
};

process.env.GOOGLE_VISION_KEY = 'test-key';

console.log('\n--- what it sends ---');
{
  stub(() => res(200, { responses: [{ fullTextAnnotation: { text: 'WHOLE FOODS\nTUNA 3.49' } }] }));
  const r = await call();
  ok('text comes back',                r.text === 'WHOLE FOODS\nTUNA 3.49');
  ok('the key is not in the URL',      !String(seen.url).includes('test-key'));
  ok('it is in the header instead',    seen.opts.headers['X-Goog-Api-Key'] === 'test-key');
  ok('and the request can be aborted', !!seen.opts.signal);
}

console.log('\n--- failures Vision reports inside a 200 ---');
{
  stub(() => res(200, { responses: [{ error: {
    code: 7, message: 'This API method requires billing to be enabled.' } }] }));
  const r = await call();
  ok('billing is named, not guessed at',
     !!r.err && r.err.includes('billing to be enabled'));
  ok('and not reported as an empty photograph',
     !!r.err && !r.err.includes('no text'));
}
{
  stub(() => res(200, { responses: [{ error: { code: 8, message: 'Quota exceeded.' } }] }));
  const r = await call();
  ok('quota is named too', !!r.err && r.err.includes('Quota exceeded'));
}

console.log('\n--- failures reported as HTTP errors ---');
{
  stub(() => res(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }));
  const r = await call();
  ok('a bad key says so',
     !!r.err && r.err.includes('API key not valid'));
  ok('rather than only its status code',
     !!r.err && !/^vision HTTP/.test(r.err));
}
{
  stub(() => res(503, null));
  const r = await call();
  ok('a body-less failure still reports the status', r.err === 'vision HTTP 503');
}

console.log('\n--- the rest ---');
{
  stub(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  const r = await call();
  ok('a hang is reported as a timeout', !!r.err && r.err.includes('timed out'));
}
{
  stub(() => res(200, { responses: [{}] }));
  const r = await call();
  ok('a genuinely blank image says so', !!r.err && r.err.includes('no text'));
}
{
  const big = Buffer.alloc(8 * 1024 * 1024);
  let err = null;
  try { await ocr(big, { provider: 'google' }); } catch (e){ err = e.message; }
  ok('an oversized image is refused before the call',
     !!err && err.includes('7MB') && err.includes('8.0MB'));
}
{
  delete process.env.GOOGLE_VISION_KEY;
  const r = await call();
  ok('a missing key is named', !!r.err && r.err.includes('GOOGLE_VISION_KEY'));
  process.env.GOOGLE_VISION_KEY = 'test-key';
}

console.log('\n--- the fake adapter is untouched ---');
{
  const t = await ocr(img);
  ok('still returns the fixture offline', t.includes('WHOLE FOODS MARKET'));
}

globalThis.fetch = real;
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
