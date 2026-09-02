/* Remove manual-entry claims from a round.
 *
 * Manual entries are the "Add to this week" path: a typed quantity with
 * no receipt behind it. Before the entry-id fix every tap wrote its own
 * receipt key, so a user who tapped twice on an unresponsive UI created
 * two claims. This clears those rows.
 *
 * It refuses to touch a claim that has been settled or paid — money that
 * has moved is not a debugging artefact — and it prints what it would do
 * unless you pass --apply. Read the dry run before you trust it.
 *
 *   node tools/clear-manual-claims.js --round 1
 *   node tools/clear-manual-claims.js --round 1 --wallet 0xabc...
 *   node tools/clear-manual-claims.js --round 1 --apply
 */
import { DatabaseSync } from 'node:sqlite';

const arg = n => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const APPLY  = process.argv.includes('--apply');
const ROUND  = Number(arg('--round') || 1);
const WALLET = (arg('--wallet') || '').toLowerCase() || null;
const PATH   = process.env.DB_PATH || './pergram.db';

const db = new DatabaseSync(PATH);

/* Only rows whose receipt is a manual entry, and only ones that have not
   been settled. Everything else is left alone. */
const where = `
  c.round_id = ?
  AND c.state NOT IN ('settled','paid')
  AND r.image_hash LIKE 'manual:%'
  ${WALLET ? 'AND c.wallet = ?' : ''}`;
const params = WALLET ? [ROUND, WALLET] : [ROUND];

const rows = db.prepare(`
  SELECT c.id, c.wallet, c.barcode, c.product, c.protein_g, c.points, c.state,
         c.receipt_key, r.image_hash
  FROM claim c JOIN receipt r ON r.key = c.receipt_key
  WHERE ${where}
  ORDER BY c.wallet, c.created_at
`).all(...params);

console.log(`db: ${PATH}\nround: ${ROUND}${WALLET ? '  wallet: ' + WALLET : ''}\n`);
if (!rows.length){ console.log('Nothing matches. No changes.'); process.exit(0); }

for (const r of rows){
  console.log(`  #${r.id}  ${r.wallet.slice(0,10)}…  ${(r.product || r.barcode).slice(0,28).padEnd(28)}`
    + `  ${String(r.protein_g).padStart(6)}g  ${String(Math.round(r.points)).padStart(6)}pts  ${r.state}`);
}
const g  = rows.reduce((a, r) => a + r.protein_g, 0);
const p  = rows.reduce((a, r) => a + r.points, 0);
const ws = new Set(rows.map(r => r.wallet)).size;
console.log(`\n${rows.length} claim(s) across ${ws} wallet(s) — ${Math.round(g)}g, ${Math.round(p)} points.`);

/* A skipped settled row is worth saying out loud: it means this round is
   past the point where deleting claims is harmless. */
const settled = db.prepare(`
  SELECT COUNT(*) n FROM claim c JOIN receipt r ON r.key = c.receipt_key
  WHERE c.round_id = ? AND c.state IN ('settled','paid') AND r.image_hash LIKE 'manual:%'
`).get(ROUND).n;
if (settled) console.log(`WARNING: ${settled} settled/paid manual claim(s) in this round were NOT selected.`);

if (!APPLY){ console.log('\nDry run. Re-run with --apply to delete.'); process.exit(0); }

const keys = [...new Set(rows.map(r => r.receipt_key))];
const qs   = keys.map(() => '?').join(',');
db.exec('BEGIN');
try {
  const c = db.prepare(`DELETE FROM claim WHERE id IN (${rows.map(() => '?').join(',')})`)
              .run(...rows.map(r => r.id)).changes;
  /* The receipt goes too. Leaving it behind keeps its key registered, and
     a re-submitted entry would then be treated as a retry of a claim that
     no longer exists — accepted, and storing nothing. */
  const k = db.prepare(`
    DELETE FROM receipt WHERE key IN (${qs})
      AND key NOT IN (SELECT receipt_key FROM claim)`).run(...keys).changes;
  db.exec('COMMIT');
  console.log(`\nDeleted ${c} claim(s) and ${k} orphaned receipt(s).`);
} catch (e){
  db.exec('ROLLBACK');
  console.error('\nRolled back, nothing changed:', e.message);
  process.exit(1);
}
