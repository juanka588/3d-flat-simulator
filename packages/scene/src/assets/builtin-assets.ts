import { tvDims } from './generators/misc';

/** Legacy `builtin:*` assets (pre-M5 items). Kept apart from `builtin.ts` so `catalog.ts` can read it without an import cycle. */

export type AssetCategory = 'electronics';
export type AssetMount = 'floor' | 'wall';

export interface BuiltinAsset {
  name: string;
  category: AssetCategory;
  /** Width (local x), depth (local z) and height (local y) in metres. */
  dims: { w: number; d: number; h: number };
  mount: AssetMount;
}

const TV_55 = tvDims(55);

export const BUILTIN_ASSETS: Record<string, BuiltinAsset> = {
  'builtin:tv-55': {
    name: 'TV 55″',
    category: 'electronics',
    dims: { w: TV_55.w, d: TV_55.d, h: TV_55.h },
    mount: 'wall',
  },
};

export function isBuiltinAsset(assetId: string): boolean {
  return Object.hasOwn(BUILTIN_ASSETS, assetId);
}
