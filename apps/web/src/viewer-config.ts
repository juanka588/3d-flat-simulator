import { registerLibraryNames } from './catalog/format';
import { useSyncStore } from './sync/sync-store';
import { configureViewer } from './viewer/config';

/** Wires the viewer to this app: the Vite base path, the connected scene server and the library display names. */
configureViewer({
  assetsBase: import.meta.env.BASE_URL,
  modelOrigin: () => {
    const s = useSyncStore.getState();
    return s.mode === 'server' ? s.serverUrl : null;
  },
  subscribe: (listener) => useSyncStore.subscribe(listener),
  onLibraryLoaded: registerLibraryNames,
});
