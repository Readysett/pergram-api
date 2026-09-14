/* Per Gram — protein source classifier.
 *
 * Single source of truth. The app and the tests both load this file.
 *
 * Footprints are kg CO2e per 100g of PROTEIN, not per kg of food.
 *
 * Design notes, each one earned from a real misclassification:
 *
 *  - Allergen statements are not ingredients. "May contain peanuts,
 *    tree nuts" made whey powders classify as nuts.
 *  - Position matters. First-rule-wins put a whey bar in the beef tier
 *    because gelatin appeared far down its ingredient list. The
 *    dominant ingredient is the one nearest the start.
 *  - Flavourings are not protein. Yeast extract in seasoning made roast
 *    chicken classify as yeast; breading made fried chicken read as wheat.
 *  - The database is largely European. Poulet, thon, lait, molke and
 *    chanvre were all going unresolved.
 *  - A vegan label vetoes any animal result. If those two disagree, the
 *    classifier is wrong, not the label.
 */

const SOURCES = {
  pea:      { label:'Pea protein',        co2:0.4 },
  nuts:     { label:'Nuts and seeds',     co2:1.2 },
  yeast:    { label:'Nutritional yeast',  co2:1.5 },
  soy:      { label:'Soy or tofu',        co2:2.0 },
  plant:    { label:'Plant protein',      co2:2.0 },  // vegan, source unstated
  legume:   { label:'Beans and lentils',  co2:2.7 },
  wheat:    { label:'Wheat or seitan',    co2:2.7 },
  whey:     { label:'Whey or casein',     co2:3.6 },  // economic allocation
  egg:      { label:'Eggs',               co2:4.2 },
  chicken:  { label:'Chicken',            co2:5.7 },
  fish:     { label:'Fish',               co2:6.1 },
  pork:     { label:'Pork',               co2:7.6 },
  dairy:    { label:'Milk protein',       co2:9.5 },
  cheese:   { label:'Cheese',             co2:21.0 },  // other end of the whey allocation
  beef:     { label:'Beef or lamb',       co2:50.0 },
};

/* Tier names describe the footprint, not the membership. "Dairy and
   pork" was written before cheese joined the tier, and a bag of cheddar
   labelled "pork" is the kind of detail that costs credibility. */
/* Reward is inversely proportional to carbon intensity.
 *
 * Bucketing the multiplier was the mistake: cheese at 21 shared a tier
 * with pork at 7.6, so a 5.8x difference in footprint became a 1.8x
 * difference in reward. Deriving the multiplier from the footprint
 * removes the boundary entirely — no bucket edge can compress or invert
 * anything, and it needs one sentence to explain.
 *
 * REF is the reference intensity earning the full rate: 2.0 kg CO2e per
 * 100g protein, roughly soy. Anything cleaner is capped at 1.00 rather
 * than paying a premium, so pea protein cannot run away with the pool.
 */
const REF = 2.0;
const multFor = co2 => Math.max(0.03, Math.min(1, Math.round((REF / co2) * 100) / 100));

/* Tiers are now labels only — a readable band for the chip, with no
   influence on what anyone earns. */
const TIERS = {
  1:{ name:'Lowest',  color:'var(--t1)' },
  2:{ name:'Low',     color:'var(--t2)' },
  3:{ name:'High',    color:'var(--t3)' },
  4:{ name:'Highest', color:'var(--t4)' },
};
const tierFor = co2 => co2 <= 2.7 ? 1 : co2 <= 6.5 ? 2 : co2 <= 12 ? 3 : 4;

/* Derive both from the footprint so they can never disagree. */
for (const k of Object.keys(SOURCES)){
  SOURCES[k].mult = multFor(SOURCES[k].co2);
  SOURCES[k].tier = tierFor(SOURCES[k].co2);
}
for (const k of Object.keys(TIERS)) TIERS[k].mult = null;   // no longer meaningful

const ANIMAL = ['whey','egg','chicken','fish','pork','dairy','cheese','beef'];

/* Allergen statements list what a product might touch, not what is in it. */
const ALLERGEN = /(may contain|manufactured (in|on)|traces?( of)?|peut contenir|traces? éventuelles?|kann spuren|puede contener|può contenere)[^.;)]*/gi;

