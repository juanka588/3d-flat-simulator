import { z } from 'zod';
import type { MeshData } from '../geometry/types';
import { Clearance, Dims, EntityId, NameString } from '../primitives';
import { ProductCategory, type ProductId, type ProductRef } from '../products';
import type { Item } from '../schema';

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

/**
 * Resolves the chain provider -> lookalike -> parametric -> placeholder for one item (D2). Pure: it
 * decides, it does not fetch. STUB (M5.2 implements it): returns a `placeholder` at the item's dims
 * (or a 0.3 m cube) so viewer code can already depend on the shape of the result.
 */
export function resolveMesh(item: Pick<Item, 'assetId' | 'dims' | 'product' | 'productRef' | 'mesh'>, ctx: MeshResolveContext): ResolvedMesh {
  void ctx;
  const dims = item.dims ?? item.product?.dims ?? { w: 0.3, d: 0.3, h: 0.3 };
  return { source: 'placeholder', dims, scale: [1, 1, 1], reason: 'stub: resolveMesh is implemented by M5.2' };
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

/**
 * Deterministically picks the library asset that best fits a product: same category, then style tags,
 * then closest proportions, rejecting any whose distortion would exceed `MAX_LOOKALIKE_DISTORTION`.
 * `undefined` when none qualifies (the chain falls through to parametric). STUB (M5.2): returns undefined.
 */
export function pickLookalike(
  product: { category: ProductCategory; dims: Dims; styleTags?: readonly string[] },
  assets: readonly MeshAsset[],
): LookalikeMatch | undefined {
  void product;
  void assets;
  return undefined;
}
