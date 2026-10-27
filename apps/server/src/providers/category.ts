import type { ProductCategory } from '@flat/scene';

/** Accent- and case-folded text, for keyword matching. */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** First match wins, so the specific words (bedside table) come before the generic ones (table, bed). French and English. */
const CATEGORY_RULES: [RegExp, ProductCategory][] = [
  // Lamps first: "lampe de table" / "lampe de chevet" must not become a table / a bedside table.
  [/\b(lampes?|lampadaires?|luminaires?|appliques?|suspension|liseuse|lamp|light)\b/, 'lamp'],
  // Soft furnishings next: "coussin de chaise" is a cushion, not a chair; "rideau" and "store" before the generic words.
  [/\b(coussins?|housses? de coussin|cushions?)\b/, 'cushion'],
  [/\b(plaids?|jetes? de canape|couvertures?|throws?|blankets?)\b/, 'throw'],
  [/\b(tringles?|rails? a rideaux)\b/, 'other'],
  [/\b(rideaux?|voilages?|stores?|curtains?|blinds?|panneaux? japonais|panneaux? coulissants?)\b/, 'curtain'],
  [/\b(chevet|bedside|nightstand|night stand)\b/, 'bedside'],
  [/\b(lit|lits|cadre de lit|structure de lit|bed|bed frame|bedstead)\b/, 'bed'],
  [/\b(armoire|penderie|garde-robe|dressing|wardrobe|closet)\b/, 'wardrobe'],
  [/\b(commode|chiffonnier|tiroirs?|dresser|chest of drawers|drawers)\b/, 'drawers'],
  [/\b(meuble tv|banc tv|meuble pour tv|tv unit|tv stand|tv cabinet)\b/, 'tv_unit'],
  [/\b(buffet|bahut|vaisselier|desserte|sideboard)\b/, 'sideboard'],
  [/\b(etageres?|bibliotheques?|bookcase|bookshelf|shelf|shelves|shelving)\b/, 'shelf'],
  [/\b(bureau|bureaux|desk)\b/, 'desk'],
  [/\b(fauteuils?|armchair)\b/, 'armchair'],
  [/\b(canape|canapes|banquette|sofa|couch|loveseat)\b/, 'sofa'],
  [/\b(chaises?|tabourets?|bancs?|chair|stool|bench)\b/, 'chair'],
  [/\b(tables?)\b/, 'table'],
  [/\b(tapis|paillassons?|rug|carpet|doormat)\b/, 'rug'],
  [/\b(miroirs?|glaces?|mirror)\b/, 'mirror'],
  [/\b(cadres?|frames?)\b/, 'frame'],
  [/\b(vases?)\b/, 'vase'],
  [/\b(plantes?|plants?|succulentes?|fleurs? artificielles?|bouquets?)\b/, 'plant'],
  [/\b(element mural|elements muraux|meuble mural|armoire murale|wall cabinet)\b/, 'wall_cabinet'],
  [/\b(cuisine|cuisines|meuble bas|meuble haut|kitchen)\b/, 'kitchen'],
  [/\b(four|refrigerateur|congelateur|lave-vaisselle|hotte|plaque|micro-ondes|lave-linge|fridge|oven|dishwasher)\b/, 'appliance'],
  [/\b(decoration|bougie|cache-pots?|decor)\b/, 'decor'],
];

/** Coarse category from a product type, a title or a category path (first rule that matches any of `texts`, in order). */
export function categoryOf(typeName: string, categoryPath: readonly string[] = []): ProductCategory {
  const type = fold(typeName);
  for (const [re, cat] of CATEGORY_RULES) if (re.test(type)) return cat;
  const path = fold(categoryPath.join(' | '));
  for (const [re, cat] of CATEGORY_RULES) if (re.test(path)) return cat;
  return 'other';
}

/** Categories that hang on a wall. */
export const WALL_CATEGORIES = new Set<ProductCategory>(['mirror', 'wall_cabinet', 'frame', 'curtain']);

/** Names that say a product hangs on a wall although its shop category does not ("Étagère murale", "Wall shelf", "Applique murale"). */
const WALL_NAME = /\b(murale?s?|muraux|mural|wall[- ]?mounted|wall[- ]?shelf|wall[- ]?shelves|wall lamp|a fixer au mur|suspendu au mur)\b/;

/** How a product is fixed: the category's mount, else "wall" when its name says so (IKEA lists a wall shelf as an ordinary shelf). */
export function mountOf(name: string, category: ProductCategory): 'wall' | 'floor' {
  if (WALL_CATEGORIES.has(category)) return 'wall';
  return WALL_NAME.test(fold(name)) ? 'wall' : 'floor';
}
