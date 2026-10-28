import { MeshAsset } from '@flat/assets';
import { registerLibraryNames } from './format';
import { hdModelsBase, modelsBase, parseCatalogJson } from '../viewer/model-env';

/** A library model for the Library tab: the asset plus its thumbnail URL. */
export interface LibraryModel {
  asset: MeshAsset;
  thumb?: string;
}

/**
 * Reads the committed catalogs, light tier first and then the HD tier (`public/models-hd/catalog.json`), with
 * thumbnails; a missing or broken file is an empty list.
 */
export async function loadLibraryModels(fetcher: typeof fetch = (...a) => fetch(...a), base: string = modelsBase()): Promise<LibraryModel[]> {
  const [light, hd] = await Promise.all([loadTier(fetcher, base), loadTier(fetcher, hdModelsBase(base), 'hd')]);
  const seen = new Set<string>();
  return [...light, ...hd].filter((m) => !seen.has(m.asset.id) && !!seen.add(m.asset.id));
}

async function loadTier(fetcher: typeof fetch, base: string, tier?: 'hd'): Promise<LibraryModel[]> {
  try {
    const res = await fetcher(`${base}catalog.json`);
    if (!res.ok) return [];
    const json: unknown = await res.json();
    const thumbs = new Map<string, string>();
    const raw = Array.isArray(json) ? json : json && typeof json === 'object' ? ((json as Record<string, unknown>)['assets'] ?? (json as Record<string, unknown>)['models']) : undefined;
    if (Array.isArray(raw)) {
      for (const e of raw as { id?: unknown; thumb?: unknown }[]) if (typeof e?.id === 'string' && typeof e.thumb === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(e.thumb) && !e.thumb.includes('..')) thumbs.set(e.id, `${base}${e.thumb}`);
    }
    // Only committed library files (cc0) are listed here: local-only packs never show on a static site.
    const assets = parseCatalogJson(json);
    registerLibraryNames(assets);
    return assets
      .filter((a) => a.source === 'cc0')
      .map((a) => (tier ? { ...a, tier } : a))
      .map((asset) => ({ asset, ...(thumbs.has(asset.id) ? { thumb: thumbs.get(asset.id)! } : {}) }));
  } catch {
    return [];
  }
}

/** Splits a credit line like `"Title" by Author, Source, CC-BY-4.0 (https://...)` into its text and the https URL, if any. */
export function splitCredit(credit: string): { text: string; url?: string } {
  const m = /\s*\((https:\/\/[^)\s]+)\)\s*$/.exec(credit);
  return m ? { text: credit.slice(0, m.index), url: m[1]! } : { text: credit };
}

/** Case- and accent-insensitive match of a filter text against a name or category. */
export function matchesFilter(text: string, ...fields: string[]): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const tokens = fold(text).split(/\s+/).filter(Boolean);
  const hay = fold(fields.join(' '));
  return tokens.every((t) => hay.includes(t));
}
