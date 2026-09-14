/* Server-derived reward tests.
 *
 * The rule the asserts encode: nothing the client sends about a product
 * or a quantity reaches the ledger. Each case here is a thing a modified
 * client could previously have done.
 *
 *   DB_PATH=/tmp/t.db node test-server-derived.js
 */
process.env.DB_PATH ||= './test-server-derived.db';

import { rmSync } from 'node:fs';
rmSync(process.env.DB_PATH, { force: true });
rmSync(process.env.DB_PATH + '-wal', { force: true });
rmSync(process.env.DB_PATH + '-shm', { force: true });

const { db, currentRound, now, ensureWallet } = await import('./db.js');
const { submitClaim, createScan, scanReceipt, weekTotals } = await import('./claims.js');
const products = await import('./products.js');

let failures = 0;
const ok = (name, cond) => { if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const eq = (name, got, want) =>
  ok(name + '  (' + JSON.stringify(got) + ')', JSON.stringify(got) === JSON.stringify(want));

const WALLET = '0x' + 'a'.repeat(40);
const OTHER  = '0x' + 'b'.repeat(40);
const round  = currentRound();

/* Personhood fails closed and calls a Thor node to decide. These tests
   are about pricing, so seed the cache it would have written and let the
   check short-circuit — no network, and no bypass added to the code. */
for (const a of [WALLET, OTHER]){
  ensureWallet(a);
  db.prepare(`UPDATE wallet SET passport_ok=1, passport_at=?, passport_note='test' WHERE address=?`)
    .run(now(), a);
}

/* Open Food Facts is never called in these tests. Seeding the cache
   directly is the same thing resolveProduct would have written, and it
   keeps the assertions about pricing rather than about the network. */
function seed(barcode, row){
  db.prepare(`
    INSERT INTO product_version (barcode, version, status, name, quantity, protein_100g,
                                 source_key, co2, mult, rules_hash, fetched_at)
    VALUES (?,1,?,?,?,?,?,?,?,'test',?)
  `).run(barcode, row.status || 'ok', row.name, row.quantity || null,
         row.protein_100g ?? null, row.source_key || null,
         row.co2 ?? null, row.mult ?? null, now());
}

/* Beef: 50 kg CO2e per 100g protein, so multFor(50) = 0.04. */
seed('0000000000017', { name:'Ground Beef', protein_100g:26, source_key:'beef', co2:50,  mult:0.04 });
/* Tuna: a tin is 142g, 25g protein per 100g. */
seed('0000000000024', { name:'Chunk Light Tuna', quantity:'142 g', protein_100g:25, source_key:'fish', co2:6.1, mult:0.33 });

function scanWith(lines, opts = {}){
  return createScan({
    wallet: WALLET, roundId: round.id,
    receipt: { store:'TEST', txn: 'T' + Math.random().toString(36).slice(2),
               purchased: now() - 86400000, total_cents: 999, image_hash:null, ...opts },
    lines,
  });
}

console.log('\n--- the multiplier is derived, never sent ---');
{
  const scan = scanWith([{ barcode:'0000000000017', matched:1, line_text:'GROUND BEEF', grams:500 }]);
  const out  = await submitClaim({
    wallet: WALLET, scan_id: scan,
    /* A modified client claiming beef is plant protein. */
    items: [{ barcode:'0000000000017', mult:1.0, co2:0.4, protein_g:900, source_key:'pea' }],
  });
  ok('claim accepted', out.ok);
  const c = db.prepare(`SELECT * FROM claim WHERE barcode='0000000000017'`).get();
  eq('multiplier is beef, not the 1.0 sent', c.mult, 0.04);
  eq('source is beef, not the pea sent',     c.source_key, 'beef');
  eq('protein is 500g x 26/100, not 900',    c.protein_g, 130);
  eq('points are derived',                   c.points, +(130 * 0.04).toFixed(10));
  eq('footprint is beef scaled by protein',  +c.co2_kg.toFixed(3), +(130 / 100 * 50).toFixed(3));
  ok('the version it was priced from is recorded', c.product_version === 1);
}

console.log('\n--- quantity comes from the matched line, never the request ---');
{
  const scan = scanWith([{ barcode:'0000000000024', matched:1, line_text:'TUNA CHNK', grams:142 }]);
  const out  = await submitClaim({
    wallet: WALLET, scan_id: scan,
    items: [{ barcode:'0000000000024', protein_g:900 }],   // 900g from a tin of tuna
  });
  ok('claim accepted', out.ok);
  const c = db.prepare(`SELECT * FROM claim WHERE barcode='0000000000024'`).get();
  eq('protein is 142g x 25/100', c.protein_g, 35.5);
}

console.log('\n--- a barcode the receipt never showed cannot be claimed ---');
{
  const scan = scanWith([{ barcode:'0000000000024', matched:1, line_text:'TUNA CHNK', grams:142 }]);
  const out  = await submitClaim({ wallet: WALLET, scan_id: scan,
                                   items: [{ barcode:'0000000000017' }] });
  ok('refused', !out.ok);
}

console.log('\n--- an unmatched line pays nothing, however it is dressed up ---');
{
  const scan = scanWith([{ barcode:'0000000000017', matched:0, line_text:null, grams:null }]);
  const out  = await submitClaim({ wallet: WALLET, scan_id: scan,
                                   items: [{ barcode:'0000000000017', protein_g:200 }] });
  ok('refused', !out.ok);
}

console.log('\n--- an answer may lower a claim and never raise one ---');
{
  const scan = scanWith([{ barcode:'0000000000024', matched:1, line_text:'TUNA 6PK',
                           grams:852, lower_g:142, ask_question:'six-pack or one?' }]);
  const out  = await submitClaim({ wallet: WALLET, scan_id: scan,
                                   items: [{ barcode:'0000000000024', answer:'lower' }] });
  ok('claim accepted', out.ok);
  eq('the lower figure was taken', out.accepted[0].protein_g, 35.5);
}
{
  const scan = scanWith([{ barcode:'0000000000024', matched:1, line_text:'TUNA 1',
                           grams:142, lower_g:null, ask_question:null }]);
  const out  = await submitClaim({ wallet: WALLET, scan_id: scan,
                                   items: [{ barcode:'0000000000024', answer:'keep', grams:852 }] });
  ok('claim accepted', out.ok);
  eq('no answer can raise it', out.accepted[0].protein_g, 35.5);
}

console.log('\n--- another wallet cannot spend your scan ---');
{
  const scan = scanWith([{ barcode:'0000000000024', matched:1, line_text:'TUNA', grams:142 }]);
  const out  = await submitClaim({ wallet: OTHER, scan_id: scan,
                                   items: [{ barcode:'0000000000024' }] });
  ok('refused', !out.ok);
}

console.log('\n--- a product under the protein floor earns nothing ---');
{
  seed('0000000000031', { status:'below_min', name:'Green Beans', protein_100g:0.8 });
  const scan = scanWith([{ barcode:'0000000000031', matched:1, line_text:'GREEN BEANS', grams:400 }]);
  const out  = await submitClaim({ wallet: WALLET, scan_id: scan,
                                   items: [{ barcode:'0000000000031', protein_g:400, mult:1 }] });
  ok('refused', !out.ok);
  ok('and nothing was written', !db.prepare(`SELECT 1 FROM claim WHERE barcode='0000000000031'`).get());
}

console.log('\n--- a lookup that does not settle burns nothing ---');
{
  const scan = scanWith([{ barcode:'0000000000048', matched:1, line_text:'MYSTERY', grams:200 }]);
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  let out;
  try {
    out = await submitClaim({ wallet: WALLET, scan_id: scan,
                              items: [{ barcode:'0000000000048' }] });
  } finally { globalThis.fetch = real; }

  ok('refused', !out.ok);
  ok('and says so retryably', out.retryable === true);
  ok('no claim was written',   !db.prepare(`SELECT 1 FROM claim WHERE barcode='0000000000048'`).get());
  /* The important half: the receipt was not consumed, so the user can
     try again rather than losing the shop to a network blip. */
  const sc = db.prepare(`SELECT * FROM receipt_scan WHERE id=?`).get(scan);
  ok('the scan is still unconsumed', sc.consumed_at === null);
  ok('and nothing was cached for it',
     !db.prepare(`SELECT 1 FROM product_version WHERE barcode='0000000000048'`).get());
}

console.log('\n--- one bad line fails the whole submission ---');
{
  const scan = scanWith([
    { barcode:'0000000000024', matched:1, line_text:'TUNA',   grams:142 },
    { barcode:'0000000000031', matched:1, line_text:'BEANS',  grams:400 },
  ]);
  const before = weekTotals(WALLET, round.id).protein;
  const out = await submitClaim({ wallet: WALLET, scan_id: scan,
    items: [{ barcode:'0000000000024' }, { barcode:'0000000000031' }] });
  ok('refused', !out.ok);
  eq('and the good line was not written either', weekTotals(WALLET, round.id).protein, before);
  const sc = db.prepare(`SELECT * FROM receipt_scan WHERE id=?`).get(scan);
  ok('the receipt stays claimable', sc.consumed_at === null);
}

console.log('\n--- end to end, through the real receipt matcher ---');
{
  /* What /api/receipt does with a parse, minus the OCR. The client sends
     barcodes and nothing else; the names matched against these lines are
     the ones the server holds. */
  const parsed = {
    store:'TEST MART', txn:'TXN-E2E-1', purchased: now() - 2 * 86400000,
    total_cents: 1847,
    lines: [
      { text:'CHUNK LIGHT TUNA 142G', qty:1 },
      { text:'BANANAS 1.2 LB', qty:1 },
      { text:'GROUND BEEF 500G', qty:1 },
    ],
  };

  const out = await scanReceipt({
    wallet: WALLET, roundId: round.id, parsed, image_hash:'e2e',
    /* A client that still sends the old rich shape: the extra fields are
       dropped on the way in, and a made-up name never reaches the
       matcher. */
    barcodes: ['0000000000024', '0000000000017'],
  });

  eq('both barcodes came back', out.matches.length, 2);
  eq('no lookup was left unsettled', out.unavailable, []);

  const tuna = out.matches.find(m => m.barcode === '0000000000024');
  eq('the tuna matched its own line', tuna.line, 'CHUNK LIGHT TUNA 142G');
  eq('named from the cache, not the request', tuna.name, 'Chunk Light Tuna');
  eq('quantity read off the line', tuna.grams, 142);

  const claim = await submitClaim({
    wallet: WALLET, scan_id: out.scan_id,
    items: [{ barcode:'0000000000024' }, { barcode:'0000000000017' }],
  });
  ok('claim accepted', claim.ok);
  eq('two lines claimed', claim.accepted.length, 2);

  const rows = db.prepare(
    `SELECT barcode, protein_g, mult FROM claim WHERE receipt_key IN
       (SELECT key FROM receipt WHERE txn='TXN-E2E-1') ORDER BY barcode`).all();
  eq('priced from the server\'s own figures',
     rows.map(r => [r.barcode, r.protein_g, r.mult]),
     [['0000000000017', 130, 0.04], ['0000000000024', 35.5, 0.33]]);

  /* Sending it again is a retry, not a second claim. */
  const again = await submitClaim({
    wallet: WALLET, scan_id: out.scan_id,
    items: [{ barcode:'0000000000024' }, { barcode:'0000000000017' }],
  });
  ok('the retry replays rather than doubling', again.ok && again.replayed === true);
  eq('and still only two claims exist', db.prepare(
    `SELECT COUNT(*) AS n FROM claim WHERE receipt_key IN
       (SELECT key FROM receipt WHERE txn='TXN-E2E-1')`).get().n, 2);
}

console.log('\n--- a repeated barcode is one claim, not a refusal ---');
{
  const scan = scanWith([{ barcode:'0000000000024', matched:1, line_text:'TUNA', grams:142 }]);
  const out = await submitClaim({ wallet: WALLET, scan_id: scan,
    items: [{ barcode:'0000000000024' }, { barcode:'0000000000024' }] });
  ok('accepted', out.ok);
  eq('counted once', out.accepted.length, 1);
}

console.log('\n--- versions: a wiki edit cannot reprice an open round ---');
{
  /* Somebody claims the beef. That commits the round to version 1. */
  const pinned = products.pinnedVersion('0000000000017', round.id);
  eq('the round is pinned to the version that was claimed', pinned, 1);

  /* Open Food Facts now says the beef is pea protein. */
  const changed = await products.resolveProduct('0000000000017', round.id);
  eq('the round still prices from version 1', changed.version, 1);
  eq('at the beef multiplier',                changed.mult, 0.04);

  /* And a claim already written keeps the numbers it was paid on, even
     if a later version supersedes them. */
  db.prepare(`UPDATE product_version SET superseded_at=? WHERE barcode=? AND version=1`)
    .run(now(), '0000000000017');
  db.prepare(`
    INSERT INTO product_version (barcode, version, status, name, protein_100g,
                                 source_key, co2, mult, rules_hash, fetched_at)
    VALUES ('0000000000017',2,'ok','Ground Beef',26,'pea',0.4,1.0,'test',?)
  `).run(now());

  const c = db.prepare(`SELECT * FROM claim WHERE barcode='0000000000017'`).get();
  eq('the settled claim is unchanged', [c.mult, c.protein_g], [0.04, 130]);
  eq('and still names version 1',      c.product_version, 1);
}

console.log('\n--- reading Open Food Facts ---');
{
  /* The live host is not reachable from every environment, so the
     responses are stubbed. What is under test is the mapping from an
     answer to a price, and which answers are allowed to be cached. */
  const real = globalThis.fetch;
  const reply = (status, body) => async () => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body,
  });

  const TUNA = { product: {
    product_name:'Chunk Light Tuna In Water', brands:'StarKist', quantity:'5 oz',
    nutriments:{ proteins_100g: 22 }, ingredients_text:'light tuna, water, salt',
    categories:'Canned tuna', labels_tags:[] } };

  globalThis.fetch = reply(200, TUNA);
  let p = await products.fetchProduct('0000000000055');
  try {
    eq('a protein source is priced', [p.status, p.source_key], ['ok', 'fish']);
    eq('footprint and rate come from the classifier', [p.co2, p.mult], [6.1, 0.33]);
    eq('the pack size is kept for the quantity resolver', p.quantity, '5 oz');

    /* 404 is an answer: that barcode is not in the database. Cacheable,
       and distinct from not being able to ask. */
    globalThis.fetch = reply(404, {});
    p = await products.fetchProduct('0000000000062');
    eq('a missing product is absent, not an error', p.status, 'absent');

    globalThis.fetch = reply(200, { product: {
      product_name:'Green Beans', nutriments:{ proteins_100g: 0.8 },
      ingredients_text:'green beans, water', labels_tags:[] } });
    p = await products.fetchProduct('0000000000079');
    eq('under the protein floor is a settled answer', p.status, 'below_min');

    /* Everything else in the failure range is the service having a bad
       day and must never become a fact about the product. */
    for (const code of [500, 429, 403]){
      globalThis.fetch = reply(code, {});
      let threw = null;
      try { await products.fetchProduct('0000000000086'); } catch (e){ threw = e; }
      ok('HTTP ' + code + ' does not settle', threw && threw.name === 'LookupUnavailable');
    }

    /* A 12-digit UPC is stored as a 13-digit EAN with a leading zero.
       The first variant 404s, the second is the product. */
    let seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url).match(/product\/(\d+)/)[1]);
      return seen.length === 1
        ? { ok:false, status:404, json: async () => ({}) }
        : { ok:true,  status:200, json: async () => TUNA };
    };
    p = await products.fetchProduct('737628064502');
    eq('the leading-zero variant is tried', seen, ['737628064502', '0737628064502']);
    eq('and it resolves',                   [p.status, p.found_as], ['ok', '0737628064502']);
  } finally { globalThis.fetch = real; }
}

console.log('\n--- the classifier is the frontend one ---');
{
  const { SOURCES, multFor } = (await import('./vendor/classifier.js')).default;
  eq('multipliers are derived from the footprint, not bucketed',
     [SOURCES.cheese.mult, SOURCES.pork.mult], [multFor(21), multFor(7.6)]);
  ok('cheese and pork no longer share a rate', SOURCES.cheese.mult !== SOURCES.pork.mult);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
