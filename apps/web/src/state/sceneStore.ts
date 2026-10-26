import type { Scene, Site } from '@flat/scene';
import { create } from 'zustand';
import { applyPreset, loadSceneText } from '@flat/scene';
import type { LoadResult, ValidationWarning } from '@flat/scene';
import { adoptSceneIdentity } from '../viewer/scene-identity';
import { useViewStore } from './viewStore';

let latestLoad = 0;
/** Starts an asynchronous load; only the latest token may apply its result. */
export function beginLoad(): number {
  return ++latestLoad;
}
export function isLatestLoad(token: number): boolean {
  return token === latestLoad;
}

interface SceneStore {
  scene: Scene | null;
  /** Where the current scene came from (fixture name or file name). */
  source: string;
  warnings: ValidationWarning[];
  /** Errors of the last failed load; the previous scene stays displayed. */
  errors: string[];
  /** Loads JSON text; on failure keeps the previous scene and records the errors. */
  loadText: (text: string, source: string) => LoadResult;
  /** Records load errors (e.g. a file rejected before parsing) without touching the scene. */
  fail: (errors: string[]) => void;
  /**
   * Replaces the site of the in-memory scene (M2.9). Not undoable until M3; the camera and meshes
   * are kept because the geometry is unchanged.
   */
  setSite: (site: Site) => void;
}

export const useSceneStore = create<SceneStore>((set) => ({
  scene: null,
  source: '',
  warnings: [],
  errors: [],
  fail: (errors) => set({ errors }),
  setSite: (site) =>
    set((s) => {
      if (!s.scene) return s;
      const next = { ...s.scene, site };
      adoptSceneIdentity(s.scene, next);
      return { scene: next };
    }),
  loadText: (text, source) => {
    latestLoad++; // a synchronous load supersedes any file still being read
    const result = loadSceneText(text);
    if (result.ok) {
      const first = useSceneStore.getState().scene === null;
      set({ scene: result.scene, source, warnings: result.warnings, errors: [] });
      const view = useViewStore.getState();
      view.select(null);
      // The app opens in daytime (12:00): start from the 'day' preset so lamps are off, not glowing at noon.
      if (first) useViewStore.setState({ lighting: applyPreset(view.lighting, 'day', result.scene.site, result.scene.lights) });
    } else {
      set({ errors: result.errors });
    }
    return result;
  },
}));