/* Oils, emulsifiers, flavourings, coatings. In the list, never the protein. */
const NOISE = new RegExp([
  '\\b(soybean|soy|sunflower|palm|canola|rapeseed|coconut|olive|vegetable|corn|fish)\\\s+oil\\b',
  '\\b(soy|sunflower)\\\s+lecithin\\b', '\\blecithin\\b', '\\blécithine[^,;]*',
  '\\bnatural flavou?rs?\\b', '\\bartificial flavou?rs?\\b', '\\barômes?[^,;]*',
  '\\byeast extract\\b', '\\bextrait de levure\\b', '\\bhefeextrakt\\b',
  '\\bmilk chocolate\\b', '\\bchocolat au lait\\b', '\\bmilchschokolade\\b',
  '\\bbutter flavou?r\\b', '\\bcocoa butter\\b', '\\bbeurre de cacao\\b',
  '\\bwheat flour\\b', '\\bfarine de blé\\b', '\\bweizenmehl\\b',
  '\\bcream of tartar\\b', '\\bsour cream flavou?r\\b',
].join('|'), 'gi');

/* Order is for readability. Dominance decides, not position. */
const RULES = [
  ['pea',     /\bpea protein|\bpisum|yellow pea|protéines? de pois|pois jaune|erbsenprotein|proteína de guisante|isolat de pois/i],
  ['nuts',    /peanut|almond|cashew|walnut|pecan|pistachio|hazelnut|\bhemp\b|pumpkin seed|sunflower seed|\btahini\b|sesame|arachide|amande|noisette|chanvre|cacahu[eè]te|mandel|erdnuss|haselnuss|nocciol|mandorl/i],
  ['yeast',   /nutritional yeast|torula|levure alimentaire|n[äa]hrhefe/i],
  ['soy',     /\bsoy protein|soya protein|\btofu\b|tempeh|edamame|\bsoybeans?\b|protéines? de soja|\bsoja\b|sojaprotein|proteína de soja/i],
  ['legume',  /lentil|chickpea|garbanzo|black bean|kidney bean|pinto bean|navy bean|cannellini|butter bean|\bfava\b|split pea|quinoa|lentille|pois chiche|haricot|linsen|kichererbse|lenteja|moong|\bmung\b|\bdal\b|\bdhal\b|lupin|altramuces|\burad\b|\btoor\b|edible bean/i],
  ['wheat',   /seitan|vital wheat gluten|wheat protein|wheat gluten|gluten de blé|protéines? de blé|weizenprotein|weizengluten/i],
  ['beef',    /\bbeef|steak|\blamb\b|bison|\bveal\b|ground chuck|collagen|gelatin|gelatine|gélatine|bone broth|bovine|b[oœ]uf|rindfleisch|\brind\b|ternera|manzo|agneau|\blamm\b/i],
  ['pork',    /\bpork|bacon|\bham\b|prosciutto|jambon|\bporc\b|schwein|\bcerdo\b|maiale|salami|chorizo|pancetta/i],
  ['chicken', /chicken|turkey|poultry|poulet|dinde|volaille|h[äa]hnchen|\bhuhn\b|\bpute\b|\bpollo\b|\bpavo\b|tacchino|\bduck\b|canard|magret|\bente\b|\bpato\b|anatra|\bgoose\b|\boie\b|volaille/i],
  ['fish',    /\btuna\b|salmon|\bcod\b|tilapia|sardine|anchov|shrimp|\bfish\b|seafood|\bthon\b|saumon|poisson|thunfisch|lachs|at[úu]n|\btonno\b|merluzzo|\batum\b|bonito|pescado|\bpeixe\b|\bриба\b|\bтон\b|sgombro|maquereau|maatjes|hering|\bpesce\b/i],
  ['egg',     /\begg whites?\b|\beggs?\b|albumen|\bœufs?\b|\boeufs?\b|\bei(?:er|klar|weiß)\b|\bhuevo\b|\buovo\b/i],
  ['whey',    /\bwhey\b|casein|caseinate|milk protein isolate|lactosérum|petit-lait|protéines? de lait|molke|suero de leche|siero di latte/i],
  ['cheese',  /\bcheese\b|cheddar|mozzarella|parmesan|gouda|\bbrie\b|feta|halloumi|\bcolby\b|monterey jack|fromage|\bkäse\b|\bqueso\b|formaggio|grana padano|ricotta|parmigiano|pecorino|gorgonzola|provolone|mascarpone|emmental|comt[ée]|gruy[èe]re|roquefort|camembert|manchego|edam|havarti|\bfeta\b|burrata|halloumi|paneer|queijo|babybel|boursin|\bkiri\b|coulommiers|saint[- ]agur|vache qui rit|carr[ée] frais|st[.]? moret|fromage blanc|from[.]? blanc|fourme|reblochon|munster|\bch[èe]vre\b|\bb[ûu]che\b|fiocchi di latte|\bcurd\b|\bcaglio\b|pr[ée]sure/i],
  ['dairy',   /\bmilk\b|yogurt|yoghurt|\bdairy\b|\bcream\b|\bquark\b|\blait\b|yaourt|\bmilch\b|\bleche\b|\blatte\b/i],
];

