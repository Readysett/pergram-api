import express from 'express';
import multer from 'multer';
import { ocr, imageHash } from './ocr.js';
import { parseReceipt, matchProduct, resolveQuantity } from './receipt-parse.js';
import { db, currentRound, ensureWallet, now, claimWindowDays } from './db.js';
import { submitClaim, weekTotals, scanReceipt, sweepScans, receiptKey, WEEKLY_CAP_G } from './claims.js';
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

/* ---------- limits on the endpoints that cost something ----------
 *
 * Two dimensions on each, for the reason the auth limits have two: the
 * per-IP limit is what bounds a flood, and the per-wallet limit is what
 * shapes one account.
 *
 * Of the two, the per-IP limit is the one doing the real work here.
 * Personhood gates CLAIMING, not reading: /api/receipt needs only a
 * signed-in wallet, and wallets are free, so a per-wallet limit is
 * bypassed by rotating addresses. A per-wallet limit still earns its
 * place — it stops one real account running away with the OCR budget by
 * accident — but it is not the control that stops a determined caller.
 *
 * Numbers are env-tunable because the right value depends on the OCR
 * bill and on how many people share an address, and neither is knowable
 * from here. The defaults are set for what a real shop looks like: a
 * receipt or three, plus room to retry a bad photograph several times.
 */
const env = (name, fallback) => Number(process.env[name] || fallback);

/* The expensive one. Every call is an OCR request against a paid API
   plus up to MAX_SCAN_BARCODES lookups against Open Food Facts, who
   rate-limit us in turn and would be within their rights to block us. */
const receiptByIp = rateLimit({
  name: 'receipt-ip', windowMs: 3600_000, max: env('RL_RECEIPT_IP', 40),
  key: clientIp,
});
const receiptByWallet = rateLimit({
  name: 'receipt-wallet', windowMs: 3600_000, max: env('RL_RECEIPT_WALLET', 15),
  key: req => req.wallet || '',
});

/* Claiming is cheaper — no OCR, and the products are usually cached by
   the time it runs — so this is set well above what a person does. A
   lookup that does not settle returns a retryable refusal and the app
   tells the user to try again, so a tight limit here would punish the
   retry the server itself asked for. */
const claimByIp = rateLimit({
  name: 'claim-ip', windowMs: 3600_000, max: env('RL_CLAIM_IP', 200),
  key: clientIp,
});
const claimByWallet = rateLimit({
  name: 'claim-wallet', windowMs: 3600_000, max: env('RL_CLAIM_WALLET', 60),
  key: req => req.wallet || '',
});

/* Open endpoints. Neither needs a session, and both cost something on
   every call — a row in one case, a write plus a call out to a Thor node
   in the other. An unauthenticated endpoint that writes is the most
   exposed thing here, whatever it writes. */
const flagByIp = rateLimit({
  name: 'flag-ip', windowMs: 3600_000, max: env('RL_FLAG_IP', 60),
  key: clientIp,
});
const passportByIp = rateLimit({
  name: 'passport-ip', windowMs: 3600_000, max: env('RL_PASSPORT_IP', 120),
  key: clientIp,
});

/* Personhood, surfaced so the app can tell a user why they cannot claim
   before they photograph a receipt — not after. */
app.get('/api/passport/:wallet', passportByIp, async (req, res) => {
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
   hole wide open.
 *
 * The body carries a scan id and a list of barcodes — nothing else that
 * bears on the reward. Only scan_id and items are forwarded, so a client
 * that keeps sending protein_g, mult or co2 is not merely disbelieved:
 * the fields do not reach the claim logic at all. */
app.post('/api/claim', requireAuth, claimByWallet, claimByIp, async (req, res) => {
  try {
    const { scan_id, items } = req.body || {};
    const out = await submitClaim({ wallet: req.wallet, scan_id, items });
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

    /* So the app can say how old a receipt may be without hardcoding a
       number that is a property of the round, not of the client. */
    claim_window_days: claimWindowDays(round),
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
app.post('/api/flag', flagByIp, (req, res) => {
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
 * The caller supplies the barcodes it scanned, and nothing else about
 * them. The name and pack size used for matching are read from the
 * server's own product cache, because matching on a client-supplied name
 * lets a cheap barcode be bound to an expensive line.
 *
 * What it finds is recorded as a scan, and /api/claim prices from that
 * record. Before this the quantity was resolved correctly here and then
 * discarded, which left the claim endpoint with no matched line to take
 * a quantity from.
 */
/* Six, not eight. Vision caps a JSON request at 10MB and base64 inflates
   by a third, so anything past about 7.5MB cannot be sent inline at all.
   The client downscales before uploading; this is the backstop for
   anything that does not. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });

/* The limits sit between the session check and the upload on purpose:
   requireAuth reads a header and is nearly free, but multer buffers up
   to six megabytes before the handler sees anything. A refused request
   should not pay for that, let alone for the OCR behind it. */
app.post('/api/receipt', requireAuth, receiptByWallet, receiptByIp,
         upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'no image' });

    const read   = await ocr(req.file.buffer, { mimeType: req.file.mimetype });
    const parsed = parseReceipt(read);
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

    /* Barcodes only. Anything else the client sends about a product is
       not validated and then used — it is never read. */
    let barcodes = [];
    try {
      barcodes = JSON.parse(req.body.scanned || '[]')
        .map(p => String((p && p.barcode !== undefined) ? p.barcode : p));
    } catch(e){}

    const { scan_id: scanId, matches, unavailable } = await scanReceipt({
      wallet: req.wallet,
      roundId: currentRound().id,
      parsed,
      image_hash: img,
      barcodes,
    });

    res.json({
      ok: true,
      scan_id: scanId,
      already_claimed: !!already,

      /* Barcodes whose lookup did not settle. Not an error for the
         receipt as a whole — the read is still worth showing — but
         nothing on this list can be claimed until it resolves. */
      unavailable,
      weak_identity: weakIdentity,
      receipt: {
        store: parsed.store,
        purchased: parsed.purchased,
        total_cents: parsed.total_cents,
        txn: parsed.txn,
        image_hash: img,
      },
      lines: parsed.lines,

      /* The text as it was read, and every line that did not survive
         extraction. This is the caller's own receipt being handed back to
         them, and without it a wrong date, a missed total or a product
         that failed to match are all indistinguishable from each other:
         the parse can only be argued with if what it parsed is visible. */
      raw: parsed.raw,

      /* TEMPORARY, with the panel that shows it: where every word was.
         Whether a row was joined correctly is a question about geometry,
         and it cannot be answered from the text the geometry produced. */
      words: read.words || null,

      rows: parsed.rows,
      reconstructed: parsed.reconstructed,
      source: parsed.source,
      geometry: parsed.geometry,
      dropped: parsed.dropped,

      matches,
      note: 'Nothing has been claimed. Confirm the matches, then POST /api/claim with this scan_id and the barcodes to claim.',
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

/* Scans are short-lived by design; expired ones are not evidence of
   anything and should not accumulate. */
setInterval(sweepScans, 600 * 1000).unref();

const port = process.env.PORT || 8787;
app.listen(port, () => console.log('Per Gram API on http://localhost:' + port));
