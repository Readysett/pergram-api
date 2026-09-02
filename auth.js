import { randomBytes, createHash } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { Certificate } from '@vechain/sdk-core';
import { db, now, ensureWallet } from './db.js';

/* Proving a caller controls a wallet.
 *
 * Without this, /api/claim accepts any wallet address from anyone — you
 * could farm rewards into someone else's account, or theirs into yours.
 * Nothing else in the backend matters until this exists.
 *
 * The scheme is a challenge-response:
 *   1. Client asks for a nonce for its address.
 *   2. Client signs the message with its wallet.
 *   3. Client sends the signature; the server recovers the address from
 *      it and compares. Only the holder of the private key can produce a
 *      signature that recovers to their address.
 *
 * A nonce is single-use and short-lived, so a captured signature cannot
 * be replayed. Sessions are stored as a hash: a leaked database should
 * not hand an attacker working tokens.
 */

const NONCE_TTL_MS   = 5 * 60 * 1000;        // long enough to approve in a wallet
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

db.exec(`
CREATE TABLE IF NOT EXISTS nonce (
  value      TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used       INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY,   -- sha256 of the token, never the token
  wallet     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS session_by_wallet ON session(wallet);
`);

const sha = s => createHash('sha256').update(String(s)).digest('hex');
const normalise = a => String(a || '').toLowerCase();

/** Step 1 — issue a challenge the client must sign. */
export function createNonce(wallet){
  const addr = normalise(wallet);
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return null;

  const value = randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO nonce (value, wallet, created_at) VALUES (?,?,?)`)
    .run(value, addr, now());

  /* The message states plainly what signing does. A wallet prompt that
     says only "sign this hex" trains people to approve anything. */
  const message =
    `Per Gram — prove you control this wallet.\n\n` +
    `Wallet: ${addr}\n` +
    `Nonce: ${value}\n\n` +
    `Signing costs nothing and authorises no transaction.`;

  return { nonce: value, message, expires_in_ms: NONCE_TTL_MS };
}

/** Step 2 — verify the certificate and open a session.
 *
 * VeChain wallets sign *certificates*, not Ethereum personal_sign
 * messages. A certificate carries its own signer address, so the check
 * is: does the signature actually cover this payload, and does the
 * content contain the challenge the client claims to have generated?
 *
 * Verifying the signature alone would not be enough — a captured
 * certificate could be replayed forever. Binding it to a single-use
 * challenge is what stops that.
 */
export function verifySignature({ wallet, nonce, signature, challenge, certificate }){
  const no = { ok: false, error: 'could not verify that signature' };

  /* Path A: VeChain certificate. */
  if (certificate){
    if (!challenge || typeof challenge !== 'string') return no;

    const content = certificate.payload && certificate.payload.content;
    if (!content || !content.includes(challenge)) return no;

    /* The challenge must be unused. Recording it on first sight makes a
       replayed certificate worthless even though it stays valid. */
    const seen = db.prepare(`SELECT value FROM nonce WHERE value = ?`).get(challenge);
    if (seen) return no;

    /* A certificate signed a week ago should not open a session today. */
    const ts = Number(certificate.timestamp) * 1000;
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > 10 * 60 * 1000) return no;

    let signer;
    try {
      const cert = Certificate.of(certificate);
      cert.verify();                       // throws if the signature does not match
      signer = normalise(certificate.signer);
    } catch (e){
      return no;
    }
    if (!/^0x[0-9a-f]{40}$/.test(signer)) return no;

    db.prepare(`INSERT INTO nonce (value, wallet, created_at, used) VALUES (?,?,?,1)`)
      .run(challenge, signer, now());

    return openSession(signer);
  }

  /* Path B: Ethereum-style personal_sign, kept for wallets that offer it. */
  const addr = normalise(wallet);
  const row = db.prepare(`SELECT * FROM nonce WHERE value = ?`).get(String(nonce || ''));

  if (!row) return no;
  if (row.used) return no;
  if (row.wallet !== addr) return no;
  if (now() - row.created_at > NONCE_TTL_MS) return no;

  const message =
    `Per Gram — prove you control this wallet.\n\n` +
    `Wallet: ${addr}\n` +
    `Nonce: ${nonce}\n\n` +
    `Signing costs nothing and authorises no transaction.`;

  let recovered;
  try {
    recovered = normalise(verifyMessage(message, signature));
  } catch (e){
    return no;
  }
  if (recovered !== addr) return no;

  db.prepare(`UPDATE nonce SET used = 1 WHERE value = ?`).run(nonce);
  return openSession(addr);
}

function openSession(addr){
  const token = randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO session (token_hash, wallet, created_at, expires_at) VALUES (?,?,?,?)`)
    .run(sha(token), addr, now(), now() + SESSION_TTL_MS);
  ensureWallet(addr);
  return { ok: true, token, wallet: addr, expires_at: now() + SESSION_TTL_MS };
}

export function walletForToken(token){
  if (!token) return null;
  const s = db.prepare(`SELECT * FROM session WHERE token_hash = ?`).get(sha(token));
  if (!s || s.revoked || s.expires_at < now()) return null;
  return s.wallet;
}

export function revoke(token){
  db.prepare(`UPDATE session SET revoked = 1 WHERE token_hash = ?`).run(sha(token));
}

/**
 * Express middleware. Attaches req.wallet, or refuses.
 *
 * Note it does not read a wallet from the body at all. Taking the address
 * from the request and merely checking a token exists would leave the
 * original hole open — the wallet must come from the session.
 */
export function requireAuth(req, res, next){
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  const wallet = walletForToken(token);
  if (!wallet) return res.status(401).json({ ok: false, error: 'not signed in' });
  req.wallet = wallet;
  next();
}

/* Housekeeping: expired nonces and sessions are noise, and a growing
   nonce table is a slow leak. */
export function sweep(){
  db.prepare(`DELETE FROM nonce   WHERE created_at < ?`).run(now() - NONCE_TTL_MS * 2);
  db.prepare(`DELETE FROM session WHERE expires_at < ?`).run(now());
}
