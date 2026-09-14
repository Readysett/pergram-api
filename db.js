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
   database would be an attack.

   Rows are versioned and append-only. Nothing is ever updated in place,
   because a payout is relative — settle.js divides the pool by the round's
   total points, so changing what one barcode is worth mid-round silently
   changes what every OTHER wallet in that round earns. Superseding
   instead of overwriting keeps a claim's price attached to the exact
   figures it was priced from, and products.js additionally pins a
   barcode to one version for the lifetime of an open round, so two
   people claiming the same tin in the same week are always paid the
   same. New versions take effect at a round boundary, where the
   denominator resets anyway.

   status separates outcomes that must never be conflated:
     ok        - fetched and priced
     absent    - Open Food Facts has no such product; settled, not an error
     below_min - real product, under MIN_PROTEIN_100G, earns nothing
   A transient fetch failure is NOT a status. It is never cached, because
   caching it would turn a network blip into a permanent zero.

   The raw classifier inputs (ingredients/categories/vegan) are kept so a
   rules change can be re-run against what the record actually said,
   without a refetch. rules_hash records which rules produced the row. */
CREATE TABLE IF NOT EXISTS product_version (
  barcode       TEXT    NOT NULL,
  version       INTEGER NOT NULL,
  status        TEXT    NOT NULL,     -- ok | absent | below_min
  found_as      TEXT,                 -- the barcode variant that actually matched
  name          TEXT,
  brands        TEXT,
  quantity      TEXT,                 -- OFF pack-size string, read by resolveQuantity
  protein_100g  REAL,
  ingredients   TEXT,
  categories    TEXT,
  vegan         INTEGER DEFAULT 0,
  source_key    TEXT,
  co2           REAL,
  mult          REAL,
  rules_hash    TEXT,
  locked        INTEGER DEFAULT 0,    -- 1 = human-reviewed; pinned, never superseded
  fetched_at    INTEGER NOT NULL,
  superseded_at INTEGER,              -- null = current
  PRIMARY KEY (barcode, version)
);

CREATE INDEX IF NOT EXISTS product_current
  ON product_version(barcode, superseded_at);

/* A receipt read is not a claim, so it cannot go in the receipt table:
   that table's primary key IS the anti-replay control, and inserting on
   read would burn a receipt the user never confirmed. Scans are their
   own short-lived thing, bound to the wallet that uploaded them.

   This is what makes a server-derived quantity possible at all. The
   parse already resolves the quantity correctly at read time; before
   this it was computed, returned and thrown away, leaving /api/claim
   with no matched line to take a quantity FROM. */
CREATE TABLE IF NOT EXISTS receipt_scan (
  id          TEXT PRIMARY KEY,
  wallet      TEXT NOT NULL,
  round_id    INTEGER NOT NULL,   -- a scan may only be claimed in the round it was read in

  store       TEXT,
  txn         TEXT,
  purchased   INTEGER,
  total_cents INTEGER,
  image_hash  TEXT,
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS receipt_scan_line (
  scan_id         TEXT    NOT NULL,
  barcode         TEXT    NOT NULL,
  matched         INTEGER NOT NULL,
  line_text       TEXT,
  grams           REAL,               -- derived from the matched line; the only quantity that pays
  lower_g         REAL,               -- the lower answer to an ask, when there is one
  ask_question    TEXT,
  product_version INTEGER,            -- null when the lookup did not settle
  PRIMARY KEY (scan_id, barcode)
);

CREATE INDEX IF NOT EXISTS scan_by_wallet ON receipt_scan(wallet, created_at);

/* What a round actually paid, and to whom.
 *
 * Settlement used to compute the rate and the per-wallet split, print
 * them, and return them — the only write was marking claims settled. A
 * settled round could not be reconstructed afterwards: the rate and the
 * split existed only in whatever terminal ran it. For a distribution
 * anyone is expected to audit, that is the record, and it was not being
 * kept.
 *
 * Written in the same transaction as the claims it settles, so there is
 * no state where claims read 'settled' and no payout explains them.
 * (round_id, wallet) is unique, which is also what makes re-settling a
 * round fail loudly rather than overwrite the history. */
CREATE TABLE IF NOT EXISTS payout (
  round_id   INTEGER NOT NULL,
  wallet     TEXT    NOT NULL,
  protein_g  REAL    NOT NULL,   -- as claimed, before the cap scales it
  points     REAL    NOT NULL,   -- after cap scaling; the share of the pool
  capped     INTEGER NOT NULL,
  b3tr       REAL    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (round_id, wallet)
);

CREATE INDEX IF NOT EXISTS payout_by_wallet ON payout(wallet, round_id);

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

/* ---------- migrations ----------
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a database that already
 * exists, so anything added after the first deploy has to be applied
 * here. Both are written to be safe to run on every boot.
 */

function columns(table){
  return new Set(db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map(r => r.name));
}

function addColumn(table, name, decl){
  if (columns(table).has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
}

/* Which cached figures a claim was priced from. Without it a claim can
   only be re-checked against whatever the barcode resolves to today,
   which is exactly the coupling the versioning removes. */
addColumn('claim', 'product_version', 'INTEGER');

/* The rate a round settled at, kept beside the pool it divided. Derived
   from the payouts, but storing it means the number that was actually
   used is recorded rather than recomputed later from rows that may since
   have been corrected. */
addColumn('round', 'total_points', 'REAL');
addColumn('round', 'rate_b3tr_per_point', 'REAL');
addColumn('round', 'settled_at', 'INTEGER');

/* product_cache was declared in the first schema and never read or
   written by any code path — the design was specified and not built.
   product_version replaces it. Dropping it is guarded rather than
   unconditional: if a deployment turns out to have rows in it, they were
   put there by hand and are someone's work, so leave them and say so. */
{
  const exists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='product_cache'`).get();
  if (exists){
    const n = db.prepare(`SELECT COUNT(*) AS n FROM product_cache`).get().n;
    if (n === 0) db.exec(`DROP TABLE product_cache`);
    else console.warn(
      `\n  NOTE: product_cache holds ${n} hand-written row(s) and has been left in place.\n` +
      `  It is no longer read; product_version supersedes it. Migrate or drop it by hand.\n`);
  }
}

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
