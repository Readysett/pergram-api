/* Reading order.
 *
 * Vision segments a receipt into columns and returns its text in that
 * order — every description, then every price. Read as lines, an item and
 * its price are never on the same line, so nothing downstream can work.
 * These build words in that order and check rows come back out.
 */
import { linesFromWords, parseReceipt } from './receipt-parse.js';

let failures = 0;
const ok = (name, cond) => { if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const eq = (name, got, want) =>
  ok(name + (JSON.stringify(got) === JSON.stringify(want) ? '' : '  got ' + JSON.stringify(got)),
     JSON.stringify(got) === JSON.stringify(want));

/* A word as Vision would place it. h defaults to a normal line height. */
const w = (text, x, y, h = 20) => ({ text, x, y, h });

console.log('\n--- rows out of columns ---');
{
  /* The left column, then the right column: the order Vision returns,
     and the reason a price never met its item. */
  const words = [
    w('WHOLE', 10, 40), w('FOODS', 90, 40), w('MARKET', 175, 40),
    w('TUNA', 10, 140), w('CHNK', 75, 140), w('142G', 145, 140),
    w('WHEY', 10, 180), w('ISO', 80, 180),  w('900G', 130, 180),
    w('TOTAL', 10, 260),
    w('4.29', 420, 140),
    w('44.99', 415, 180),
    w('51.97', 415, 260),
  ];

  const rows = linesFromWords(words);
  eq('the item meets its price', rows[1], 'TUNA CHNK 142G 4.29');
  eq('and so does the next',     rows[2], 'WHEY ISO 900G 44.99');
  eq('the header survives',      rows[0], 'WHOLE FOODS MARKET');
  eq('and the total',            rows[3], 'TOTAL 51.97');
  ok('four rows, not thirteen fragments', rows.length === 4);
}

console.log('\n--- the shapes a photograph arrives in ---');
{
  /* A page is never quite square to the camera, so a row's words drift a
     few pixels apart vertically. */
  const skewed = [w('TUNA', 10, 138), w('CHNK', 75, 141), w('4.29', 420, 145)];
  eq('a few pixels of skew is still one row',
     linesFromWords(skewed), ['TUNA CHNK 4.29']);

  /* Two rows a full line apart must not merge. */
  const close = [w('TUNA', 10, 140), w('4.29', 420, 140),
                 w('WHEY', 10, 168), w('44.99', 415, 168)];
  ok('rows a line apart stay apart', linesFromWords(close).length === 2);

  /* Order within a row comes from x, not from the order they arrived. */
  eq('words are read left to right',
     linesFromWords([w('4.29', 420, 100), w('CHNK', 75, 100), w('TUNA', 10, 100)]),
     ['TUNA CHNK 4.29']);

  /* Photographed closer, everything is bigger — including the gaps. The
     scale comes from the text, so the same receipt reads the same. */
  const big = [w('TUNA', 20, 280, 40), w('CHNK', 150, 286, 40), w('4.29', 840, 292, 40),
               w('WHEY', 20, 336, 40), w('44.99', 830, 340, 40)];
  ok('a closer photograph reads the same', linesFromWords(big).length === 2);
}

console.log('\n--- nothing to go on ---');
{
  eq('no words is no rows',      linesFromWords([]), []);
  eq('null is no rows',          linesFromWords(null), []);
  eq('a word with no position is skipped',
     linesFromWords([{ text: 'X' }, w('TUNA', 10, 100)]), ['TUNA']);

  /* Vision omits zero coordinates rather than sending them, so a word
     against the left edge legitimately has x of 0. It is a position, not
     a missing one. */
  eq('x of zero is a position, not an absence',
     linesFromWords([w('4.29', 420, 100), w('TUNA', 0, 100)]), ['TUNA 4.29']);
}

console.log('\n--- lines closer together than the text is tall ---');
{
  /* Vision's boxes run from ascender to descender, and a receipt is set
     tighter than that: text 30 high on a 16 pitch. Anything that decides
     rows from the height reaches into the line above and the line below.
     This is the case that collapsed three real lines into one. */
  const t = (text, x, x2, y) => ({ text, x, x2, y, h: 30 });

  eq('three tight lines stay three rows',
     linesFromWords([
       t('CHUNK', 10, 90, 100), t('TUNA', 100, 180, 100),
       t('WHOLE', 10, 90, 116), t('MILK', 100, 180, 116),
       t('BARILLA', 10, 90, 132), t('PLUS', 100, 180, 132),
     ]),
     ['CHUNK TUNA', 'WHOLE MILK', 'BARILLA PLUS']);

  /* The symptom that gave it away: merge two lines and their words
     interleave when sorted by x, so the gap between neighbours comes out
     negative. Rows that are actually rows never do that. */
  /* Prices on the right, so the gutter rule joins each row and this
     measures the grouping alone rather than both rules at once. */
  const rows = linesFromWords([
    t('AAA', 10, 90, 100), t('1.99', 600, 680, 100),
    t('CCC', 10, 90, 116), t('2.99', 600, 680, 116),
  ]);
  eq('and their words do not interleave', rows, ['AAA 1.99', 'CCC 2.99']);

  /* A blank line is two pitches, and must still be a boundary rather than
     setting the scale for everything else. */
  eq('a blank line does not widen the rest',
     linesFromWords([
       t('ITEM', 10, 90, 100),
       t('NEXT', 10, 90, 116),
       t('AFTER', 10, 90, 148),
     ]),
     ['ITEM', 'NEXT', 'AFTER']);

  /* A page photographed slightly askew: the words of one line do not
     share a centre exactly, and that wobble is not a line break. */
  eq('a wobble along a line is not a break',
     linesFromWords([
       t('CHUNK', 10, 90, 100), t('LIGHT', 100, 180, 102), t('TUNA', 190, 270, 104),
       t('WHOLE', 10, 90, 116), t('MILK', 100, 180, 118),
     ]),
     ['CHUNK LIGHT TUNA', 'WHOLE MILK']);
}

console.log('\n--- a gap, and what is on the far side of it ---');
{
  /* Same word, same distance, two different meanings. These two cases
     are the whole problem: the gap is identical and only what follows it
     says whether the row continues or a new one starts. */
  const wx = (text, x, x2, y = 100, h = 20) => ({ text, x, x2, y, h });

  /* One product, its price a long way to the right, and the tax flag
     after it. Distance here is the layout of a receipt. */
  eq('a price far to the right stays on its row',
     linesFromWords([
       wx('BARILLA', 10, 90), wx('PLUS', 100, 150), wx('PROTEIN', 160, 260),
       wx('2.99', 600, 650), wx('F', 660, 670),
     ]),
     ['BARILLA PLUS PROTEIN 2.99 F']);

  /* Two products printed side by side. Identical geometry, and joining
     them invents a line that was never on the receipt. */
  eq('a second column of items does not',
     linesFromWords([
       wx('BARILLA', 10, 90), wx('PLUS', 100, 150),
       wx('PROTEIN', 600, 700), wx('$2.99', 720, 780), wx('F', 790, 800),
     ]),
     ['BARILLA PLUS', 'PROTEIN $2.99 F']);

  /* Ordinary word spacing is not a gutter. */
  eq('words a space apart stay together',
     linesFromWords([
       wx('CHUNK', 10, 80), wx('LIGHT', 90, 160), wx('TUNA', 170, 240),
     ]),
     ['CHUNK LIGHT TUNA']);

  /* A dollar sign detached from its amount is still part of the price. */
  eq('a lone dollar sign is not a boundary',
     linesFromWords([
       wx('MILK', 10, 70), wx('$', 600, 612), wx('3.49', 618, 668),
     ]),
     ['MILK $ 3.49']);

  /* Without a right edge there is no measurable gap, so nothing is cut.
     That is the behaviour every word had before this, and the fixture
     and older tests still rely on it. */
  eq('no right edge means no cutting',
     linesFromWords([
       { text:'BARILLA', x:10, y:100, h:20 },
       { text:'PROTEIN', x:600, y:100, h:20 },
     ]),
     ['BARILLA PROTEIN']);

  /* The threshold is in heights of the text, so the same receipt
     photographed closer splits in the same places. */
  eq('a closer photograph splits the same way',
     linesFromWords([
       wx('BARILLA', 20, 180, 200, 40), wx('PLUS', 200, 300, 200, 40),
       wx('PROTEIN', 1200, 1400, 200, 40), wx('$2.99', 1440, 1560, 200, 40),
     ]),
     ['BARILLA PLUS', 'PROTEIN $2.99']);
}

console.log('\n--- what the parser then makes of it ---');
{
  const words = [
    w('WHOLE', 10, 40), w('FOODS', 90, 40), w('MARKET', 175, 40),
    w('08/30/2026', 10, 80), w('02:14', 150, 80), w('PM', 210, 80),
    w('TRANSACTION', 10, 110), w('#', 130, 110), w('4471-8823-0091', 155, 110),
    w('TUNA', 10, 140), w('CHNK', 75, 140), w('LIGHT', 145, 140), w('142G', 215, 140),
    w('WHEY', 10, 180), w('ISO', 80, 180), w('CHOC', 130, 180), w('900G', 200, 180),
    w('SUBTOTAL', 10, 240),
    w('TOTAL', 10, 280),
    w('4.29', 420, 140), w('44.99', 415, 180), w('49.28', 415, 240), w('51.97', 415, 280),
  ];

  const p = parseReceipt({ text: 'ignored — the words are what matter', words });

  ok('it says it rebuilt them',     p.reconstructed === true);
  eq('the store',                   p.store, 'WHOLE FOODS MARKET');
  eq('the total, not the subtotal', p.total_cents, 5197);
  /* Hyphens are stripped on purpose, so the same id printed two ways
     still hashes to one receipt. */
  eq('the transaction id, normalised', p.txn, '447188230091');
  ok('the date',                    !!p.purchased &&
                                    new Date(p.purchased).getUTCFullYear() === 2026 &&
                                    new Date(p.purchased).getUTCMonth() === 7);

  eq('two items, each with its price',
     p.lines.map(l => l.text + '|' + l.cents),
     ['TUNA CHNK LIGHT 142G|429', 'WHEY ISO CHOC 900G|4499']);
}

console.log('\n--- text on its own still works ---');
{
  /* The fixture, the old tests, and any adapter that cannot say where a
     word was. */
  const p = parseReceipt('WHOLE FOODS MARKET\nTUNA CHNK 142G   4.29\nTOTAL   4.29');
  ok('falls back to the line breaks', p.reconstructed === false);
  eq('and still reads the item', p.lines.map(l => l.text), ['TUNA CHNK 142G']);
  eq('the raw text is kept as it came',
     p.raw.split('\n')[0], 'WHOLE FOODS MARKET');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
