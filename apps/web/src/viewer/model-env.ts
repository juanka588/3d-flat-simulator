import { EMPTY_MESH_CATALOG, MeshAsset, createMeshCatalog, parseProductId } from '@flat/scene';
import type { MeshCatalog } from '@flat/scene';
import { useSyncStore } from '../sync/sync-store';

/**
 * Where model files come from (M5.12, D2/D4):
 *  - CC0 library models are committed under `public/models/` and load from `${BASE_URL}models/` everywhere (Pages too);
 *  - provider models (and the local-only 3D-FUTURE pack) exist ONLY behind the local server, so their URLs are
 *    built only when the viewer is connected to a server. In Pages / Local mode nothing of the kind is ever requested.
 */

export const modelsBase = (): string => `${import.meta.env.BASE_URL}models/`;

/** `undefined` = follow the sync state; a string/null = forced (tests / headless renders). */
let originOverride: string | null | undefined;

/** Test hook: pretend the server is at `origin` (or that there is none, with `null`). `undefined` restores the sync state. */
export function setModelOriginOverride(origin: string | null | undefined): void {
  originOverride = origin;
}

/** Origin of the connected scene server (no trailing slash), or null in Local / Pages mode. */
export function modelOrigin(): string | null {
  if (originOverride !== undefined) return originOverride;
  const s = useSyncStore.getState();
  return s.mode === 'server' ? s.serverUrl : null;
}

/** Mirrors `HttpFlatApi.assetUrl` (apps/mcp): `GET /api/assets/products/:provider/:sku.glb`. Undefined for an invalid product id. */
export function providerModelUrl(origin: string, productId: string): string | undefined {
  const parsed = parseProductId(productId);
  return parsed ? `${origin}/api/assets/products/${encodeURIComponent(parsed.provider)}/${encodeURIComponent(parsed.sku)}.glb` : undefined;
}

/** Mirrors `HttpFlatApi.assetUrl` for library meshes served by the server: `GET /api/assets/meshes/:assetId.glb`. */
export function serverMeshUrl(origin: string, assetId: string): string {
  return `${origin}/api/assets/meshes/${encodeURIComponent(assetId)}.glb`;
}

/** The URL to fetch a library asset from, or undefined when it may not be fetched here (3D-FUTURE needs the server). */
export function libraryModelUrl(asset: Pick<MeshAsset, 'id' | 'source' | 'file'>, origin: string | null, base = modelsBase()): string | undefined {
  if (asset.source === 'cc0') return asset.file ? `${base}${asset.file}` : undefined;
  if (asset.source === '3dfuture') return origin ? serverMeshUrl(origin, asset.id) : undefined;
  return undefined;
}

/** A catalog over a list of assets (the first of two with the same id wins). */
export function catalogFromAssets(assets: readonly MeshAsset[]): MeshCatalog {
  const seen = new Set<string>();
  return createMeshCatalog(assets.filter((a) => !seen.has(a.id) && !!seen.add(a.id)));
}

/** The same catalog without some assets (those whose model failed to load): the resolver then falls through. */
export function catalogWithout(catalog: MeshCatalog, excluded: ReadonlySet<string>): MeshCatalog {
  if (excluded.size === 0) return catalog;
  return catalogFromAssets(catalog.list().filter((a) => !excluded.has(a.id)));
}

const ASSET_KEYS = ['id', 'name', 'source', 'licence', 'credit', 'category', 'styleTags', 'nativeDims', 'anchor', 'front', 'file', 'generator'] as const;

function pickKeys(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return entry;
  const src = entry as Record<string, unknown>;
  return Object.fromEntries(ASSET_KEYS.filter((k) => k in src).map((k) => [k, src[k]]));
}

/** Accepts `[...]` or `{assets: [...]}` / `{models: [...]}`; invalid entries are skipped. */
export function parseCatalogJson(json: unknown): MeshAsset[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object'
      ? ((json as Record<string, unknown>)['assets'] ?? (json as Record<string, unknown>)['models'])
      : undefined;
  if (!Array.isArray(list)) return [];
  const out: MeshAsset[] = [];
  for (const entry of list) {
    // The build pipeline adds provenance fields (thumbnail, hashes, ...) that the viewer does not need: keep the MeshAsset ones.
    const parsed = MeshAsset.safeParse(pickKeys(entry));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Fetches the committed library catalog once; a missing or broken file is an empty catalog (the chain falls through). */
export function createCatalogLoader(fetcher: typeof fetch = (...a) => fetch(...a), url = () => `${modelsBase()}catalog.json`): () => Promise<MeshCatalog> {
  let loading: Promise<MeshCatalog> | undefined;
  return () =>
    (loading ??= (async () => {
      try {
        const res = await fetcher(url());
        if (!res.ok) return EMPTY_MESH_CATALOG;
        return catalogFromAssets(parseCatalogJson(await res.json()));
      } catch {
        return EMPTY_MESH_CATALOG;
      }
    })());
}
