import type { MeshCatalog, MeshAsset } from './mesh-catalog';
import { MAX_LOOKALIKE_DISTORTION, pickLookalike, scaleToDims } from './mesh-catalog';
import { BUILTIN_ASSETS, defaultParametricFor, formatProductId, type ProductId } from '@flat/scene';
import type { Dims, GeneratorRegistry, Item } from '@flat/scene';

type Vec3 = [number, number, number];

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
