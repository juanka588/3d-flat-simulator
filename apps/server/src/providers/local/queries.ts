import { PRODUCT_CATEGORIES, type ProductCategory } from '@flat/scene';

/**
 * The curated query list of `pnpm catalog:build`: the "modern French flat" kit of `docs/research/m5-modern-assets.md`
 * (rooms -> item types, translated to French) plus the decor categories. NOT a crawl of the whole shop: each query keeps at
 * most `--per-query` results (12) and the build stops at `--max-products` (400).
 *
 * `category` (optional) keeps only hits whose shop product type maps to that category, so "tabouret de bar" does not bring
 * bar-stool covers. The order matters: the build goes breadth-first (a few results of every query per round), so the
 * first queries are the ones every flat needs.
 */
export interface QuerySpec {
  q: string;
  category?: ProductCategory;
}

const Q = (q: string, category?: ProductCategory): QuerySpec => (category ? { q, category } : { q });

export const DEFAULT_QUERIES: readonly QuerySpec[] = [
  // Living (séjour)
  Q('canapé 3 places', 'sofa'),
  Q('lit 160x200', 'bed'),
  Q('table basse', 'table'),
  Q('meuble TV', 'tv_unit'),
  Q('fauteuil', 'armchair'),
  Q('table à manger', 'table'),
  Q('chaise de salle à manger', 'chair'),
  Q('armoire', 'wardrobe'),
  Q('table de chevet', 'bedside'),
  Q('bureau', 'desk'),
  Q('tapis', 'rug'),
  Q('rideaux', 'curtain'),
  Q('lampe de table', 'lamp'),
  Q('suspension', 'lamp'),
  Q('lampadaire', 'lamp'),
  Q('bibliothèque', 'shelf'),
  Q('étagère murale'),
  Q('miroir', 'mirror'),
  Q('cadre photo', 'frame'),
  Q('plante artificielle', 'plant'),
  Q('coussin', 'cushion'),
  Q('plaid', 'throw'),
  Q('vase', 'vase'),
  Q('commode', 'drawers'),
  Q('canapé d’angle', 'sofa'),
  Q('canapé 2 places', 'sofa'),
  Q('banc TV', 'tv_unit'),
  Q('buffet', 'sideboard'),
  Q('table d’appoint', 'table'),
  Q('pouf'),
  Q('applique murale', 'lamp'),
  Q('miroir rond', 'mirror'),
  Q('tapis 200x300', 'rug'),
  Q('rideaux occultants', 'curtain'),
  // Kitchen
  Q('îlot cuisine'),
  Q('tabouret de bar', 'chair'),
  Q('suspension cuisine', 'lamp'),
  Q('réfrigérateur', 'appliance'),
  Q('lave-vaisselle', 'appliance'),
  Q('four encastrable', 'appliance'),
  Q('plaque de cuisson', 'appliance'),
  Q('hotte', 'appliance'),
  Q('évier cuisine'),
  Q('élément mural cuisine'),
  Q('armoire colonne cuisine'),
  Q('étagère ouverte cuisine'),
  // Dining
  Q('table à manger 6 personnes', 'table'),
  Q('banc de salle à manger', 'chair'),
  Q('vaisselier', 'sideboard'),
  Q('suspension salle à manger', 'lamp'),
  Q('table ronde', 'table'),
  Q('chaise en bois', 'chair'),
  // Bedroom
  Q('lit 140x200', 'bed'),
  Q('lit 90x200', 'bed'),
  Q('lit avec rangement', 'bed'),
  Q('armoire PAX', 'wardrobe'),
  Q('armoire 2 portes', 'wardrobe'),
  Q('chaise de bureau', 'chair'),
  Q('bureau d’angle', 'desk'),
  Q('banc bout de lit', 'chair'),
  Q('lampe de chevet', 'lamp'),
  Q('commode 6 tiroirs', 'drawers'),
  Q('coiffeuse'),
  // Bathroom
  Q('meuble lavabo'),
  Q('miroir salle de bain', 'mirror'),
  Q('armoire de toilette'),
  Q('lave-linge', 'appliance'),
  Q('panier à linge'),
  Q('meuble salle de bain colonne'),
  // Entrance
  Q('banc à chaussures'),
  Q('meuble à chaussures'),
  Q('patère'),
  Q('porte-manteau'),
  Q('console d’entrée'),
  Q('miroir d’entrée', 'mirror'),
  // Balcony
  Q('salon de jardin'),
  Q('table de jardin', 'table'),
  Q('chaise de jardin', 'chair'),
  Q('fauteuil extérieur', 'armchair'),
  Q('jardinière'),
  Q('tapis extérieur', 'rug'),
  Q('table bistro balcon', 'table'),
  // Decor
  Q('plante verte', 'plant'),
  Q('plante en pot', 'plant'),
  Q('cadre mural', 'frame'),
  Q('coussin de canapé', 'cushion'),
  Q('plaid en laine', 'throw'),
  Q('panier de rangement'),
  Q('horloge murale'),
  Q('bougeoir'),
  Q('tapis rond', 'rug'),
  Q('rangement TV'),
  Q('étagère à livres', 'shelf'),
  Q('étagère KALLAX', 'shelf'),
  Q('console', 'sideboard'),
  Q('table haute bar', 'table'),
  Q('lampe à poser', 'lamp'),
  Q('fauteuil de bureau', 'chair'),
  // Coverage (CG4): the bathroom and kitchen items the CG3 matcher found missing from the local catalogue ('miroir salle de bain' and 'suspension cuisine' were already listed above).
  Q('meuble sous vasque'),
  Q('vasque'),
  Q('armoire de toilette'),
  Q('porte-serviettes'),
  Q('robinet'),
  Q('crédence'),
  Q('tabouret', 'chair'),
  Q('accessoires salle de bain'),
  Q('rideau de douche', 'curtain'),
  Q('tapis de bain', 'rug'),
  Q('plantes', 'plant'),
  Q('luminaires salle de bain', 'lamp'),
];

