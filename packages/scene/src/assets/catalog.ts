import { z } from 'zod';
import type { MeshData } from '../geometry/types';
import { Clearance, Dims, EntityId, NameString } from '../primitives';
import { ProductCategory, formatProductId, type ProductId, type ProductRef } from '../products';
import type { Item } from '../schema';
import { BUILTIN_ASSETS } from './builtin-assets';

/**
 * Mesh catalog contracts (M5.0; implemented by M5.2 resolution, M5.3 generators, M5.4 / M5.5 libraries).
 *
 * A `MeshAsset` is GEOMETRY ("a 3-seat sofa shape"), not a product: it has no price and no seller.
 * A product reaches the screen through the resolution chain of `resolveMesh`:
 *   1. `provider`   the retailer's real model, streamed by the local server for personal viewing;
 *   2. `lookalike`  a CC0 / local library asset scaled to the product's exact dims (<= 25% aspect distortion);
 *   3. `parametric` a generator at the exact dims.
 * Item-local frame (origin, +x right, +y up, +z front) is defined in `builtin.ts`.
 */

type Vec3 = [number, number, number];

// ---------------------------------------------------------------------------------------------
// MeshAsset
// ---------------------------------------------------------------------------------------------

/** `parametric` = built by a generator; `cc0` = committed CC0 / CC-BY library; `3dfuture` = local-only research pack (gitignored). */
export const MeshAssetSource = z.enum(['parametric', 'cc0', '3dfuture']);
export type MeshAssetSource = z.infer<typeof MeshAssetSource>;

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

// ---------------------------------------------------------------------------------------------
// Generators (lane A / M5.3)
// ---------------------------------------------------------------------------------------------

/** Named attachment point in the item frame (`back-centre`, `front-centre`, `top`, ...), metres. */
export interface GeneratorAnchor {
  name: string;
  position: Vec3;
}

/** What a generator promises for a given set of parameters: exact outer dims (+-1 mm), anchors, clearance. */
export interface GeneratorDescription {
  dims: Dims;
  anchors: GeneratorAnchor[];
  clearance: Clearance;
}

/**
 * A pure, deterministic parametric furniture generator. `params` validates the scalar parameters
 * (a `MeshSource` of kind `parametric` carries them); `describeParams` is cheap (no geometry) and is
 * what scene validation and the placement solver use; `generate` builds the mesh in the item frame at
 * exactly `describeParams(params).dims`, owner kind `item`, at most 3k triangles.
 */
export interface Generator<P = Record<string, unknown>> {
  id: string;
  label: string;
  category: ProductCategory;
  params: z.ZodType<P>;
  describeParams(params: P): GeneratorDescription;
  generate(params: P): MeshData;
}

/** A generator of any parameter type (registries store them type-erased). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- params type is erased in the registry
export type AnyGenerator = Generator<any>;

/** Registry of generators. Lane A fills it; the default one is empty, so scene validation skips unknown generators. */
export interface GeneratorRegistry {
  get(id: string): AnyGenerator | undefined;
  list(): readonly AnyGenerator[];
  register(generator: AnyGenerator): void;
  unregister(id: string): void;
}

