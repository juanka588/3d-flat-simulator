import { EMPTY_MESH_CATALOG, MeshAsset, createMeshCatalog, parseProductId } from '@flat/scene';
import type { MeshCatalog } from '@flat/scene';
import { registerLibraryNames } from '../catalog/format';
import { useSyncStore } from '../sync/sync-store';

/**
 * Where model files come from (M5.12, D2/D4):
 *  - CC0 / CC-BY library models are committed under `public/models/` and load from `${BASE_URL}models/` everywhere (Pages too);
 *  - the HD hero tier (M5R step 2) lives in `public/models-hd/` and loads from `${BASE_URL}models-hd/`, only when an
 *    item that resolves to one is placed (its catalog is a small JSON; the GLBs are never preloaded);
 *  - provider models (and the local-only 3D-FUTURE pack) exist ONLY behind the local server, so their URLs are
 *    built only when the viewer is connected to a server. In Pages / Local mode nothing of the kind is ever requested.
 */

export const modelsBase = (): string => `${import.meta.env.BASE_URL}models/`;

/** The HD tier folder next to a models base (`.../models/` -> `.../models-hd/`). */
export const hdModelsBase = (base: string = modelsBase()): string => base.replace(/models\/$/, 'models-hd/');

/** `undefined` = follow the sync state; a string/null = forced (tests / headless renders). */
let originOverride: string | null | undefined;

/** Test hook: pretend the server is at `origin` (or that there is none, with `null`). `undefined` restores the sync state. */
export function setModelOriginOverride(origin: string | null | undefined): void {
  originOverride = origin;
  for (const l of [...originListeners]) l();
}

const originListeners = new Set<() => void>();
/** Called when a forced origin changes (the sync state is observed through the store instead). */
export function subscribeModelOriginOverride(listener: () => void): () => void {
  originListeners.add(listener);
  return () => void originListeners.delete(listener);
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
export function libraryModelUrl(asset: Pick<MeshAsset, 'id' | 'source' | 'file' | 'tier'>, origin: string | null, base = modelsBase()): string | undefined {
  if (asset.source === 'cc0') return asset.file ? `${asset.tier === 'hd' ? hdModelsBase(base) : base}${asset.file}` : undefined;
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

const ASSET_KEYS = ['id', 'name', 'source', 'licence', 'credit', 'category', 'styleTags', 'nativeDims', 'anchor', 'front', 'file', 'generator', 'tier'] as const;

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

/** The assets of one catalog JSON (`tier` forces the tier of every entry); a missing or broken file is an empty list. */
export async function fetchCatalogAssets(fetcher: typeof fetch, url: string, tier?: 'hd'): Promise<MeshAsset[]> {
  try {
    const res = await fetcher(url);
    if (!res.ok) return [];
    const assets = parseCatalogJson(await res.json());
    return tier ? assets.filter((a) => a.source === 'cc0').map((a) => ({ ...a, tier })) : assets;
  } catch {
    return [];
  }
}

/**
 * Fetches the committed library catalogs once: the light tier, then the HD tier's (a small JSON; its GLBs load
 * lazily, per placed item). A missing or broken file is an empty list, so the chain falls through to the light tier.
 */
export function createCatalogLoader(
  fetcher: typeof fetch = (...a) => fetch(...a),
  url = () => `${modelsBase()}catalog.json`,
  hdUrl = () => `${hdModelsBase()}catalog.json`,
): () => Promise<MeshCatalog> {
  let loading: Promise<MeshCatalog> | undefined;
  return () =>
    (loading ??= (async () => {
      const [light, hd] = await Promise.all([fetchCatalogAssets(fetcher, url()), fetchCatalogAssets(fetcher, hdUrl(), 'hd')]);
      const assets = [...light, ...hd];
      if (assets.length === 0) return EMPTY_MESH_CATALOG;
      registerLibraryNames(assets);
      return catalogFromAssets(assets);
    })());
}