/**
 * Products already used in the design sessions of this project (IKEA FR article numbers of the flat in `apps/server/data`).
 * Built first, so a flat you already furnished keeps working offline. Add your own with `--from-scene <file.flat.json>`.
 */
export const SEED_SKUS: readonly string[] = [
  '00492677', '00586548', '00600894', '00609880', '10470991', '10492672', '10500059', '10539269', '10543737', '10592365',
  '10615244', '10624328', '19445469', '20426808', '20595132', '30513598', '30608983', '40391657', '40456757', '40569467',
  '40619071', '50614997', '60538205', '60566401', '60627980', '80262187', '80480393', '80574099', '80587718', '80587921',
  '80593597', '80597171', '90478120',
];

/** Article numbers of the IKEA FR product items in a scene file (`*.flat.json`): `productRef` or the product snapshot. */
export function skusFromScene(sceneJson: unknown): string[] {
  const items = (sceneJson as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out = new Set<string>();
  for (const it of items as { productRef?: { provider?: string; sku?: string }; product?: { provider?: string; sku?: string } }[]) {
    const ref = it.productRef ?? it.product;
    if (ref?.provider === 'ikea-fr' && typeof ref.sku === 'string' && /^\d{8}$/.test(ref.sku)) out.add(ref.sku);
  }
  return [...out];
}

/** One query per line, optionally `query | category`; `#` starts a comment. Throws on an unknown category. */
export function parseQueriesFile(text: string): QuerySpec[] {
  const out: QuerySpec[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [q, cat] = line.split('|').map((s) => s.trim());
    if (!q) continue;
    if (cat && !(PRODUCT_CATEGORIES as readonly string[]).includes(cat)) throw new Error(`queries file line ${i + 1}: unknown category "${cat}"`);
    out.push(cat ? { q, category: cat as ProductCategory } : { q });
  }
  return out;
}
