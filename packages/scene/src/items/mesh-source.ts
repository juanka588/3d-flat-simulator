import { z } from 'zod';
import type { MeshData } from '../geometry/types';
import { Clearance, Dims, EntityId } from '../primitives';
import type { ProductCategory, ProductRef } from '../products';

/**
 * Mesh source contracts stored in a Scene file (`Item.mesh`) and the generator registry that schema refinement checks
 * parametric params against. The registry is EMPTY by default; the generators themselves live in `assets/`.
 */

type Vec3 = [number, number, number];

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
