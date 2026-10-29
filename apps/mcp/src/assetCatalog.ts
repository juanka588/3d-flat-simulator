import { readFileSync } from 'node:fs';
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

// -- thumbnails (CG3) ----------------------------------------------------------------------------------------------
// The committed library thumbnails (`<tier>/thumbs/<name>.webp`, renders of our own CC0 / CC-BY models). Safe to show the model.

const THUMB_DIRS: { dir: URL; catalog: unknown }[] = [
  { dir: new URL('../../web/public/models/', import.meta.url), catalog: catalogJson },
  { dir: new URL('../../web/public/models-hd/', import.meta.url), catalog: hdCatalogJson },
];

/** The thumbnail bytes of a library asset id (`undefined` when it has none). */
export function assetThumb(assetId: string): { data: Uint8Array; contentType: string } | undefined {
  for (const { dir, catalog } of THUMB_DIRS) {
    const entry = (Array.isArray(catalog) ? (catalog as { id?: string; thumb?: string }[]) : []).find((a) => a.id === assetId);
    if (!entry?.thumb || /\.\.|^\//.test(entry.thumb)) continue;
    try {
      return { data: new Uint8Array(readFileSync(new URL(entry.thumb, dir))), contentType: 'image/webp' };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
