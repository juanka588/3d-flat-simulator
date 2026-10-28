import { createCatalogLoader as createLoader, hdModelsBase as hdBase, libraryModelUrl as libraryUrl } from '@flat/assets';
import type { CatalogLoaderOptions, MeshAsset, MeshCatalog } from '@flat/assets';
import { viewerConfig } from './config';

/**
 * Where model files come from (M5.12, D2/D4). The pure half (catalog parsing and loading, URL builders) moved to
 * `@flat/assets/library` in step A5a; this file keeps what reads the viewer config (the base path and the server
 * origin) and wraps the moved functions with those defaults. The re-exports are a temporary shim (V8 removes them):
 *  - CC0 / CC-BY library models load from `${assetsBase}models/` everywhere (Pages too);
 *  - the HD hero tier loads from `${assetsBase}models-hd/`, only when an item that resolves to one is placed;
 *  - provider models (and the local-only 3D-FUTURE pack) exist ONLY behind the local server, so their URLs are
 *    built only when the viewer is connected to a server. In Pages / Local mode nothing of the kind is ever requested.
 */

export { catalogFromAssets, catalogWithout, fetchCatalogAssets, parseCatalogJson, providerModelUrl, serverMeshUrl } from '@flat/assets';
export type { CatalogLoaderOptions } from '@flat/assets';

export const modelsBase = (): string => `${viewerConfig.assetsBase}models/`;

/** The HD tier folder next to a models base (`.../models/` -> `.../models-hd/`). */
export const hdModelsBase = (base: string = modelsBase()): string => hdBase(base);

/** Origin of the connected scene server (no trailing slash), or null in Local / Pages mode (see `ViewerAssetConfig`). */
export function modelOrigin(): string | null {
  return viewerConfig.modelOrigin();
}

/** The URL to fetch a library asset from, or undefined when it may not be fetched here (3D-FUTURE needs the server). */
export function libraryModelUrl(asset: Pick<MeshAsset, 'id' | 'source' | 'file' | 'tier'>, origin: string | null, base = modelsBase()): string | undefined {
  return libraryUrl(asset, origin, base);
}

export interface WebCatalogLoaderOptions extends CatalogLoaderOptions {
  fetcher?: typeof fetch;
  url?: () => string;
  hdUrl?: () => string;
}

/** The catalog loader with the web defaults: `fetch`, and the catalogs under `modelsBase()` / `hdModelsBase()`. */
export function createCatalogLoader({ fetcher = (...a) => fetch(...a), url = () => `${modelsBase()}catalog.json`, hdUrl = () => `${hdModelsBase()}catalog.json`, onLoaded }: WebCatalogLoaderOptions = {}): () => Promise<MeshCatalog> {
  return createLoader(fetcher, { url, hdUrl }, onLoaded ? { onLoaded } : {});
}
