/* Quantity tests. Each one is a way a claim came out wrong.
 *
 * The rule the asserts encode: doubt resolves downward, and no answer a
 * user can give is allowed to raise a claim.
 */
import { parsePackSize, extractCount, resolveQuantity } from './receipt-parse.js';

let failures = 0;
const ok = (name, cond) => { if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const eq = (name, got, want) =>
  ok(name + '  (' + JSON.stringify(got) + ')', JSON.stringify(got) === JSON.stringify(want));

console.log('\n--- pack size from free text ---');
const pk = t => { const p = parsePackSize(t); return p && [p.count, p.unit_g, p.total_g]; };
eq('6 x 142 g',        pk('6 x 142 g'),  [6, 142, 852]);
eq('6x142g, no spaces',pk('6x142g'),     [6, 142, 852]);
eq('unicode multiply', pk('6 × 142 g'), [6, 142, 852]);
eq('4 x 5 oz',         pk('4 x 5 oz'),   [4, 142, 568]);
eq('plain 900g',       pk('900g'),       [1, 900, 900]);
eq('1.5 kg',           pk('1.5 kg'),     [1, 1500, 1500]);
eq('8 oz',             pk('8 oz'),       [1, 227, 227]);
eq('2 lb',             pk('2 lb'),       [1, 907, 907]);
eq('1 L as water',     pk('1 L'),        [1, 1000, 1000]);
ok('empty is unknown',        parsePackSize('') === null);
ok('unparseable is unknown',  parsePackSize('family size') === null);

console.log('\n--- count stated on a receipt line ---');
eq('2 @ 3.49',        extractCount('TUNA CHNK 2 @ 3.49'), 2);
eq('QTY column',      extractCount('TUNA CHNK QTY 2'),    2);
ok('a size is not a count',  extractCount('TUNA CHNK 142G') === null);
ok('a pack is not a count',  extractCount('TUNA 6 X 142G') === null);

console.log('\n--- combining the sources ---');
const L = (text, qty = null) => ({ text, qty });

/* The record says six-pack and nothing contradicts it. This is the case
   that cannot be resolved by parsing: a tin scanned from inside a pack
   looks the same as the pack. */
const a = resolveQuantity({ line: L('TUNA CHNK'), quantity: '6 x 142 g' });
eq('uncorroborated pack is taken whole', [a.count, a.grams], [1, 852]);
ok('and it asks',                        !!a.ask);
eq('the answer can only lower it',       [a.ask.keep_g, a.ask.lower_g], [852, 142]);

/* The receipt prints a single tin's size. Lower reading wins, and there is
   nothing to ask, because every answer would raise the claim. */
const b = resolveQuantity({ line: L('TUNA CHNK 142G'), quantity: '6 x 142 g' });
eq('receipt disagrees, lower wins', [b.count, b.grams], [1, 142]);
ok('and it stays silent',           b.ask === null);

/* The receipt itself states the pack. That is the receipt supplying the
   count, which is the source allowed to. */
const c = resolveQuantity({ line: L('TUNA 6 X 142G'), quantity: '142 g' });
eq('receipt states the pack', [c.count, c.grams], [6, 852]);
ok('nothing to ask',          c.ask === null);

/* Both say six-pack. The multiplier must be applied once, not twice. */
const d = resolveQuantity({ line: L('TUNA 6 X 142G'), quantity: '6 x 142 g' });
eq('pack size never squared', [d.count, d.grams], [6, 852]);

/* A stated count multiplies whatever one unit weighs. */
const e = resolveQuantity({ line: L('WHEY ISO 900G', 2), quantity: '900 g' });
eq('two of the same line', [e.count, e.grams], [2, 1800]);

/* Two six-packs: the receipt's count and the record's pack are different
   facts, so both apply — once each. */
const f = resolveQuantity({ line: L('TUNA CHNK', 2), quantity: '6 x 142 g' });
eq('two packs', [f.count, f.grams], [2, 1704]);
eq('the ask scales with the count', [f.ask.keep_g, f.ask.lower_g], [1704, 284]);

/* The receipt states a size that is not the pack. That is corroboration,
   so offering to drop to a single unit would contradict it. */
const i = resolveQuantity({ line: L('WHEY ISO CHOC 900G'), quantity: '6 x 142 g' });
eq('lower of two real readings', i.grams, 852);
ok('but the receipt spoke, so no ask', i.ask === null);

/* Nothing to go on. Better to report nothing than to guess. */
const g = resolveQuantity({ line: L('MYSTERY ITEM'), quantity: null });
eq('unknown stays unknown', [g.count, g.grams], [1, null]);
ok('and asks nothing',      g.ask === null);

/* A two-pack is inside the ask threshold: the tap costs more than it
   settles, so it is taken low and left alone. */
const h = resolveQuantity({ line: L('YOGHURT'), quantity: '2 x 150 g' });
eq('small pack taken whole', h.grams, 300);
ok('but below the ask ratio, so silent', h.ask === null);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
