import type { Dims } from '../primitives';
import type { ProductCategory } from '../products';
import { colourFromWords } from './colour-words';

// ---------------------------------------------------------------------------------------------
// Default parametric shape per product category
// ---------------------------------------------------------------------------------------------

type Params = Record<string, number | string | boolean>;
const foldName = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** Product names of a kitchen island (French and English). */
const ISLAND_NAME = /\b(ilot|island)\b/;
/** Product names of a sheer curtain (voile). */
const SHEER_NAME = /\b(voilage|voile|sheer|transparent)/;
/** Kind of lamp a product name and height suggest: hanging, wall, floor or table. */
function lampKind(words: string, h: number): 'hanging' | 'wall' | 'floor' | 'table' {
  if (/suspension|pendant|plafonnier|ceiling/.test(words)) return 'hanging';
  if (/applique|wall/.test(words)) return 'wall';
  if (/lampadaire|floor|liseuse|standing/.test(words)) return 'floor';
  return h >= 1 ? 'floor' : 'table';
}
/** Product names of a kitchen sink unit and of a pedestal basin. */
const SINK_NAME = /\b(evier|sink)\b/;
const PEDESTAL_NAME = /colonne|pedestal|pied/;
const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
/** Island products with a turning / extendable table top (a "table-island"), and with open shelves or a wine rack. */
const SWIVEL_NAME = /\b(rotati\w*|pivotan\w*|swivel\w*|extensible|extendable|table (a manger|de bar|bar)|dining)\b/;
const WINE_NAME = /casiers? a vin|range[- ]bouteilles?|porte[- ]bouteilles?|wine/;
const SHELVES_NAME = /etageres?|shelves|shelf|niches?/;

/** The island generator's params for an island product: base cabinets, plus a swivel top and open bays when the name says so. */
function islandFor(name: string, w: number, d: number, h: number): Params {
  const params: Params = { w, d, h, overhang: Math.min(0.3, Math.min(w, d) * 0.35), doors: clampInt(w / 0.5, 0, 6) };
  if (w >= 1) {
    // Bays at the right end: a wine rack and/or open shelves; the doors keep the rest of the width.
    if (WINE_NAME.test(name)) params['wineBays'] = 1;
    if (SHELVES_NAME.test(name)) params['shelfBays'] = 1;
    if (params['wineBays'] !== undefined || params['shelfBays'] !== undefined) params['doors'] = clampInt((w - 0.34 * ((params['wineBays'] ? 1 : 0) + (params['shelfBays'] ? 1 : 0))) / 0.5, 1, 6);
  }
  if (w >= 0.9 && d >= 0.45 && SWIVEL_NAME.test(name)) {
    // Shown closed: the top lies along the island and ends where it ends, so the item box is exactly the listed size (turn it with topAngle on a concept item).
    params['topLength'] = Math.min(3, w - 0.02);
    params['topWidth'] = Math.min(0.55, d * 0.8);
  }
  return params;
}

/**
 * The generator and params that best stand for a product of `category` at exact `dims` (D6), or `undefined`
 * for categories without a sensible parametric shape (appliance, decor, other). `name` and `colour` (the chosen variant) give the colour. The params are NOT
 * validated here; `resolveMesh` checks them against the registry.
 */