/* Sausages are named by shape, not species: "Saucisses 100% poulet" is
   chicken. Only read sausage as pork when nothing else identifies it. */
const WEAK = [
  ['pork', /sausage|saucisse|w[üu]rst|salchicha/i],
];

/* Some sources are refinements of another. Cheese and whey both list
   milk first, because milk is what they are made from — so pure
   dominance-by-position picks the input over the product. Where the
   specific form is present at all, it wins. */
const REFINES = { dairy: ['cheese', 'whey'] };

const stripNoise = t => String(t || '').replace(ALLERGEN, ' ').replace(NOISE, ' ');

/**
 * Classify a product's protein source.
 * Fields stay separate on purpose: ingredients carry far more signal
 * than a marketing name, and blending them caused most of the errors
 * this replaces.
 *
 * @returns {{key: string|null, why: string}}
 */
function classifyProduct({ name = '', ingredients = '', categories = '', vegan = false } = {}){
  const ing  = stripNoise(ingredients);
  const meta = stripNoise([name, categories].filter(Boolean).join(' '));

  const pick = (text, allowAnimal) => {
    let best = null, bestAt = Infinity;
    for (const [key, re] of RULES){
      if (!allowAnimal && ANIMAL.includes(key)) continue;
      const m = re.exec(text);
      if (m && m.index < bestAt){ best = key; bestAt = m.index; }
    }
    if (best) return best;
    for (const [key, re] of WEAK){
      if (!allowAnimal && ANIMAL.includes(key)) continue;
      if (re.test(text)) return key;
    }
    return null;
  };

  /* Database labels are user-contributed and sometimes wrong. A product
     that names its animal protein in the title outranks a vegan tag. */
  const NAMED_ANIMAL = /\bwhey\b|\bcasein\b|lactos[ée]rum|\bmolke\b|\bcollagen\b|\bg[ée]latin/i;
  const nameContradicts = vegan && NAMED_ANIMAL.test(name);
  const allowAnimal = !vegan || nameContradicts;

  let key = ing ? pick(ing, allowAnimal) : null;
  let why = key ? 'ingredients' : '';

  if (!key){ key = pick(meta, allowAnimal); if (key) why = 'name'; }

  /* Cottage cheese lists "cultured skim milk" and never says cheese in
     its ingredients — the word is only in the name. So look for the
     refinement across both fields, not just the one that matched. */
  if (key && REFINES[key]){
    const both = ing + ' ' + meta;
    for (const spec of REFINES[key]){
      if (!allowAnimal && ANIMAL.includes(spec)) continue;
      const re = (RULES.find(r => r[0] === spec) || [])[1];
      if (re && re.test(both)){ key = spec; why += ' + name'; break; }
    }
  }
  if (!key && vegan){ key = 'plant'; why = 'vegan label'; }

  return { key, why };
}

/* Back-compat for callers that pass a single blob. */
function classify(text){
  return classifyProduct({ ingredients: text }).key;
}

const MIN_PROTEIN_100G = 10;
const FALLBACK = { label:'Unresolved', co2:9.5 };

if (typeof module !== 'undefined'){
  module.exports = { SOURCES, TIERS, RULES, WEAK, ANIMAL, ALLERGEN, NOISE,
                     stripNoise, classify, classifyProduct, MIN_PROTEIN_100G, FALLBACK,
                     REF, multFor, tierFor };
}
