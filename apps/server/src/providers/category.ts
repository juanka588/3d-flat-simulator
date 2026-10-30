import type { ProductCategory } from '@flat/scene';

/** Accent- and case-folded text, for keyword matching. */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** First match wins, so the specific words (bedside table) come before the generic ones (table, bed). French and English. */
const CATEGORY_RULES: [RegExp, ProductCategory][] = [
  // Bathroom first: "rideau de douche" is not a curtain, "meuble lavabo" is not a washbasin, "etagere douche" is not a shelf.
  [/\b(rideaux? de (douche|bain|baignoire)|shower curtains?)\b/, 'shower_curtain'],
  [/\b(porte|portant|seche|support)s?[- ]serviettes?\b|\btowel (rail|rack|holder|ring)s?\b|\bbarre a serviettes\b/, 'towel_rail'],
  [/\b(radiateurs?|radiators?|convecteurs?)\b/, 'radiator'],
  [/\b(meubles?|elements?|caissons?|armoires?)( bas)? (sous[- ]|de )?(lavabos?|vasques?)\b|\bsous[- ]lavabo\b|\bvanity\b|\bwash ?stand\b/, 'vanity'],
  [/\b(vasques?|lavabos?|washbasins?|wash basins?|basin)\b/, 'washbasin'],
  [/\b(etageres?|tablettes?|paniers?|accessoires?) (de |pour )?(douche|bain|salle de bain)\b|\bpanier a ventouse\b|\bporte-savons?\b|\bshower (shelf|caddy|rack)\b/, 'bath_accessory'],
  [/\b(patere?s?|crochets?|hooks?|coat hooks?)\b/, 'hook'],
  // Kitchen islands and tall units before the generic shelf / drawers / kitchen words ("Colonne avec portes et tiroirs").
  [/\b(ilots?|islands?)\b/, 'kitchen_island'],
  [/\b(armoires?|caissons?|colonnes?|elements?|meubles?)( bas| haut)? (pour |de |a )?(four|micro-ondes|micro ondes|refrigerateur|frigo|congelateur|lave-vaisselle|lave-linge)\b|\b(oven|microwave|fridge) (housing|cabinet|unit)\b/, 'appliance_housing'],
  [/\b(colonnes?|tall cabinet|tall unit)\b/, 'tall_cabinet'],
  [/\b(rails? (de )?susp|rails? susp|rails? de rangement)\b/, 'hook'],
  // Lamps next: "lampe de table" / "lampe de chevet" must not become a table / a bedside table.
  [/\b(lampes?|lampadaires?|luminaires?|appliques?|suspension|liseuse|lamp|light)\b/, 'lamp'],
  // Soft furnishings next: "coussin de chaise" is a cushion, not a chair; "rideau" and "store" before the generic words.
  [/\b(coussins?|housses? de coussin|cushions?)\b/, 'cushion'],
  [/\b(plaids?|jetes? de canape|couvertures?|throws?|blankets?)\b/, 'throw'],
  [/\b(tringles?|rails? a rideaux)\b/, 'other'],
  [/\b(rideaux?|voilages?|stores?|curtains?|blinds?|panneaux? japonais|panneaux? coulissants?)\b/, 'curtain'],
  [/\b(chevet|bedside|nightstand|night stand)\b/, 'bedside'],
  [/\b(lit|lits|cadre de lit|structure de lit|bed|bed frame|bedstead)\b/, 'bed'],
  // TV storage before wardrobes: "Rangement TV/vitrines", "Combinaison TV/rangement".
  [/\b(meuble tv|banc tv|meuble pour tv|tv unit|tv stand|tv cabinet|tv|television)\b/, 'tv_unit'],
  // Shoe racks are low cabinets, not wardrobes or appliances.
  [/\brange-chaussures\b/, 'sideboard'],
  [/\b(armoire|penderie|garde-robe|dressing|wardrobe|closet)\b/, 'wardrobe'],
  [/\b(commode|chiffonnier|coiffeuses?|tiroirs?|dresser|chest of drawers|drawers)\b/, 'drawers'],
  [/\b(buffet|bahut|vaisselier|desserte|sideboard)\b/, 'sideboard'],
  [/\b(element haut|elements hauts|meuble haut)\b/, 'wall_cabinet'],
  [/\b(etageres?|bibliotheques?|bookcase|bookshelf|shelf|shelves|shelving)\b/, 'shelf'],
  [/\b(bureau|bureaux|desk)\b/, 'desk'],
  [/\b(fauteuils?|armchair)\b/, 'armchair'],
  [/\b(canape|canapes|banquette|sofa|couch|loveseat)\b/, 'sofa'],
  [/\b(chaises?|tabourets?|bancs?|chair|stool|bench)\b/, 'chair'],
  [/\b(horloges?|clocks?)\b/, 'decor'],
  [/\b(tables?)\b/, 'table'],
  [/\b(tapis|paillassons?|rug|carpet|doormat)\b/, 'rug'],
  [/\b(miroirs?|glaces?|mirror)\b/, 'mirror'],
  [/\b(cadres?|frames?)\b/, 'frame'],
  [/\b(vases?)\b/, 'vase'],
  [/\b(piedestals?|jardinieres?)\b/, 'decor'],
  [/\b(plantes?|plants?|succulentes?|fleurs? artificielles?|bouquets?)\b/, 'plant'],
  [/\b(element mural|elements muraux|meuble mural|armoire murale|wall cabinet)\b/, 'wall_cabinet'],
  [/\b(cuisine|cuisines|meuble bas|meuble haut|kitchen)\b/, 'kitchen'],
  [/\bsupport pour lave|\bkit empilage\b/, 'other'],
  [/\b(four|refrigerateur|congelateur|lave-vaisselle|hotte|plaque|micro-ondes|lave-linge|fridge|oven|dishwasher)\b/, 'appliance'],
  [/\b(paniers? a linge|sacs? a linge|paniers?|poubelles?|boites?|rangement tissu|corbeille|valet|portants?|hampers?|laundry|bins?|baskets?)\b/, 'storage'],
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

/** Categories that hang on a wall. A washbasin counts: IKEA basins are wall-hung or sit `on` a vanity (the `on` relation overrides the mount). */
export const WALL_CATEGORIES = new Set<ProductCategory>(['mirror', 'wall_cabinet', 'frame', 'curtain', 'shower_curtain', 'towel_rail', 'bath_accessory', 'hook', 'washbasin', 'radiator']);

/** Names that say a product hangs on a wall although its shop category does not ("Étagère murale", "Wall shelf", "Applique murale"). */
const WALL_NAME = /\b(murale?s?|muraux|mural|wall[- ]?mounted|wall[- ]?shelf|wall[- ]?shelves|wall lamp|a fixer au mur|suspendu au mur|appliques?|baguette lumin\w*|rails? susp\w*)\b/;

/** Names that say a normally hung product stands ("Miroir sur pied"). */
const STANDING_NAME = /\b(sur pied|standing|free[- ]?standing|sur roulettes)\b/;

/** How a product is fixed: the category's mount, else "wall" when its name says so (IKEA lists a wall shelf as an ordinary shelf). */
export function mountOf(name: string, category: ProductCategory): 'wall' | 'floor' {
  const n = fold(name);
  if (STANDING_NAME.test(n)) return 'floor';
  if (WALL_CATEGORIES.has(category)) return 'wall';
  return WALL_NAME.test(n) ? 'wall' : 'floor';
}

/**
 * Category and mount of a product from its shop type and its name (no category path: the local catalogue does not keep one).
 * The type decides; the name is consulted only when the type is empty or unrecognised. `previous` (the category stored before)
 * is kept when neither says anything ("other" never replaces a real category).
 */
export function reclassify(typeName: string, name: string, previous?: ProductCategory): { category: ProductCategory; mount: 'wall' | 'floor' } {
  let category = typeName.trim() ? categoryOf(typeName) : 'other';
  if (category === 'other') category = categoryOf(name.replace(/^(?:(?:[A-ZÀ-ÖØ-Þ0-9]{2,}|\/)\s*)+/, ''));
  if (category === 'other' && previous !== undefined) category = previous;
  return { category, mount: mountOf(name, category) };
}
