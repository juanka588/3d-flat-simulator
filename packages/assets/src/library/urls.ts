import { parseProductId } from '@flat/scene';
import type { MeshAsset } from '../catalog/mesh-catalog';
import { hdModelsBase } from './catalog-loader';

/**
 * The asset routes of the scene server, as Hono route patterns. `apps/server/src/app.ts` declares its `/api/assets/...`
 * routes from this constant and the URL builders below are checked against it (`apps/server/src/asset-routes.test.ts`),
 * so web, MCP and server cannot drift apart. Order matters in the server: the catalog route comes before the GLB route.
 */
export const ASSET_ROUTES = {
  /** `GET /api/assets/products/:provider/:sku.glb`: a provider model, streamed (personal use, local only). */
  productModel: '/api/assets/products/:provider/:file{[^/]+\\.glb}',
  /** `GET /api/assets/meshes/catalog.json`: the local 3D-FUTURE pack's catalog. */
  meshCatalog: '/api/assets/meshes/catalog.json',
  /** `GET /api/assets/meshes/:assetId.glb`: a mesh of the local 3D-FUTURE pack. */
  meshModel: '/api/assets/meshes/:file{[^/]+\\.glb}',
} as const;

/** Every asset URL starts with this path (MCP's `fetchAsset` refuses anything else). */
export const ASSET_PATH_PREFIX = '/api/assets/';

/** `GET /api/assets/products/:provider/:sku.glb`. Undefined for an invalid product id. */
export function providerModelUrl(origin: string, productId: string): string | undefined {
  const parsed = parseProductId(productId);
  return parsed ? `${origin}/api/assets/products/${encodeURIComponent(parsed.provider)}/${encodeURIComponent(parsed.sku)}.glb` : undefined;
}

/** `GET /api/assets/meshes/:assetId.glb` for library meshes served by the server. */
export function serverMeshUrl(origin: string, assetId: string): string {
  return `${origin}/api/assets/meshes/${encodeURIComponent(assetId)}.glb`;
}

/** The URL to fetch a library asset from, or undefined when it may not be fetched here (3D-FUTURE needs the server). `base` is the models base (`.../models/`). */
export function libraryModelUrl(asset: Pick<MeshAsset, 'id' | 'source' | 'file' | 'tier'>, origin: string | null, base: string): string | undefined {
  if (asset.source === 'cc0') return asset.file ? `${asset.tier === 'hd' ? hdModelsBase(base) : base}${asset.file}` : undefined;
  if (asset.source === '3dfuture') return origin ? serverMeshUrl(origin, asset.id) : undefined;
  return undefined;
}
