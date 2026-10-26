import type { Scene, Site } from '@flat/scene';
import { create } from 'zustand';
import { applyPreset, loadSceneText } from '@flat/scene';
import type { LoadResult, ValidationWarning } from '@flat/scene';
import { adoptSceneIdentity } from '../viewer/scene-identity';
import { instantToLocal } from './localTime';
import { useViewStore } from './viewStore';
import type { CommandApi } from './commands-api';

/** Today's date (YYYY-MM-DD) in a time zone, or null if the zone is unknown. */
function localDate(timezone: string): string | null {
  try {
    return instantToLocal(new Date(), timezone).date;
  } catch {
    return null;
  }
}

let latestLoad = 0;
/** Starts an asynchronous load; only the latest token may apply its result. */
export function beginLoad(): number {
  return ++latestLoad;
}
export function isLatestLoad(token: number): boolean {
  return token === latestLoad;
}

interface SceneStore extends CommandApi {
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
  // M3.5 contract stubs — replaced by the command-store implementation (lane D1).
  dispatch: () => ({ ok: false, errors: [{ code: 'not_supported', path: '', message: 'commands not wired yet' }] }),
  preview: () => ({ ok: false, errors: [{ code: 'not_supported', path: '', message: 'commands not wired yet' }] }),
  commitPreview: () => {},
  cancelPreview: () => {},
  undo: () => false,
  redo: () => false,
  canUndo: false,
  canRedo: false,
  historyLabels: [],
  lastErrors: [],
  rev: 0,
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
      if (first) {
        // "Today" is the date at the flat, not on the user's machine (they can be a day apart).
        const date = localDate(result.scene.site.timezone) ?? view.lighting.date;
        useViewStore.setState({ lighting: applyPreset({ ...view.lighting, date }, 'day', result.scene.site, result.scene.lights) });
      }
    } else {
      set({ errors: result.errors });
    }
    return result;
  },
}));
