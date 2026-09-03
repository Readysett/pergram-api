import express from 'express';
import multer from 'multer';
import { ocr, imageHash } from './ocr.js';
import { parseReceipt, matchProduct, resolveQuantity } from './receipt-parse.js';
import { receiptKey } from './claims.js';
import { db, currentRound, ensureWallet, now } from './db.js';
import { submitClaim, weekTotals, WEEKLY_CAP_G } from './claims.js';
import { isPerson } from './passport.js';
import { createNonce, verifySignature, requireAuth, requireAdmin, revoke, sweep } from './auth.js';
import { rateLimit, sweepLimits, clientIp } from './rate-limit.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

/* The app is served from a different origin to this API, so without CORS
   the browser blocks every call before it leaves the page — and it looks
   to the user exactly like the server being down. An explicit allowlist
   rather than a wildcard: credentials travel on these requests. */
const ALLOWED = (process.env.ALLOWED_ORIGINS ||
  'https://pergram.vercel.app,http://localhost:5173,http://localhost:3000,http://127.0.0.1:5500')
  .split(',').map(s => s.trim());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)){
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, round: currentRound().id });
});

/* Personhood, surfaced so the app can tell a user why they cannot claim
   before they photograph a receipt — not after. */
app.get('/api/passport/:wallet', async (req, res) => {
  ensureWallet(req.params.wallet);
  res.json(await isPerson(req.params.wallet));
});

/* ---------- auth ---------- */

/* Issuing a nonce is a database write that anyone can ask for, against
   any address, without proving anything. Two limits rather than one: the
   per-IP limit is what stops a flood, and the per-wallet limit is what
   stops one address being targeted from many places.
 *
 * The numbers are set for what signing in actually looks like — one
 * nonce, occasionally a retry. Twenty a minute per IP leaves room for a
 * shared network; five a minute per wallet leaves room for a person
 * fumbling a wallet prompt, and no room for anything else. */
const nonceByIp = rateLimit({
  name: 'nonce-ip', windowMs: 60_000, max: 20,
  key: clientIp,
});
const nonceByWallet = rateLimit({
  name: 'nonce-wallet', windowMs: 60_000, max: 5,
  key: req => String((req.body || {}).wallet || '').toLowerCase(),
});

app.post('/api/auth/nonce', nonceByIp, nonceByWallet, (req, res) => {
  const out = createNonce((req.body || {}).wallet);
  if (!out) return res.status(400).json({ ok:false, error:'bad wallet address' });
  res.json({ ok:true, ...out });
});

/* Verifying costs real work — a signature recovery, and for a
   certificate a hash of the whole payload before it. That makes this the
   more attractive of the two auth endpoints to point a machine at: a
   nonce is a row, this is CPU, and neither needs a session first.
 *
 * Keyed on the address only. There is no wallet to key on for a
 * certificate — the signer is inside the signature, and reading it out
 * before verifying would mean trusting the thing under test. Nothing is
 * written here either, so there is no per-wallet resource to protect;
 * the nonce limit already covers being targeted by address.
 *
 * Ten a minute against one nonce a sign-in: room to fumble a wallet
 * prompt several times, none to grind.  */
const verifyByIp = rateLimit({
  name: 'verify-ip', windowMs: 60_000, max: 10,
  key: clientIp,
});

