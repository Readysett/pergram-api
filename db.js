import { DatabaseSync } from 'node:sqlite';

/* Schema mirrors the claim state machine. The important columns are the
   constraints, not the data: receipt_key is unique so the same receipt
   cannot be claimed twice by anyone, and (wallet, round_id) is what the
   weekly cap is computed over. */

/* On a host like Railway the filesystem is ephemeral: every redeploy
   wipes it. DB_PATH must point at a mounted volume in production, or
   users lose their claims on each push. Fail loudly rather than silently
   writing to disk that is about to vanish. */
const DB_PATH = process.env.DB_PATH || './pergram.db';
if (process.env.NODE_ENV === 'production' && DB_PATH.startsWith('./')){
  console.warn(
    '\n  WARNING: DB_PATH is a relative path in production.\n' +
    '  On an ephemeral filesystem this database is lost on every deploy.\n' +
    '  Mount a volume and set DB_PATH to a path inside it, e.g. /data/pergram.db\n');
}

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS wallet (
  address        TEXT PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  passport_ok    INTEGER,          -- last personhood result, 0/1, null = unchecked
  passport_at    INTEGER,          -- when we last checked
  passport_note  TEXT,
  suspended      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS round (
  id         INTEGER PRIMARY KEY,
  opens_at   INTEGER NOT NULL,
  closes_at  INTEGER NOT NULL,
  pool_b3tr  REAL,                 -- known only once the DAO allocates
  state      TEXT NOT NULL DEFAULT 'open'   -- open | settling | paid
);

CREATE TABLE IF NOT EXISTS receipt (
  key         TEXT PRIMARY KEY,    -- sha256(store|txn|date|total) — the anti-replay control
  wallet      TEXT NOT NULL,
  store       TEXT,
  txn         TEXT,
  purchased   INTEGER,             -- epoch ms of the purchase, not the upload
  total_cents INTEGER,
  image_hash  TEXT,                -- fallback identity when txn is unreadable
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (wallet) REFERENCES wallet(address)
);

CREATE TABLE IF NOT EXISTS claim (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet      TEXT NOT NULL,
  round_id    INTEGER NOT NULL,
  receipt_key TEXT NOT NULL,
  barcode     TEXT NOT NULL,
  product     TEXT,
  source_key  TEXT NOT NULL,       -- whey, cheese, pea …
  protein_g   REAL NOT NULL,
  co2_kg      REAL NOT NULL,
  mult        REAL NOT NULL,
  points      REAL NOT NULL,
  state       TEXT NOT NULL DEFAULT 'verified',  -- verified | rejected | settled | paid
  reject      TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (receipt_key, barcode),   -- one line item per receipt, claimed once
  FOREIGN KEY (wallet) REFERENCES wallet(address)
);

CREATE INDEX IF NOT EXISTS claim_by_round  ON claim(round_id, wallet);
CREATE INDEX IF NOT EXISTS claim_by_wallet ON claim(wallet, created_at);

/* Barcode classifications are cached rather than read live. Open Food
   Facts is a wiki: if payouts depended on live reads, editing the
   database would be an attack. A cached row is also where a user's
   "this looks wrong" correction lands. */
CREATE TABLE IF NOT EXISTS product_cache (
  barcode      TEXT PRIMARY KEY,
  name         TEXT,
  brands       TEXT,
  protein_100g REAL,
  source_key   TEXT,
  co2          REAL,
  mult         REAL,
  locked       INTEGER DEFAULT 0,  -- 1 = human-reviewed, never auto-overwritten
  fetched_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS flag (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode    TEXT NOT NULL,
  wallet     TEXT,
  said       TEXT,                 -- what we classified it as
  note       TEXT,
  created_at INTEGER NOT NULL,
  resolved   INTEGER DEFAULT 0
);

/* Signals for human review. Deliberately not auto-blocks: banning on a
   heuristic catches real users, and one wrongly banned user complains
   louder than ten farmers. */
CREATE TABLE IF NOT EXISTS review (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL,
  cleared    INTEGER DEFAULT 0
);
`);

export const now = () => Date.now();

export function currentRound(){
  const r = db.prepare(`SELECT * FROM round WHERE state='open' ORDER BY id DESC LIMIT 1`).get();
  if (r) return r;
  const t = now();
  const week = 7 * 24 * 3600 * 1000;
  db.prepare(`INSERT INTO round (opens_at, closes_at) VALUES (?, ?)`).run(t, t + week);
  return db.prepare(`SELECT * FROM round WHERE state='open' ORDER BY id DESC LIMIT 1`).get();
}

export function ensureWallet(address){
  const a = String(address || '').toLowerCase();
  db.prepare(`INSERT OR IGNORE INTO wallet (address, created_at) VALUES (?, ?)`).run(a, now());
  return db.prepare(`SELECT * FROM wallet WHERE address = ?`).get(a);
}

export function flagForReview(wallet, reason, detail){
  db.prepare(`INSERT INTO review (wallet, reason, detail, created_at) VALUES (?,?,?,?)`)
    .run(String(wallet).toLowerCase(), reason, detail || null, now());
}
