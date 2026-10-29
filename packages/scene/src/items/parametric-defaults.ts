import type { Dims } from '../primitives';
import type { ProductCategory } from '../products';

// ---------------------------------------------------------------------------------------------
// Default parametric shape per product category
// ---------------------------------------------------------------------------------------------

type Params = Record<string, number | string | boolean>;
const foldName = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** Product names of a kitchen island (French and English). */
const ISLAND_NAME = /\b(ilot|island)\b/;
const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/**
 * The generator and params that best stand for a product of `category` at exact `dims` (D6), or `undefined`
 * for categories without a sensible parametric shape (lamp, appliance, decor, other). The params are NOT
 * validated here; `resolveMesh` checks them against the registry.
 */
export function defaultParametricFor(category: ProductCategory, dims: Dims, name?: string): { generator: string; params: Params } | undefined {
  const { w, d, h } = dims;
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
      return { generator: 'rug', params: { w, d } };
    case 'mirror':
      return { generator: 'mirror', params: { w, h } };
    case 'wall_cabinet':
      return { generator: 'kitchenWall', params: { w, d, h, doors: clampInt(w / 0.45, 1, 4) } };
    case 'kitchen':
      // A free-standing island (by its name): base cabinets, a full worktop and a stool overhang instead of a single run unit.
      if (name !== undefined && ISLAND_NAME.test(foldName(name)) && Math.min(w, d) >= 0.5) {
        return { generator: 'island', params: { w, d, h, overhang: Math.min(0.3, Math.min(w, d) * 0.35), doors: clampInt(w / 0.5, 0, 6) } };
      }
      return { generator: 'kitchenBase', params: { w, d, h, doors: clampInt(w / 0.45, 0, 4), drawers: 0, worktop: true } };
    case 'vanity':
      return { generator: 'sideboard', params: { w, d, h, doors: 0, drawers: clampInt(h / 0.25, 1, 4) } };
    case 'kitchen_island':
      return { generator: 'island', params: { w, d, h, overhang: Math.min(0.3, Math.min(w, d) * 0.35), doors: clampInt(w / 0.5, 0, 6) } };
    case 'tall_cabinet':
    case 'appliance_housing':
      return { generator: 'wardrobe', params: { w, d, h, doors: clampInt(w / 0.5, 1, 8), doorType: 'hinged' } };
    case 'lamp':
    case 'washbasin':
    case 'towel_rail':
    case 'bath_accessory':
    case 'shower_curtain':
    case 'hook':
    case 'storage':
    case 'appliance':
    case 'decor':
    case 'curtain':
    case 'plant':
    case 'vase':
    case 'frame':
    case 'cushion':
    case 'throw':
    case 'other':
      return undefined;
  }
}