export function defaultParametricFor(category: ProductCategory, dims: Dims, name?: string, colour?: string): { generator: string; params: Params } | undefined {
  const { w, d, h } = dims;
  // Colour of the stand-in (a palette name from the product's colour words); absent when the words name none.
  const named = colourFromWords(name, colour);
  const tint: Params = named !== undefined ? { colour: named } : {};
  const words = name !== undefined ? foldName(name) : '';
  switch (category) {
    case 'bed':
      return { generator: 'bed', params: { w, l: d, h, headboard: true } };
    case 'wardrobe':
      return { generator: 'wardrobe', params: { w, d, h, doors: clampInt(w / 0.5, 1, 8), doorType: w < 1 ? 'hinged' : 'sliding' } };
    case 'bedside':
      return { generator: 'nightstand', params: { w, d, h, drawers: h >= 0.45 ? 2 : 1 } };
    case 'drawers':
      return { generator: 'sideboard', params: { w, d, h, doors: 0, drawers: clampInt(h / 0.25, 1, 4) } };
    case 'shelf':
      return { generator: 'bookshelf', params: { w, d, h, shelves: clampInt(h / 0.38 - 1, 0, 12) } };
    case 'sideboard':
      return { generator: 'sideboard', params: { w, d, h, doors: clampInt(w / 0.6, 0, 6), drawers: 0 } };
    case 'tv_unit':
      return { generator: 'tvUnit', params: { w, d, h, doors: clampInt(w / 0.6, 0, 6), drawers: 0 } };
    case 'table':
      return { generator: 'table', params: { w, d, h, legs: 4 } };
    case 'desk':
      return { generator: 'desk', params: { w, d, h, drawers: w >= 1.2 ? 2 : 0 } };
    case 'chair':
      return { generator: 'chair', params: { w, d, h, seat: Math.max(0.3, Math.min(0.55, h * 0.53)) } };
    case 'armchair':
      return { generator: 'sofa', params: { w, d, h, seats: 1 } };
    case 'sofa':
      return { generator: 'sofa', params: { w, d, h, seats: clampInt((w - 0.3) / 0.65, 1, 6) } };
    case 'rug':
      return { generator: 'rug', params: { w, d, h, photo: true, ...tint } };
    case 'mirror':
      return { generator: 'mirror', params: { w, d, h } };
    case 'cushion':
      return { generator: 'cushion', params: { w, d, h, photo: true, ...tint } };
    case 'throw':
      return { generator: 'throwBlanket', params: { w, d, h, photo: true, ...tint } };
    case 'curtain':
      return { generator: 'curtains', params: { w, d, h, sheer: SHEER_NAME.test(words), tint: true, ...tint } };
    case 'frame':
      return { generator: 'frame', params: { w, d, h, photo: true, ...tint } };
    case 'plant':
      return { generator: 'plant', params: { w, d, h, ...tint } };
    case 'vase':
      return { generator: 'vase', params: { w, d, h, tint: true, ...tint } };
    case 'lamp':
      return { generator: 'lamp', params: { w, d, h, kind: lampKind(words, h), tint: true, ...tint } };
    case 'wall_cabinet':
      return { generator: 'kitchenWall', params: { w, d, h, doors: clampInt(w / 0.45, 1, 4) } };
    case 'kitchen':
      // A free-standing island (by its name): base cabinets, a full worktop and a stool overhang instead of a single run unit.
      if (name !== undefined && ISLAND_NAME.test(foldName(name)) && Math.min(w, d) >= 0.5) {
        return { generator: 'island', params: islandFor(words, w, d, h) };
      }
      return { generator: 'kitchenBase', params: { w, d, h, doors: clampInt(w / 0.45, 0, 4), drawers: 0, worktop: true } };
    case 'vanity':
      return { generator: 'sideboard', params: { w, d, h, doors: 0, drawers: clampInt(h / 0.25, 1, 4) } };
    case 'kitchen_island':
      return { generator: 'island', params: islandFor(words, w, d, h) };
    case 'tall_cabinet':
    case 'appliance_housing':
      return { generator: 'wardrobe', params: { w, d, h, doors: clampInt(w / 0.5, 1, 8), doorType: 'hinged' } };
    case 'washbasin':
      // The washbasin generator only covers bathroom sizes; anything else (a tall column, a wall basin) is a plain cabinet.
      if (w >= 0.3 && w <= 1.8 && d >= 0.3 && d <= 0.8 && h >= 0.6 && h <= 1) {
        return { generator: 'washbasin', params: { kind: SINK_NAME.test(words) ? 'sink' : PEDESTAL_NAME.test(words) ? 'pedestal' : 'vanity', w, d, h, ...tint } };
      }
      return { generator: 'sideboard', params: { w, d, h, doors: clampInt(w / 0.6, 0, 4), drawers: 0 } };
    case 'towel_rail':
      return { generator: 'wallFitting', params: { w, d, h, kind: 'rail', ...tint } };
    case 'radiator':
      return { generator: 'radiator', params: { w, d, h, kind: /serviette|towel/.test(words) ? 'towel' : 'panel' } };
    case 'hook':
      return { generator: 'wallFitting', params: { w, d, h, kind: 'hook', ...tint } };
    case 'bath_accessory':
      return { generator: 'wallFitting', params: { w, d, h, kind: 'accessory', ...tint } };
    case 'shower_curtain':
      return { generator: 'curtains', params: { w, d, h, sheer: false, panels: 1, tint: true, ...tint } };
    case 'storage':
      return { generator: 'basket', params: { w, d, h, ...tint } };
    case 'appliance':
    case 'decor':
    case 'other':
      return undefined;
  }
}
