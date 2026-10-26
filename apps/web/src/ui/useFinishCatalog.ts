import { useEffect, useState } from 'react';
import { libraryCatalog, thumbUrl } from '../viewer/catalog';
import type { CatalogEntry } from '@flat/scene';

export { thumbUrl };

export type CatalogState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; entries: CatalogEntry[] };

export function useFinishCatalog(enabled: boolean): CatalogState {
  const [state, setState] = useState<CatalogState>({ status: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    libraryCatalog.all().then(
      (entries) => live && setState({ status: 'ready', entries }),
      (e: unknown) => live && setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return state;
}
