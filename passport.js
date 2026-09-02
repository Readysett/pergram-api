import { Interface } from 'ethers';
import { db, now } from './db.js';

/* VeBetterPassport — the ecosystem's proof-of-personhood layer.
 *
 * This is the control that actually addresses sybil farming. Receipt
 * hashing stops one receipt being claimed twice; it does nothing about
 * ten real receipts across ten fresh wallets, because wallets are free.
 * Passport raises the cost of a fresh wallet.
 *
 * Addresses from vechain/vebetterdao-contracts.
 */
export const PASSPORT = {
  main: '0x35a267671d8EDD607B2056A9a13E7ba7CF53c8b3',
  test: '0xC30b3c9dbd21F5DC46f0eb1f13AF3caE6bAb01ab',
};

const NODE = process.env.THOR_NODE || 'https://mainnet.vechain.org';
const ADDR = process.env.PASSPORT_ADDR || PASSPORT.main;

/* isPerson returns (bool, string) — the string is why, which is worth
   keeping: "not enough participation" and "blacklisted" call for very
   different responses. */
const iface = new Interface([
  'function isPerson(address user) view returns (bool, string)',
]);

const CACHE_MS = 6 * 3600 * 1000;   // personhood changes slowly; don't hammer the node

export async function isPerson(address){
  const a = String(address || '').toLowerCase();
  const row = db.prepare(`SELECT * FROM wallet WHERE address = ?`).get(a);

  if (row && row.passport_at && (now() - row.passport_at) < CACHE_MS){
    return { ok: !!row.passport_ok, note: row.passport_note, cached: true };
  }

  let ok = false, note = 'check failed';
  try {
    const data = iface.encodeFunctionData('isPerson', [a]);
    const res = await fetch(`${NODE}/accounts/*`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clauses: [{ to: ADDR, value: '0x0', data }] }),
    });
    if (!res.ok) throw new Error('thor HTTP ' + res.status);
    const out = await res.json();
    const first = Array.isArray(out) ? out[0] : null;
    if (!first) throw new Error('empty response');
    if (first.reverted) throw new Error('call reverted');

    const [person, reason] = iface.decodeFunctionResult('isPerson', first.data);
    ok = Boolean(person);
    note = reason || (ok ? 'ok' : 'not a person');
  } catch (e){
    /* A node outage must not silently approve everyone. Fail closed:
       no personhood, no payout, and the claim can be retried later. */
    ok = false;
    note = 'passport unavailable: ' + e.message;
  }

  db.prepare(`UPDATE wallet SET passport_ok=?, passport_at=?, passport_note=? WHERE address=?`)
    .run(ok ? 1 : 0, now(), note, a);

  return { ok, note, cached: false };
}
