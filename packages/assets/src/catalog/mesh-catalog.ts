import { z } from 'zod';
import { Dims, EntityId, type GeneratorRegistry, GENERATORS, ProductCategory } from '@flat/scene';
import { NameString } from '@flat/scene/primitives';

/**
 * Mesh catalog contracts (M5.0; implemented by M5.2 resolution, M5.3 generators, M5.4 / M5.5 libraries).
 *
 * A `MeshAsset` is GEOMETRY ("a 3-seat sofa shape"), not a product: it has no price and no seller.
 * A product reaches the screen through the resolution chain of `resolveMesh`:
 *   1. `provider`   the retailer's real model, streamed by the local server for personal viewing;
 *   2. `lookalike`  a CC0 / local library asset scaled to the product's exact dims (<= 25% aspect distortion);
 *   3. `parametric` a generator at the exact dims.
 * Item-local frame (origin, +x right, +y up, +z front) is defined in `items/item-helpers.ts`.
 */

type Vec3 = [number, number, number];

// ---------------------------------------------------------------------------------------------
// MeshAsset
// ---------------------------------------------------------------------------------------------

/** `parametric` = built by a generator; `cc0` = committed CC0 / CC-BY library; `3dfuture` = local-only research pack (gitignored). */
export const MeshAssetSource = z.enum(['parametric', 'cc0', '3dfuture']);
export type MeshAssetSource = z.infer<typeof MeshAssetSource>;

/**
 * Library tier of a `cc0` asset: `light` (default; `public/models`, <= 300 KB, fetched when placed) or `hd`
 * (`public/models-hd`, hero models up to 2 MB with 1024 px textures, fetched only when an item resolves to one;
 * lookalike picking prefers them and falls back to the light tier when they cannot be loaded).
 */
export const MeshAssetTier = z.enum(['light', 'hd']);
export type MeshAssetTier = z.infer<typeof MeshAssetTier>;

/** Source-model axis that is the item's FRONT (+z of the item frame). */
export const FrontAxis = z.enum(['+z', '-z', '+x', '-x']);
export type FrontAxis = z.infer<typeof FrontAxis>;

/** Relative `.glb` path under the library folder: no `..`, no absolute path, no URL. */
const AssetFile = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*\.glb$/, 'expected a relative .glb path')
  .refine((p) => !p.split('/').includes('..'), 'path must not contain ".."');

export const MeshAsset = z
  .strictObject({
    id: EntityId.describe('Asset id, e.g. "polyhaven:sofa_03" or "param:sofa". Unique in the catalog.'),
    name: NameString('Human-readable name.'),
    source: MeshAssetSource,
    /** SPDX-like licence, e.g. `CC0-1.0`, `CC-BY-4.0`, `LicenseRef-3D-FUTURE`, `MIT` for our own generators. */
    licence: z.string().min(1).max(64),
    /** Attribution line required by the licence (CC-BY); shown in the credits. */
    credit: z.string().max(300).optional(),
    category: ProductCategory,
    styleTags: z.array(z.string().min(1).max(32)).max(12).default([]),
    /** Size of the model as authored (metres): what scaling to an item's dims starts from. */
    nativeDims: Dims,
    /** Point of the SOURCE model (metres, native scale) that becomes the item origin: footprint centre at the lowest point. */
    anchor: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
    /** Which axis of the source model is the front. */
    front: FrontAxis.default('+z'),
    /** `cc0` / `3dfuture`: relative path of the normalised GLB in the library folder. */
    file: AssetFile.optional(),
    /** `parametric`: generator id (see `Generator`). */
    generator: z.string().min(1).max(64).optional(),
    /** `cc0` assets: the library tier the file lives in (absent = `light`). */
    tier: MeshAssetTier.optional(),
  })
  .refine((a) => (a.source === 'parametric' ? a.generator !== undefined : a.file !== undefined), {
    path: ['file'],
    message: 'parametric assets need a generator; cc0 and 3dfuture assets need a file',
  });
export type MeshAsset = z.infer<typeof MeshAsset>;

/** Largest per-axis aspect distortion accepted when scaling a lookalike to a product's dims (25%). */
export const MAX_LOOKALIKE_DISTORTION = 0.25;

/** Read access to the mesh library (M5.2 builds the real one from `public/models/catalog.json` plus the local pack). */
export interface MeshCatalog {
  list(): readonly MeshAsset[];
  get(id: string): MeshAsset | undefined;
  /** Assets of a category, optionally the best style matches first; deterministic order. */
  search(query: { category?: ProductCategory; styleTags?: readonly string[]; limit?: number }): MeshAsset[];
}

/** A catalog with no assets (until M5.4 builds the library). */
export const EMPTY_MESH_CATALOG: MeshCatalog = {
  list: () => [],
  get: () => undefined,
  search: () => [],
};


export interface LookalikeMatch {
  asset: MeshAsset;
  /** Per-axis scale from `asset.nativeDims` to the product's dims. */
  scale: Vec3;
  /** Largest relative per-axis deviation from uniform scaling (0 = uniform); never above `MAX_LOOKALIKE_DISTORTION`. */
  distortion: number;
  /** Higher = better (category, style tags, proportions); ties broken by asset id. */
  score: number;
}