app.post('/api/auth/verify', verifyByIp, (req, res) => {
  const out = verifySignature(req.body || {});
  res.status(out.ok ? 200 : 401).json(out);
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  revoke((req.headers.authorization || '').slice(7));
  res.json({ ok:true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  res.json({ ok:true, wallet: req.wallet, passport: await isPerson(req.wallet) });
});

/* The wallet comes from the session, never the body. Trusting a body
   field while merely checking a token exists would leave the original
   hole wide open. */
app.post('/api/claim', requireAuth, async (req, res) => {
  try {
    const out = await submitClaim({ ...(req.body || {}), wallet: req.wallet });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (e){
    console.error(e);
    res.status(500).json({ ok:false, error:'claim failed' });
  }
});

app.get('/api/week', requireAuth, (req, res) => {
  const round = currentRound();
  const t = weekTotals(req.wallet, round.id);
  const claims = db.prepare(`
    SELECT product, source_key, protein_g, points, co2_kg, created_at
    FROM claim WHERE wallet=? AND round_id=? ORDER BY created_at DESC
  `).all(req.wallet, round.id);

  res.json({
    round: round.id,
    closes_at: round.closes_at,
    cap_g: WEEKLY_CAP_G,
    protein_g: t.protein,
    counted_g: Math.min(t.protein, WEEKLY_CAP_G),
    points_raw: t.points,
    co2_kg: t.co2,
    over_cap: t.protein > WEEKLY_CAP_G,
    claims,
  });
});

/* A user saying "this looks wrong" is the only thing that finds the long
   tail of brand names. Cheap to collect, expensive to replace. */
/* Flagging stays open: a misclassification report is useful whether or
   not the reporter has signed in, and there is nothing to gain by
   faking one. */
app.post('/api/flag', (req, res) => {
  const { barcode, wallet, said, note } = req.body || {};
  if (!barcode) return res.status(400).json({ ok:false, error:'barcode required' });
  db.prepare(`INSERT INTO flag (barcode, wallet, said, note, created_at) VALUES (?,?,?,?,?)`)
    .run(String(barcode), wallet ? String(wallet).toLowerCase() : null, said || null, note || null, now());
  res.json({ ok:true });
});

/* The review queue is every signal the anti-fraud heuristics have
   raised: which wallets look like farms, and why. Open, it is a map of
   what the checks notice and therefore what to avoid doing. */
app.get('/api/review', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT * FROM review WHERE cleared=0 ORDER BY created_at DESC LIMIT 200`).all());
});

/* ---------- receipt upload ----------
 *
 * Deliberately two steps. This endpoint reads the receipt and reports
 * what it found; it does not create a claim. The user confirms the match
 * before anything is claimed, because an OCR misread that silently pays
 * is worse than one the user can correct.
 *
 * The caller supplies the products they already scanned. The receipt
 * only has to confirm a matching line and supply the quantity — matching
 * a known name against candidate lines is a far smaller problem than
 * reading receipt lines cold.
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.post('/api/receipt', requireAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'no image' });

    const text   = await ocr(req.file.buffer);
    const parsed = parseReceipt(text);
    const img    = imageHash(req.file.buffer);

    /* Without a transaction id the receipt cannot be identified by what
       it records, only by the pixels — which a re-photograph defeats.
       Say so rather than pretending the claim is as well protected. */
    const weakIdentity = !parsed.txn;

    const key = receiptKey({
      store: parsed.store, txn: parsed.txn,
      purchased: parsed.purchased || Date.now(),
      total_cents: parsed.total_cents, image_hash: img,
    });

    const already = db.prepare(`SELECT wallet FROM receipt WHERE key=?`).get(key);

    let scanned = [];
    try { scanned = JSON.parse(req.body.scanned || '[]'); } catch(e){}

    const matches = scanned.map(p => {
      const line = matchProduct(p.name || '', parsed.lines);
      const q    = resolveQuantity({ line, quantity: p.quantity, productName: p.name });
      return {
        barcode: p.barcode, name: p.name,
        matched: !!line,
        line: line ? line.text : null,
        score: line ? line.score : 0,
        count: q.count,
        pack:  q.pack,
        grams: q.grams,
        ask:   q.ask,
        protein_g: (q.grams && p.protein100) ? +(q.grams * p.protein100 / 100).toFixed(1) : null,
      };
    });

    res.json({
      ok: true,
      already_claimed: !!already,
      weak_identity: weakIdentity,
      receipt: {
        store: parsed.store,
        purchased: parsed.purchased,
        total_cents: parsed.total_cents,
        txn: parsed.txn,
        image_hash: img,
      },
      lines: parsed.lines,
      matches,
      note: 'Nothing has been claimed. Confirm the matches, then POST /api/claim.',
    });
  } catch (e){
    console.error(e);
    res.status(500).json({ ok:false, error:'could not read that receipt' });
  }
});

setInterval(sweep, 3600 * 1000).unref();

/* More often than the nonce sweep: these expire in a minute, and a
   caller rotating addresses would otherwise grow the map between
   passes. */
setInterval(sweepLimits, 60 * 1000).unref();

const port = process.env.PORT || 8787;
app.listen(port, () => console.log('Per Gram API on http://localhost:' + port));
