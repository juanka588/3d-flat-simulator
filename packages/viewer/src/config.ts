/**
 * What the viewer needs from its host to find files, as plain values and a subscription (no app stores):
 *  - `assetsBase`: where the committed static assets live (`models/`, `models-hd/`, `materials/`, `env/`), with a trailing slash;
 *  - `modelOrigin()`: origin of the scene server that serves provider and 3D-FUTURE models (no trailing slash), or null when there is none;
 *  - `subscribe`: called when `modelOrigin()` may have changed (what `useSyncExternalStore` needs);
 *  - `onLibraryLoaded`: told the CC0 library assets once their catalogs are fetched (the host may want their display names).
 */
export interface ViewerAssetConfig {
  assetsBase: string;
  modelOrigin: () => string | null;
  subscribe: (listener: () => void) => () => void;
  onLibraryLoaded?: (assets: readonly { id: string; name: string }[]) => void;
}

const DEFAULT_CONFIG: ViewerAssetConfig = {
  assetsBase: '/',
  modelOrigin: () => null,
  subscribe: () => () => undefined,
};

let hostConfig: ViewerAssetConfig = DEFAULT_CONFIG;

/** The host installs its configuration once, before the viewer draws (see `apps/web/src/viewer-config.ts`). */
export function configureViewer(config: ViewerAssetConfig): void {
  hostConfig = config;
  notify();
}

/** `undefined` = follow the host; a string/null = forced (tests / headless renders). */
let originOverride: string | null | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of [...listeners]) l();
};

/** Test hook: pretend the server is at `origin` (or that there is none, with `null`). `undefined` restores the host's. */
export function setModelOriginOverride(origin: string | null | undefined): void {
  originOverride = origin;
  notify();
}

/** The effective configuration: the host's, with the test override applied to `modelOrigin`. */
export const viewerConfig = {
  get assetsBase(): string {
    return hostConfig.assetsBase;
  },
  modelOrigin(): string | null {
    return originOverride !== undefined ? originOverride : hostConfig.modelOrigin();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    const stop = hostConfig.subscribe(listener);
    return () => {
      listeners.delete(listener);
      stop();
    };
  },
  onLibraryLoaded(assets: readonly { id: string; name: string }[]): void {
    hostConfig.onLibraryLoaded?.(assets);
  },
};
