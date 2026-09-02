/* Auth tests. Each one is an attack that used to work. */
import { Wallet } from 'ethers';
import { createNonce, verifySignature, walletForToken, revoke } from './auth.js';
import { db } from './db.js';

const ok = (name, cond) => console.log((cond ? 'ok   ' : 'FAIL ') + name);

const alice = Wallet.createRandom();
const mal   = Wallet.createRandom();

console.log('\n--- happy path ---');
const c1 = createNonce(alice.address);
const sig = await alice.signMessage(c1.message);
const s1 = verifySignature({ wallet: alice.address, nonce: c1.nonce, signature: sig });
ok('valid signature opens a session', s1.ok);
ok('token resolves to the signer', walletForToken(s1.token) === alice.address.toLowerCase());

console.log('\n--- attacks ---');

const r1 = verifySignature({ wallet: alice.address, nonce: c1.nonce, signature: sig });
ok('nonce cannot be reused (replay)', !r1.ok);

const c2 = createNonce(alice.address);
const malSig = await mal.signMessage(c2.message);
const r2 = verifySignature({ wallet: alice.address, nonce: c2.nonce, signature: malSig });
ok('cannot claim another wallet by signing their message', !r2.ok);

const c3 = createNonce(alice.address);
const r3 = verifySignature({ wallet: alice.address, nonce: c3.nonce, signature: '0x' + '11'.repeat(65) });
ok('garbage signature refused', !r3.ok);

const c4 = createNonce(alice.address);
const otherSig = await alice.signMessage('some other message entirely');
const r4 = verifySignature({ wallet: alice.address, nonce: c4.nonce, signature: otherSig });
ok('signature over a different message refused', !r4.ok);

const c5 = createNonce(alice.address);
db.prepare(`UPDATE nonce SET created_at = ? WHERE value = ?`).run(Date.now() - 10*60*1000, c5.nonce);
const expSig = await alice.signMessage(c5.message);
ok('expired nonce refused', !verifySignature({ wallet: alice.address, nonce: c5.nonce, signature: expSig }).ok);

ok('unknown token resolves to nobody', walletForToken('deadbeef') === null);
ok('no token resolves to nobody', walletForToken(null) === null);

revoke(s1.token);
ok('revoked token stops working', walletForToken(s1.token) === null);

ok('bad address refused at nonce stage', createNonce('not-an-address') === null);

console.log('\n--- storage ---');
const row = db.prepare(`SELECT token_hash FROM session LIMIT 1`).get();
ok('sessions stored hashed, not in the clear', row && row.token_hash.length === 64);

console.log('\n--- certificate path (VeChain wallets) ---');
{
  const { Certificate } = await import('@vechain/sdk-core');
  const { Secp256k1, Address, HexUInt } = await import('@vechain/sdk-core');
  const { verifySignature } = await import('./auth.js');

  const priv = await Secp256k1.generatePrivateKey();   // returns a promise
  const signer = Address.ofPrivateKey(priv).toString().toLowerCase();

  const challenge = 'a'.repeat(48);
  const make = (content, ts) => {
    const c = Certificate.of({
      purpose: 'identification',
      payload: { type: 'text', content },
      domain: 'localhost',
      timestamp: ts ?? Math.floor(Date.now() / 1000),
      signer,
    });
    c.sign(priv);
    return JSON.parse(JSON.stringify(c));
  };

  const good = make('Per Gram — prove you control this wallet.\n\nChallenge: ' + challenge);
  const r = verifySignature({ challenge, certificate: good });
  ok('valid certificate opens a session', r.ok && r.wallet === signer);

  const r2 = verifySignature({ challenge, certificate: good });
  ok('certificate cannot be replayed', !r2.ok);

  const ch2 = 'b'.repeat(48);
  const wrong = make('Per Gram — prove you control this wallet.\n\nChallenge: ' + ch2);
  ok('challenge must appear in the signed content', !verifySignature({ challenge: 'c'.repeat(48), certificate: wrong }).ok);

  const ch3 = 'd'.repeat(48);
  const old = make('Per Gram — prove you control this wallet.\n\nChallenge: ' + ch3,
                   Math.floor(Date.now()/1000) - 3600);
  ok('stale certificate refused', !verifySignature({ challenge: ch3, certificate: old }).ok);

  const ch4 = 'e'.repeat(48);
  const tampered = make('Per Gram — prove you control this wallet.\n\nChallenge: ' + ch4);
  tampered.payload.content = tampered.payload.content.replace(ch4, 'f'.repeat(48));
  ok('tampered content refused', !verifySignature({ challenge: 'f'.repeat(48), certificate: tampered }).ok);
}
