import { parseCatalogJson } from '@flat/assets';
import type { MeshAsset } from '@flat/assets';
import catalogJson from '../../web/public/models/catalog.json';
import hdCatalogJson from '../../web/public/models-hd/catalog.json';

/**
 * The committed CC0 model library (`apps/web/public/models/catalog.json`), as `MeshAsset`s. The build
 * pipeline adds provenance fields (hashes, thumbnails, ...) the MCP tools do not need; the `MeshAsset`
 * ones are kept and invalid entries are skipped, by `parseCatalogJson`, the same function the viewer uses.
 */

let cached: MeshAsset[] | undefined;

export function cc0Assets(): readonly MeshAsset[] {
  if (cached) return cached;
  // Light tier first, then the HD hero tier (`models-hd`, lazy in the viewer): the same ids the viewer resolves.
  const out = [...parseCatalogJson(catalogJson), ...parseCatalogJson(hdCatalogJson)].filter((a) => a.source === 'cc0');
  cached = out;
  return out;
}
