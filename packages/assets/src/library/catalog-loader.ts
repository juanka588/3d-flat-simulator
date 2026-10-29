import { EMPTY_MESH_CATALOG, MeshAsset, createMeshCatalog } from '../catalog/mesh-catalog';
import type { MeshCatalog } from '../catalog/mesh-catalog';

/**
 * The model library catalogs (M5.12, D2/D4), without any knowledge of where the app is served from: the callers inject
 * the URLs (the web app derives them from its base path, `packages/viewer/src/model-env.ts`).
 *  - CC0 / CC-BY library models are committed under `public/models/` and load from `${assetsBase}models/` everywhere (Pages too);
 *  - the HD hero tier (M5R step 2) lives in `public/models-hd/`, only loaded when an item that resolves to one is placed.
 */

/** The HD tier folder next to a models base (`.../models/` -> `.../models-hd/`). */
export const hdModelsBase = (base: string): string => base.replace(/models\/$/, 'models-hd/');

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

/** The one list of `MeshAsset` keys that library catalog JSON files are reduced to (web, MCP and the server read the same keys). */
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

export interface CatalogLoaderUrls {
  url: () => string;
  hdUrl: () => string;
}

export interface CatalogLoaderOptions {
  /** Called once with the fetched library assets (not for an empty library). */
  onLoaded?: (assets: readonly MeshAsset[]) => void;
}

/**
 * Fetches the committed library catalogs once: the light tier, then the HD tier's (a small JSON; its GLBs load
 * lazily, per placed item). A missing or broken file is an empty list, so the chain falls through to the light tier.
 */
export function createCatalogLoader(fetcher: typeof fetch, { url, hdUrl }: CatalogLoaderUrls, { onLoaded }: CatalogLoaderOptions = {}): () => Promise<MeshCatalog> {
  let loading: Promise<MeshCatalog> | undefined;
  return () =>
    (loading ??= (async () => {
      const [light, hd] = await Promise.all([fetchCatalogAssets(fetcher, url()), fetchCatalogAssets(fetcher, hdUrl(), 'hd')]);
      const assets = [...light, ...hd];
      if (assets.length === 0) return EMPTY_MESH_CATALOG;
      onLoaded?.(assets);
      return catalogFromAssets(assets);
    })());
}
