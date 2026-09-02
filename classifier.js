/* Per Gram — protein source classifier.
 *
 * Single source of truth. The app and the bulk test both use this file,
 * so the rules cannot drift apart.
 *
 * Footprints are kg CO2e per 100g of PROTEIN, not per kg of food.
 * Per kg of food flatters anything watery.
 */

const SOURCES = {
  pea:      { label:'Pea protein',      co2:0.4,  tier:1 },
  nuts:     { label:'Nuts and seeds',   co2:1.2,  tier:1 },
  soy:      { label:'Soy or tofu',      co2:2.0,  tier:1 },
  legume:   { label:'Beans and lentils',co2:2.7,  tier:1 },
  wheat:    { label:'Wheat or seitan',  co2:2.7,  tier:1 },
  yeast:    { label:'Nutritional yeast', co2:1.5, tier:1 },
  whey:     { label:'Whey or casein',   co2:3.6,  tier:2 },  // economic allocation
  egg:      { label:'Eggs',             co2:4.2,  tier:2 },
  chicken:  { label:'Chicken',          co2:5.7,  tier:2 },
  fish:     { label:'Fish',             co2:6.1,  tier:2 },
  pork:     { label:'Pork',             co2:7.6,  tier:3 },
  dairy:    { label:'Milk protein',     co2:9.5,  tier:3 },
  cheese:   { label:'Cheese',           co2:21.0, tier:3 },  // other end of the whey allocation
  beef:     { label:'Beef or lamb',     co2:50.0, tier:4 },
};

const TIERS = {
  1:{ name:'Plant',          mult:1.00, color:'var(--t1)' },
  2:{ name:'Low-impact',     mult:0.45, color:'var(--t2)' },
  3:{ name:'Dairy and pork', mult:0.25, color:'var(--t3)' },
  4:{ name:'High-impact',    mult:0.05, color:'var(--t4)' },
};

/* Ordered: first match wins, so the specific must precede the general. */
const RULES = [
  [/\bpea protein|\bpisum|yellow pea/i,                         'pea'],
  // Nuts before soy: peanut butter lists soybean or palm oil, and the
  // oil is not the protein.
  [/peanut|almond|cashew|walnut|pecan|pistachio|hazelnut|hemp|pumpkin seed|sunflower seed|\btahini\b|sesame/i,'nuts'],
  [/\bsoy protein|soya protein|\btofu\b|tempeh|edamame|\bsoybeans\b/i,'soy'],
  // "bean" alone is a trap: green, wax and vanilla beans are not legumes.
  [/lentil|chickpea|garbanzo|black bean|kidney bean|pinto bean|navy bean|cannellini|butter bean|\bfava\b|split pea|quinoa|brown rice protein/i,'legume'],
  // Collagen and gelatin are bovine hide and bone. Animal protein wearing
  // a supplement label — and previously falling to the tier 3 fallback,
  // priced five times too generously.
  [/collagen|gelatin|gelatine|bone broth/i,                     'beef'],
  [/seitan|vital wheat gluten|wheat protein|wheat gluten/i,     'wheat'],
  [/nutritional yeast|torula|yeast extract/i,                   'yeast'],
  [/\bbeef|steak|\blamb\b|bison|jerky|ground chuck/i,           'beef'],
  [/\bpork|bacon|\bham\b|prosciutto|sausage/i,                  'pork'],
  // Fish before poultry: "Chicken of the Sea" is tuna.
  [/tuna|salmon|cod\b|tilapia|sardine|anchov|shrimp|\bfish\b|seafood/i,'fish'],
  [/chicken|turkey|poultry/i,                                   'chicken'],
  [/\begg white|\begg\b|albumen/i,                              'egg'],
  [/whey|casein|caseinate|milk protein isolate/i,               'whey'],
  // Cheese before dairy: every cheese label lists milk.
  [/\bcheese\b|cheddar|mozzarella|parmesan|gouda|\bbrie\b|feta|halloumi|\bcolby\b|monterey jack/i,'cheese'],
  [/milk|yogurt|yoghurt|dairy|cream/i,                          'dairy'],
];

/* Oils, lecithins and flavourings are ingredients, not protein sources. */
const NOISE = /\b(soybean|soy|sunflower|palm|canola|rapeseed|coconut|olive|vegetable|corn)\s+oil\b|\bsoy lecithin\b|\blecithin\b|\bnatural flavou?rs?\b|\bbutter flavou?r\b/gi;

const denoise = t => (t || '').replace(NOISE, ' ');

function classify(text){
  const clean = denoise(text);
  for (const [re, key] of RULES){
    if (re.test(clean)) return key;
  }
  return null;
}

/* Protein has to be the point of the food. */
const MIN_PROTEIN_100G = 10;

/* Unresolved never defaults to the top tier — that would be the
   cheapest thing in the app to exploit. */
const FALLBACK = { label:'Unresolved', co2:9.5, tier:3 };

if (typeof module !== 'undefined') {
  module.exports = { SOURCES, TIERS, RULES, NOISE, denoise, classify, MIN_PROTEIN_100G, FALLBACK };
}
