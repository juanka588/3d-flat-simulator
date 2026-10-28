/** Legacy `builtin:*` assets (pre-M5 items). */

/** Diagonal of a 55 inch screen: 55 x 0.0254 m. */
export const TV_55_DIAGONAL_M = 55 * 0.0254;
/** Thin bezel: 6 mm at the sides, 12.5 mm above and below the panel. */
const TV_BEZEL_SIDE = 0.006;
const TV_BEZEL_VERTICAL = 0.0125;
const TV_D = 0.05;

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Visible 16:9 panel and the overall outer dims of a TV of `inches` diagonal. */
export function tvDims(inches: number): { screenW: number; screenH: number; w: number; d: number; h: number } {
  const diagonal = inches * 0.0254;
  const screenW = (diagonal * 16) / Math.hypot(16, 9);
  const screenH = (diagonal * 9) / Math.hypot(16, 9);
  return { screenW, screenH, w: round3(screenW + 2 * TV_BEZEL_SIDE), d: TV_D, h: round3(screenH + 2 * TV_BEZEL_VERTICAL) };
}

export type AssetCategory = 'electronics' | 'lamp';
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