// ---------------------------------------------------------------------------------------------
// Scaling and lookalike picking
// ---------------------------------------------------------------------------------------------

/**
 * Per-axis scale from `native` to `target` and its distortion: the largest relative deviation of an axis
 * scale from the geometric mean of the three (0 = uniform scaling).
 */
export function scaleToDims(native: Dims, target: Dims): { scale: Vec3; distortion: number } {
  // Item axes (x, y, z) = (w, h, d).
  const scale: Vec3 = [target.w / native.w, target.h / native.h, target.d / native.d];
  const gm = Math.cbrt(scale[0] * scale[1] * scale[2]);
  const distortion = Math.max(...scale.map((s) => Math.abs(s / gm - 1)));
  return { scale, distortion };
}

/** Categories that may stand in for each other when no asset of the exact category exists (lower score). */
const RELATED_CATEGORIES: Partial<Record<ProductCategory, readonly ProductCategory[]>> = {
  armchair: ['sofa', 'chair'],
  sofa: ['armchair'],
  bedside: ['drawers'],
  drawers: ['bedside', 'sideboard'],
  sideboard: ['tv_unit', 'drawers'],
  tv_unit: ['sideboard'],
  shelf: ['wardrobe'],
  desk: ['table'],
  table: ['desk'],
};

const SCORE_CATEGORY = 1000;
const SCORE_RELATED_CATEGORY = 500;
const SCORE_PER_STYLE_TAG = 20;
const SCORE_PROPORTIONS = 10;
/** HD hero models beat an otherwise equal light-tier model (more than the proportions term, less than a style tag). */
const SCORE_HD_TIER = 15;

/**
 * Deterministically picks the library asset that best fits a product: same category (a related one, e.g.
 * armchair <-> sofa, ranks lower), then the most shared style tags, then the closest proportions; `hd` tier assets of the exact
 * category get a small bonus, so the light tier is the fallback. Assets whose
 * scaling would distort the shape by more than `MAX_LOOKALIKE_DISTORTION` are rejected, and so are
 * `parametric` assets (the chain's parametric rung covers those). Ties are broken by asset id.
 */
export function pickLookalike(
  product: { category: ProductCategory; dims: Dims; styleTags?: readonly string[] },
  assets: readonly MeshAsset[],
): LookalikeMatch | undefined {
  const wanted = new Set((product.styleTags ?? []).map((t) => t.toLowerCase()));
  const related = RELATED_CATEGORIES[product.category] ?? [];
  let best: LookalikeMatch | undefined;
  for (const asset of assets) {
    if (asset.source === 'parametric') continue;
    if (asset.styleTags.includes('person')) continue; // the scale figure of the person ghost is never furniture
    const categoryScore = asset.category === product.category ? SCORE_CATEGORY : related.includes(asset.category) ? SCORE_RELATED_CATEGORY : 0;
    if (categoryScore === 0) continue;
    const { scale, distortion } = scaleToDims(asset.nativeDims, product.dims);
    if (!(distortion <= MAX_LOOKALIKE_DISTORTION)) continue;
    const tags = asset.styleTags.filter((t) => wanted.has(t.toLowerCase())).length;
    const hd = asset.tier === 'hd' && categoryScore === SCORE_CATEGORY ? SCORE_HD_TIER : 0;
    const score = categoryScore + SCORE_PER_STYLE_TAG * tags + SCORE_PROPORTIONS * (1 - distortion / MAX_LOOKALIKE_DISTORTION) + hd;
    if (!best || score > best.score || (score === best.score && asset.id < best.asset.id)) best = { asset, scale, distortion, score };
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Catalog implementation
// ---------------------------------------------------------------------------------------------

/** An in-memory `MeshCatalog` over `assets` (throws on duplicate ids). Listing and searching are deterministic (id order, best tag matches first). */
export function createMeshCatalog(assets: readonly MeshAsset[]): MeshCatalog {
  const byId = new Map<string, MeshAsset>();
  for (const a of assets) {
    if (byId.has(a.id)) throw new Error(`duplicate mesh asset id "${a.id}"`);
    byId.set(a.id, a);
  }
  const sorted = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    list: () => sorted,
    get: (id) => byId.get(id),
    search({ category, styleTags, limit }) {
      const wanted = new Set((styleTags ?? []).map((t) => t.toLowerCase()));
      const hits = sorted
        .filter((a) => category === undefined || a.category === category)
        .map((a) => ({ a, tags: a.styleTags.filter((t) => wanted.has(t.toLowerCase())).length }));
      hits.sort((x, y) => y.tags - x.tags); // stable: id order within equal tag counts
      return hits.slice(0, limit ?? hits.length).map((h) => h.a);
    },
  };
}

/** One `parametric` `MeshAsset` per registered generator (`param:<id>`, native dims = the generator's defaults), for `search_assets`. */
export function parametricMeshAssets(registry: GeneratorRegistry = GENERATORS): MeshAsset[] {
  return registry.list().map((g) =>
    MeshAsset.parse({
      id: `param:${g.id}`,
      name: g.label,
      source: 'parametric',
      licence: 'MIT',
      category: g.category,
      nativeDims: g.describeParams(g.params.parse({})).dims,
      generator: g.id,
    }),
  );
}
