import { createCatalogSource as createSource } from '@flat/assets';
import type { CatalogSource } from '@flat/assets';
import { viewerConfig } from './config';

// The catalog source itself moved to `@flat/assets` (step A5a, with the base URL injected). This file keeps what reads
// the viewer config and re-exports the moved names as a temporary shim (V8 removes it).
export type { CatalogSource, LibraryCatalog } from '@flat/assets';

/** Where the library lives: `${assetsBase}materials/` (assetsBase ends with a slash). */
export const materialsBase = (): string => `${viewerConfig.assetsBase}materials/`;

type Fetcher = Parameters<typeof createSource>[0];

/** A catalog source over `fetch` (default) and `${materialsBase()}catalog.json` (default). */
export function createCatalogSource(fetcher: Fetcher = (url) => fetch(url), url: string | (() => string) = () => `${materialsBase()}catalog.json`): CatalogSource {
  return createSource(fetcher, url);
}

/** The app-wide catalog source, shared by the viewer's material library and the Finish panel (one fetch). */
export const libraryCatalog: CatalogSource = createCatalogSource();

/** URL of a library material's thumbnail. */
export const thumbUrl = (slug: string): string => `${materialsBase()}${slug}/thumb.webp`;