export function createGeneratorRegistry(): GeneratorRegistry {
  const map = new Map<string, AnyGenerator>();
  return {
    get: (id) => map.get(id),
    list: () => [...map.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    register(g) {
      if (map.has(g.id)) throw new Error(`generator "${g.id}" is already registered`);
      map.set(g.id, g);
    },
    unregister: (id) => void map.delete(id),
  };
}

/**
 * The process-wide registry used by `Scene` validation. EMPTY until M5.3 registers the generators (by
 * importing its barrel from the entry points that need it). Tests may register fakes and must unregister them.
 */
export const GENERATORS: GeneratorRegistry = createGeneratorRegistry();

/** Relative tolerance between an item's dims and its generator's dims (2%), with a 1 mm floor. */
export const GENERATOR_DIMS_TOLERANCE = 0.02;

export type GeneratorCheck =
  | { status: 'unknown_generator'; generator: string }
  | { status: 'invalid_params'; generator: string; issues: string[] }
  | { status: 'ok'; generator: string; dims: Dims }
  | { status: 'dims_mismatch'; generator: string; expected: Dims; actual: Dims };

/**
 * Checks a `parametric` mesh source against the registry: the generator must accept the params and,
 * when the caller knows the dims the item claims (`item.dims ?? item.product.dims`), `describeParams`
 * must agree with them within `GENERATOR_DIMS_TOLERANCE`. Unknown generators are not an error here (the
 * caller decides: scene parsing skips them, `validateScene` warns).
 */
export function checkParametricMesh(
  mesh: { generator: string; params: Record<string, unknown> },
  claimedDims: Dims | undefined,
  registry: GeneratorRegistry = GENERATORS,
): GeneratorCheck {
  const g = registry.get(mesh.generator);
  if (!g) return { status: 'unknown_generator', generator: mesh.generator };
  const parsed = g.params.safeParse(mesh.params);
  if (!parsed.success) {
    return { status: 'invalid_params', generator: g.id, issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`) };
  }
  const expected = g.describeParams(parsed.data).dims;
  if (claimedDims) {
    const ok = (a: number, b: number) => Math.abs(a - b) <= Math.max(GENERATOR_DIMS_TOLERANCE * b, 0.001);
    if (!ok(claimedDims.w, expected.w) || !ok(claimedDims.d, expected.d) || !ok(claimedDims.h, expected.h)) {
      return { status: 'dims_mismatch', generator: g.id, expected, actual: claimedDims };
    }
  }
  return { status: 'ok', generator: g.id, dims: expected };
}

// ---------------------------------------------------------------------------------------------
// MeshSource (stored on Item.mesh)
// ---------------------------------------------------------------------------------------------

/** Cap on the scalar parameters of a parametric source (keys). */
export const MAX_GENERATOR_PARAMS = 32;
const ParamValue = z.union([z.number(), z.string().max(64), z.boolean()]);

/**
 * How an item's shape is obtained. Stored on `Item.mesh` so a saved flat re-resolves the same way:
 *  - `provider`: the real model of `Item.productRef`, fetched from the local server at view time;
 *  - `lookalike`: library asset `assetId`, scaled to the item's exact dims;
 *  - `parametric`: generator `generator` with scalar `params` (sizes, counts, style switches).
 */
export const MeshSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('provider') }),
  z.strictObject({ kind: z.literal('lookalike'), assetId: EntityId }),
  z.strictObject({
    kind: z.literal('parametric'),
    generator: z.string().min(1).max(64),
    params: z
      .record(z.string().min(1).max(32), ParamValue)
      .refine((p) => Object.keys(p).length <= MAX_GENERATOR_PARAMS, `at most ${MAX_GENERATOR_PARAMS} parameters`)
      .default({}),
  }),
]);
export type MeshSource = z.infer<typeof MeshSource>;
export type MeshSourceKind = MeshSource['kind'];

/** `Item.assetId` for a mesh source: `product:<provider>` / the lookalike asset id / `param:<generator>`. */
export function meshAssetId(mesh: MeshSource, productRef?: Pick<ProductRef, 'provider'>): string {
  switch (mesh.kind) {
    case 'provider':
      return `product:${productRef?.provider ?? 'unknown'}`;
    case 'lookalike':
      return mesh.assetId;
    case 'parametric':
      return `param:${mesh.generator}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Resolution (M5.2)
// ---------------------------------------------------------------------------------------------

/** Where the geometry of an item finally comes from. `builtin` = legacy `builtin:*`; `placeholder` = nothing better. */
export type ResolvedMeshSource = 'provider' | 'lookalike' | 'parametric' | 'builtin' | 'placeholder';

export interface ResolvedMesh {
  source: ResolvedMeshSource;
  /** Exact outer dims the shape is fitted to (item dims, else product dims, else the asset's own). */
  dims: Dims;
  /** Per-axis scale from the asset's native size to `dims` (lookalikes and provider models). */
  scale: Vec3;
  /** Largest per-axis deviation of the scale from uniform, 0 = uniform (lookalike only). */
  distortion?: number;
  /** `source === 'lookalike'`. */
  asset?: MeshAsset;
  /** `source === 'parametric'`. */
  generator?: { id: string; params: Record<string, unknown> };
  /** `source === 'provider'`: the product whose model the viewer should request (`/api/assets/products/...`). */
  product?: ProductId;
  /** One line saying why this source won (for the "mesh source" badge and for logs). */
  reason: string;
}

export interface MeshResolveContext {
  catalog: MeshCatalog;
  generators: GeneratorRegistry;
  /** The local server can serve a real model for this product (provider capability, record has a `modelRef`, not blocked). */
  providerModelAvailable?: (product: ProductId) => boolean;
}

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

/**
 * Deterministically picks the library asset that best fits a product: same category (a related one, e.g.
 * armchair <-> sofa, ranks lower), then the most shared style tags, then the closest proportions. Assets whose
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
    const categoryScore = asset.category === product.category ? SCORE_CATEGORY : related.includes(asset.category) ? SCORE_RELATED_CATEGORY : 0;
    if (categoryScore === 0) continue;
    const { scale, distortion } = scaleToDims(asset.nativeDims, product.dims);
    if (!(distortion <= MAX_LOOKALIKE_DISTORTION)) continue;
    const tags = asset.styleTags.filter((t) => wanted.has(t.toLowerCase())).length;
    const score = categoryScore + SCORE_PER_STYLE_TAG * tags + SCORE_PROPORTIONS * (1 - distortion / MAX_LOOKALIKE_DISTORTION);
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
    case 'lamp':
    case 'appliance':
    case 'decor':
    case 'other':
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Resolution (M5.2)
// ---------------------------------------------------------------------------------------------

const FALLBACK_DIMS: Dims = { w: 0.3, d: 0.3, h: 0.3 };

/**
 * Resolves the chain provider -> lookalike -> parametric -> placeholder for one item (D2). Pure and
 * deterministic: it decides, it does not fetch.
 *
 * The item's stored `mesh` is the rung to START at (a saved flat re-resolves the same way); when that rung
 * is unavailable the chain degrades downwards. Without a `mesh` the chain starts at `provider` for items
 * with a product reference, else at `lookalike`. Per rung:
 *  - provider:   `ctx.providerModelAvailable(productId)` says the local server has a real model; needs dims;
 *  - lookalike:  the stored asset (or `pickLookalike` over the catalog by the product's category), only if
 *                scaling to the dims distorts by at most `MAX_LOOKALIKE_DISTORTION`;
 *  - parametric: the stored generator, else `defaultParametricFor(product.category)`; both must pass the
 *                generator's params schema;
 *  - placeholder: a labelled box at the dims (0.3 m cube when nothing says better).
 * Legacy `builtin:*` items without a `mesh` resolve to `builtin`.
 */
export function resolveMesh(item: Pick<Item, 'assetId' | 'dims' | 'product' | 'productRef' | 'mesh'>, ctx: MeshResolveContext): ResolvedMesh {
  const unit: Vec3 = [1, 1, 1];
  const builtin = Object.hasOwn(BUILTIN_ASSETS, item.assetId) ? BUILTIN_ASSETS[item.assetId] : undefined;
  if (builtin && !item.mesh) {
    return { source: 'builtin', dims: item.dims ?? builtin.dims, scale: unit, reason: `legacy built-in asset "${item.assetId}"` };
  }
  const claimed = item.dims ?? item.product?.dims;
  const ref = item.productRef ?? (item.product ? { provider: item.product.provider, sku: item.product.sku } : undefined);
  const productId = ref ? safeProductId(ref) : undefined;
  const category = item.product?.category;
  const notes: string[] = [];
  const mesh = item.mesh;

  const rungs = ['provider', 'lookalike', 'parametric'] as const;
  const start = mesh ? rungs.indexOf(mesh.kind) : productId ? 0 : 1;

  for (const rung of rungs.slice(start)) {
    if (rung === 'provider') {
      if (!productId) notes.push('no product reference for a provider model');
      else if (!claimed) notes.push('no dims to fit a provider model to');
      else if (!ctx.providerModelAvailable?.(productId)) notes.push(`no provider model available for ${productId}`);
      else return { source: 'provider', dims: claimed, scale: unit, product: productId, reason: `real model of ${productId} from the local server` };
    } else if (rung === 'lookalike') {
      const stored = mesh?.kind === 'lookalike' ? ctx.catalog.get(mesh.assetId) : undefined;
      if (mesh?.kind === 'lookalike' && !stored) notes.push(`lookalike asset "${mesh.assetId}" is not in the catalog`);
      if (stored) {
        const fit = claimed ? scaleToDims(stored.nativeDims, claimed) : { scale: unit, distortion: 0 };
        if (fit.distortion <= MAX_LOOKALIKE_DISTORTION) {
          return { source: 'lookalike', dims: claimed ?? stored.nativeDims, scale: fit.scale, distortion: fit.distortion, asset: stored, reason: `library asset "${stored.id}" scaled to the exact dims (distortion ${(fit.distortion * 100).toFixed(0)}%)` };
        }
        notes.push(`lookalike "${stored.id}" would distort ${(fit.distortion * 100).toFixed(0)}% (limit ${MAX_LOOKALIKE_DISTORTION * 100}%)`);
      } else if (category && claimed && mesh?.kind !== 'lookalike') {
        const pick = pickLookalike({ category, dims: claimed, styleTags: [] }, ctx.catalog.list());
        if (pick) {
          return { source: 'lookalike', dims: claimed, scale: pick.scale, distortion: pick.distortion, asset: pick.asset, reason: `best library lookalike "${pick.asset.id}" (distortion ${(pick.distortion * 100).toFixed(0)}%)` };
        }
        notes.push(`no ${category} lookalike within ${MAX_LOOKALIKE_DISTORTION * 100}% distortion`);
      }
    } else {
      const candidates: { generator: string; params: Record<string, unknown> }[] = [];
      if (mesh?.kind === 'parametric') candidates.push({ generator: mesh.generator, params: mesh.params });
      const fallback = category && claimed ? defaultParametricFor(category, claimed, item.product?.name) : undefined;
      if (fallback) candidates.push(fallback);
      for (const c of candidates) {
        const g = ctx.generators.get(c.generator);
        if (!g) {
          notes.push(`generator "${c.generator}" is not registered`);
          continue;
        }
        const parsed = g.params.safeParse(c.params);
        if (!parsed.success) {
          notes.push(`generator "${c.generator}" rejects the params`);
          continue;
        }
        const dims = claimed ?? g.describeParams(parsed.data).dims;
        const stored = c === candidates[0] && mesh?.kind === 'parametric';
        return { source: 'parametric', dims, scale: unit, generator: { id: c.generator, params: parsed.data }, reason: stored ? `generator "${c.generator}" at the exact dims` : `default ${category} generator "${c.generator}" at the exact dims` };
      }
    }
  }
  return { source: 'placeholder', dims: claimed ?? FALLBACK_DIMS, scale: unit, reason: notes.length ? `labelled box: ${notes.join('; ')}` : 'labelled box: nothing better is known for this item' };
}

function safeProductId(ref: { provider: string; sku: string }): ProductId | undefined {
  try {
    return formatProductId(ref);
  } catch {
    return undefined;
  }
}
