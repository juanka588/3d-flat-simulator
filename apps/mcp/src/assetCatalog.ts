import { MeshAsset } from '@flat/assets';
import catalogJson from '../../web/public/models/catalog.json';
import hdCatalogJson from '../../web/public/models-hd/catalog.json';

/**
 * The committed CC0 model library (`apps/web/public/models/catalog.json`), as `MeshAsset`s. The build
 * pipeline adds provenance fields (hashes, thumbnails, ...) the MCP tools do not need; the `MeshAsset`
 * ones are kept and invalid entries are skipped, like the viewer does (`parseCatalogJson`).
 */

const KEYS = ['id', 'name', 'source', 'licence', 'credit', 'category', 'styleTags', 'nativeDims', 'anchor', 'front', 'file', 'generator', 'tier'] as const;

let cached: MeshAsset[] | undefined;

export function cc0Assets(): readonly MeshAsset[] {
  if (cached) return cached;
  const out: MeshAsset[] = [];
  // Light tier first, then the HD hero tier (`models-hd`, lazy in the viewer): the same ids the viewer resolves.
  const list = [...(Array.isArray(catalogJson) ? (catalogJson as unknown[]) : []), ...(Array.isArray(hdCatalogJson) ? (hdCatalogJson as unknown[]) : [])];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const src = entry as Record<string, unknown>;
    const parsed = MeshAsset.safeParse(Object.fromEntries(KEYS.filter((k) => k in src).map((k) => [k, src[k]])));
    if (parsed.success && parsed.data.source === 'cc0') out.push(parsed.data);
  }
  cached = out;
  return out;
}
