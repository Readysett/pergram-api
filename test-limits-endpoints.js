/* Rate limits on the endpoints that cost something.
 *
 * The rule the asserts encode: a refusal happens before the expensive
 * work, and the two dimensions do not share a bucket.
 *
 *   node test-limits-endpoints.js
 */
import { rateLimit, clientIp, __resetLimits, __bucketCount } from './rate-limit.js';

let failures = 0;
const ok = (name, cond) => { if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const eq = (name, got, want) =>
  ok(name + '  (' + JSON.stringify(got) + ')', JSON.stringify(got) === JSON.stringify(want));

/* Minimal express-shaped doubles. Enough to drive middleware and see
   what it did, without standing up a server or a socket. */
function makeRes(){
  const res = { statusCode: null, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
}
const makeReq = (ip, wallet) => ({
  headers: ip ? { 'x-real-ip': ip } : {},
  socket: {}, wallet,
});

/* Run a middleware chain the way express would: each next() advances,
   and a response short-circuits the rest. Returns how far it got. */
function run(chain, req){
  const res = makeRes();
  let i = 0;
  const next = () => { i++; if (i < chain.length) chain[i](req, res, next); };
  if (chain.length) chain[0](req, res, next);
  return { res, reached: i };
}

__resetLimits();

console.log('\n--- a limit refuses once the window is spent ---');
{
  const limit = rateLimit({ name:'t-ip', windowMs: 60_000, max: 3, key: clientIp });
  const req = makeReq('1.2.3.4');
  let last;
  for (let n = 0; n < 3; n++) last = run([limit, (q,s,nx) => nx()], req);
  eq('the first three pass', last.res.statusCode, null);

  const over = run([limit, (q,s,nx) => nx()], req);
  eq('the fourth is refused', over.res.statusCode, 429);
  eq('with a flat message that maps nothing', over.res.body, { ok:false, error:'too many requests' });
  ok('and a Retry-After the caller can honour', Number(over.res.headers['retry-after']) > 0);
}

console.log('\n--- the two dimensions are independent ---');
{
  __resetLimits();
  const byIp     = rateLimit({ name:'t2-ip', windowMs: 60_000, max: 2, key: clientIp });
  const byWallet = rateLimit({ name:'t2-w',  windowMs: 60_000, max: 5,
                               key: r => r.wallet || '' });

  /* One address, two wallets: the per-IP limit still bites, which is the
     point — wallets are free, addresses are not. */
  const a = makeReq('9.9.9.9', '0xaaa');
  const b = makeReq('9.9.9.9', '0xbbb');
  run([byWallet, byIp, (q,s,nx) => nx()], a);
  run([byWallet, byIp, (q,s,nx) => nx()], b);
  const third = run([byWallet, byIp, (q,s,nx) => nx()], a);
  eq('a rotated wallet does not buy a fresh IP budget', third.res.statusCode, 429);

  /* A different address is a different bucket. */
  const elsewhere = run([byWallet, byIp, (q,s,nx) => nx()], makeReq('8.8.8.8', '0xccc'));
  eq('and an unrelated caller is unaffected', elsewhere.res.statusCode, null);
}

console.log('\n--- a refused receipt never reaches the upload ---');
{
  __resetLimits();
  const byWallet = rateLimit({ name:'t3-w', windowMs: 60_000, max: 1,
                               key: r => r.wallet || '' });

  let uploadRan = 0;
  const upload  = (q, s, nx) => { uploadRan++; nx(); };
  const handler = (q, s) => s.status(200).json({ ok:true });

  /* requireAuth is nearly free; multer buffers up to six megabytes and
     the OCR behind it is a paid call. The order is the whole point. */
  const auth  = (q, s, nx) => { q.wallet = '0xdead'; nx(); };
  const chain = [auth, byWallet, upload, handler];

  const first = run(chain, makeReq('5.5.5.5'));
  eq('the first is served', first.res.statusCode, 200);
  eq('and parsed its body once', uploadRan, 1);

  const second = run(chain, makeReq('5.5.5.5'));
  eq('the second is refused', second.res.statusCode, 429);
  eq('without buffering the image', uploadRan, 1);
}

console.log('\n--- an unkeyable request is not silently exempt ---');
{
  __resetLimits();
  /* clientIp falls back to the socket address rather than returning
     empty, so a proxy that drops x-real-ip over-limits instead of
     disabling the limit. An absent limit is invisible; an outage is not. */
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.7' } };
  eq('the fallback still yields a key', clientIp(req), '10.0.0.7');

  const limit = rateLimit({ name:'t4', windowMs: 60_000, max: 1, key: clientIp });
  run([limit, (q,s,nx) => nx()], req);
  const over = run([limit, (q,s,nx) => nx()], req);
  eq('so the limit still fires', over.res.statusCode, 429);
}

console.log('\n--- the real endpoint wiring ---');
{
  /* Loading server.js proves the limits are defined before the routes
     that use them. They are const, so a route referencing one declared
     further down throws at import — a crash at boot, not at request
     time, which on a host with a restart policy means the previous build
     keeps serving and the deploy looks fine from outside. */
  process.env.DB_PATH ||= './test-limits-endpoints.db';
  process.env.PORT = '0';           // ephemeral: never collide with a real instance
  let booted = true, why = null;
  try { await import('./server.js'); } catch (e){ booted = false; why = e.message; }
  ok('server.js imports with every limit in scope' + (why ? ' — ' + why : ''), booted);
}

console.log('\n--- expired buckets are swept ---');
{
  __resetLimits();
  const limit = rateLimit({ name:'t5', windowMs: 1, max: 1, key: clientIp });
  run([limit, (q,s,nx) => nx()], makeReq('4.4.4.4'));
  ok('a bucket exists', __bucketCount() > 0);
  const { sweepLimits } = await import('./rate-limit.js');
  await new Promise(r => setTimeout(r, 5));
  sweepLimits();
  eq('and is gone once its window passes', __bucketCount(), 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
