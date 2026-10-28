import type { LocalCatalogInfo, ProductSummary, ProviderInfo, ProviderStatus } from '@flat/scene';
import { create } from 'zustand';
import type { GhostVerdict } from './ghost';

export type CatalogTab = 'products' | 'library';

/** The ghost drawn while dragging (also the data behind the tip next to the cursor). */
export interface GhostView {
  position: [number, number];
  rotation: number;
  elevation: number;
  dims: { w: number; d: number; h: number };
  verdict: GhostVerdict;
  /** Pointer position (CSS px) for the tip. */
  x: number;
  y: number;
  touch: boolean;
  /** `new` = a product / library card being dropped; `move` / `rotate` / `elevate` = a gizmo drag of an existing item. */
  kind: DragKind;
  label: string;
}

export type DragKind = 'new' | 'move' | 'rotate' | 'elevate';

export interface ActiveDrag {
  kind: DragKind;
  label: string;
  /** Item being dragged (gizmo drags). */
  itemId?: string;
}

interface CatalogStore {
  tab: CatalogTab;
  setTab: (tab: CatalogTab) => void;
  providers: ProviderInfo[];
  providersLoaded: boolean;
  setProviders: (providers: ProviderInfo[], localCatalog?: LocalCatalogInfo | null) => void;
  /** The server's local product catalogue (instant, offline), when it has one. */
  localCatalog: LocalCatalogInfo | null;
  /** "Search IKEA live" toggle: ask the live shop even when the local catalogue has enough results. */
  live: boolean;
  setLive: (live: boolean) => void;
  query: string;
  setQuery: (q: string) => void;
  /** Provider chip filter; null = every enabled provider. */
  providerFilter: string | null;
  setProviderFilter: (id: string | null) => void;
  results: ProductSummary[];
  statuses: ProviderStatus[];
  searching: boolean;
  searchError: string | null;
  setSearch: (p: Partial<Pick<CatalogStore, 'results' | 'statuses' | 'searching' | 'searchError'>>) => void;
  drag: ActiveDrag | null;
  ghost: GhostView | null;
  setDrag: (drag: ActiveDrag | null, ghost?: GhostView | null) => void;
  setGhost: (ghost: GhostView | null) => void;
  /** Why the last drop or key action was refused (cleared after a few seconds). */
  notice: string | null;
  setNotice: (text: string | null) => void;
}

export const useCatalogStore = create<CatalogStore>((set) => ({
  tab: 'products',
  setTab: (tab) => set({ tab }),
  providers: [],
  providersLoaded: false,
  setProviders: (providers, localCatalog = null) => set({ providers, providersLoaded: true, localCatalog }),
  localCatalog: null,
  live: false,
  setLive: (live) => set({ live }),
  query: '',
  setQuery: (query) => set({ query }),
  providerFilter: null,
  setProviderFilter: (providerFilter) => set({ providerFilter }),
  results: [],
  statuses: [],
  searching: false,
  searchError: null,
  setSearch: (p) => set(p),
  drag: null,
  ghost: null,
  setDrag: (drag, ghost = null) => set({ drag, ghost }),
  setGhost: (ghost) => set({ ghost }),
  notice: null,
  setNotice: (notice) => set({ notice }),
}));

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
/** Shows a refusal / hint for a few seconds. */
export function flashNotice(text: string, ms = 6000): void {
  clearTimeout(noticeTimer);
  useCatalogStore.getState().setNotice(text);
  noticeTimer = setTimeout(() => useCatalogStore.getState().setNotice(null), ms);
}
