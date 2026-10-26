import { Catalog } from '@flat/scene';
import type { CatalogEntry } from '@flat/scene';

export type LibraryCatalog = ReadonlyMap<string, CatalogEntry>;

/** Where the library lives: `${BASE_URL}materials/` (BASE_URL ends with a slash). */
export const materialsBase = (): string => `${import.meta.env.BASE_URL}materials/`;

export interface CatalogSource {
  /** Resolves the catalog entry of a slug, or undefined when the slug is not in the library (or the catalog could not load). */
  entry: (slug: string) => Promise<CatalogEntry | undefined>;
  /** Every catalog entry in file order; rejects when the catalog cannot be loaded or is invalid (the UI shows the error). */
  all: () => Promise<CatalogEntry[]>;
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

/** Builds a catalog source that fetches `catalog.json` once, on first use. A failed fetch is retried next time. */
export function createCatalogSource(fetcher: Fetcher = (url) => fetch(url), url = `${materialsBase()}catalog.json`): CatalogSource {
  let loading: Promise<CatalogEntry[]> | undefined;
  const load = (): Promise<CatalogEntry[]> =>
    (loading ??= (async () => {
      try {
        const res = await fetcher(url);
        if (!res.ok) throw new Error(`catalog.json: HTTP ${res.status ?? 'error'}`);
        return Catalog.parse(await res.json());
      } catch (error) {
        loading = undefined;
        throw error;
      }
    })());
  let index: Promise<LibraryCatalog> | undefined;
  return {
    all: load,
    async entry(slug) {
      index ??= load().then(
        (entries) => new Map(entries.map((e) => [e.id, e] as const)),
        (error: unknown) => {
          console.warn(`[materials] could not load the material catalog (${url}); textured materials fall back to paint`, error);
          index = undefined;
          return new Map<string, CatalogEntry>();
        },
      );
      return (await index).get(slug);
    },
  };
}

/** The app-wide catalog source, shared by the viewer's material library and the Finish panel (one fetch). */
export const libraryCatalog: CatalogSource = createCatalogSource();

/** URL of a library material's thumbnail. */
export const thumbUrl = (slug: string): string => `${materialsBase()}${slug}/thumb.webp`;
