/* Matching a scanned product to a receipt line.
 *
 * The failure this guards is not "no match found" — it is a match found
 * on another product's line, scored high, looking right. A protein bar
 * and a sports drink share PROT and BARS, and on a receipt with a protein
 * aisle on it that is most of a product name. Crediting one line's
 * purchase to another product is the exact thing the receipt exists to
 * prevent.
 */
import { matchProduct, scoreLine } from './receipt-parse.js';

let failures = 0;
const ok = (name, cond) => { if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const eq = (name, got, want) =>
  ok(name + (JSON.stringify(got) === JSON.stringify(want) ? '' : '  got ' + JSON.stringify(got)),
     JSON.stringify(got) === JSON.stringify(want));

const L = (...texts) => texts.map((text) => ({ text }));

/* A protein aisle, which is what makes PROT and BARS worthless. */
const AISLE = L(
  'GATORADE PROT BARS',
  'PURE PROT BARS CHOC',
  'QUEST PROT BARS',
  'CHUNK LIGHT TUNA',
  'WHOLE MILK',
  'BANANAS ORGANIC',
);

console.log('\n--- the match that should not have happened ---');
{
  // The bar is not on this receipt at all. Every line it could reach
  // shares only PROT and BARS with it.
  const m = matchProduct('Barebells Protein Bars Cookies and Cream', AISLE);
  ok('a bar absent from the receipt matches nothing', m === null);

  // And the reason it used to: on the old rule this cleared both the
  // score floor and the two-hit floor comfortably.
  const s = scoreLine('Barebells Protein Bars Cookies and Cream', 'GATORADE PROT BARS');
  ok('though it still scores well on generic words alone', s.score >= 0.25);
  ok('and still lands two hits', s.hits >= 2);
}

console.log('\n--- and the one that should ---');
{
  const withBar = [...AISLE, { text: 'BAREBELLS PROT BARS' }];
  const m = matchProduct('Barebells Protein Bars Cookies and Cream', withBar);
  ok('once the bar is on the receipt it matches', !!m);
  eq('and matches its own line', m && m.text, 'BAREBELLS PROT BARS');
  ok('on a distinctive word, not the generic pair', m && m.distinct >= 1);

  /* The wrong line must not be able to win on generics. Given a name
     stuffed with words the aisle shares, the line carrying the one
     distinctive word still takes it. */
  const m2 = matchProduct('Barebells Protein Bars', withBar);
  eq('generic agreement cannot outvote a distinctive word',
     m2 && m2.text, 'BAREBELLS PROT BARS');
}

console.log('\n--- the receipt is its own dictionary ---');
{
  /* GATORADE picks out a line in a grocery shop and picks out nothing in
     a sports shop. No list of stop words knows that; the receipt does. */
  const grocery = matchProduct('Gatorade Protein Bars', AISLE);
  eq('distinctive here', grocery && grocery.text, 'GATORADE PROT BARS');

  const sportsShop = L(
    'GATORADE ZERO BERRY',
    'GATORADE POWDER 30S',
    'GATORADE BOTTLE 32OZ',
    'GATORADE CHEW FRUIT',
    'TOWEL COTTON',
  );
  ok('and worthless there, so no match is claimed',
     matchProduct('Gatorade Protein Bars', sportsShop) === null);

  /* Worthless is not the same as absent. Put the bar back on that shelf
     and PROT and BARS become the rare words on the receipt — the pair
     that meant nothing in the grocery aisle is what picks out the line
     here. Commonness is a fact about the receipt, not about the word. */
  eq('while the same words carry it where they are rare',
     matchProduct('Gatorade Protein Bars',
       [...sportsShop, { text: 'GATORADE PROT BARS' }])?.text,
     'GATORADE PROT BARS');
}

console.log('\n--- what was already working still works ---');
{
  const receipt = L(
    'TRANSPARENT LABS WHEY ISO CHOC 900G',
    'CHESTNUT HILL CHDR SHRD 8OZ',
    'BANANAS ORGANIC 2.1 LB',
  );

  eq('an abbreviated whey still matches',
     matchProduct('100% GRASS-FED Whey Protein Isolate', receipt)?.text,
     'TRANSPARENT LABS WHEY ISO CHOC 900G');
  eq('vowel-dropped cheddar still matches',
     matchProduct('Mild Cheddar Cheese Fancy Shredded', receipt)?.text,
     'CHESTNUT HILL CHDR SHRD 8OZ');
  ok('and a product that is not there still is not',
     matchProduct('Creamy Peanut Butter', receipt) === null);
}

console.log('\n--- too little evidence to judge ---');
{
  /* On a one-line receipt every word that matches at all matches exactly
     one line. Counting that as distinctive would make the rule vacuous
     exactly where there is least to go on, so a share is used and one of
     one is not a small share. */
  ok('a single line cannot make a word distinctive',
     matchProduct('Organic Whey Free Range Grass Fed Vanilla Powder Large',
       L('WHEY ISO CHOC 900G')) === null);

  ok('no lines, no match', matchProduct('Anything', []) === null);
  ok('no product name, no match', matchProduct('', AISLE) === null);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
