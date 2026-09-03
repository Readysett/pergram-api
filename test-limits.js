/* Limits and the admin door. Each one is a way in that used to be open. */
import { requireAdmin } from './auth.js';
import { rateLimit, sweepLimits, __resetLimits, __bucketCount } from './rate-limit.js';

let failures = 0;
const ok = (name, cond) => { if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };

/* Enough of express's req/res to exercise middleware. */
const mkRes = () => {
  const r = { code: null, body: null, headers: {} };
  r.status = c => { r.code = c; return r; };
  r.json   = b => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  return r;
};
const run = (mw, req) => {
  const res = mkRes();
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { passed, res };
};

const GOOD = 'a'.repeat(40);

console.log('\n--- the review queue ---');
{
  delete process.env.ADMIN_TOKEN;
  ok('no secret configured, so nobody gets in',
     !run(requireAdmin, { headers: { 'x-admin-token': GOOD } }).passed);

  process.env.ADMIN_TOKEN = 'short';
  ok('a secret too short to be one is refused',
     !run(requireAdmin, { headers: { 'x-admin-token': 'short' } }).passed);

  process.env.ADMIN_TOKEN = GOOD;
  ok('the right secret gets in',      run(requireAdmin, { headers: { 'x-admin-token': GOOD } }).passed);
  ok('a wrong secret does not',      !run(requireAdmin, { headers: { 'x-admin-token': 'b'.repeat(40) } }).passed);
  ok('a prefix of it does not',      !run(requireAdmin, { headers: { 'x-admin-token': 'a'.repeat(39) } }).passed);
  ok('no header at all does not',    !run(requireAdmin, { headers: {} }).passed);

  const r = run(requireAdmin, { headers: {} }).res;
  ok('and the refusal says nothing useful',
     r.code === 401 && r.body.error === 'not authorised');
}

console.log('\n--- rate limiting ---');
{
  __resetLimits();
  const mw = rateLimit({ name: 't', windowMs: 60_000, max: 3, key: req => req.ip });

  const a = { ip: '1.1.1.1' };
  ok('first three allowed', [1,2,3].every(() => run(mw, a).passed));

  const blocked = run(mw, a);
  ok('the fourth is refused',        !blocked.passed);
  ok('with 429 and a flat message',   blocked.res.code === 429 && blocked.res.body.error === 'too many requests');
  ok('and says when to come back',    Number(blocked.res.headers['retry-after']) > 0);

  ok('a different caller is unaffected', run(mw, { ip: '2.2.2.2' }).passed);
}

console.log('\n--- the shape of the two nonce limits ---');
{
  __resetLimits();
  const byIp     = rateLimit({ name:'ip', windowMs: 60_000, max: 20, key: r => r.ip });
  const byWallet = rateLimit({ name:'w',  windowMs: 60_000, max: 5,
                              key: r => String((r.body || {}).wallet || '').toLowerCase() });

  /* One address hammered from many places is caught by the wallet limit
     even though no single IP is near its own. */
  const w = '0x' + '1'.repeat(40);
  let stopped = 0;
  for (let i = 0; i < 8; i++){
    const req = { ip: '10.0.0.' + i, body: { wallet: w } };
    if (run(byIp, req).passed && !run(byWallet, req).passed) stopped++;
  }
  ok('one wallet from eight addresses is still stopped', stopped === 3);

  /* Case is not a way around it. */
  __resetLimits();
  const mixed = [w, w.toUpperCase(), w, w.toUpperCase(), w, w];
  let blocked = 0;
  for (const addr of mixed){
    if (!run(byWallet, { ip:'1.1.1.1', body:{ wallet: addr } }).passed) blocked++;
  }
  ok('upper and lower case share a bucket', blocked === 1);

  /* A request with no wallet is left to its own validation, not counted
     against an empty key that every such request would share. */
  __resetLimits();
  ok('a missing wallet is not a bucket',
     [1,2,3,4,5,6,7].every(() => run(byWallet, { ip:'1.1.1.1', body:{} }).passed));
}

console.log('\n--- housekeeping ---');
{
  __resetLimits();
  const mw = rateLimit({ name:'s', windowMs: 40, max: 1, key: r => r.ip });
  run(mw, { ip: '9.9.9.9' });
  ok('a bucket is held', __bucketCount() === 1);

  await new Promise(r => setTimeout(r, 60));
  sweepLimits();
  ok('and dropped once its window has passed', __bucketCount() === 0);

  ok('so the caller starts clean', run(mw, { ip: '9.9.9.9' }).passed);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
