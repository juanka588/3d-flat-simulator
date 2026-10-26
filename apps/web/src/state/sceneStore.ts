import type { Scene } from '@flat/scene';
import { create } from 'zustand';
import { loadSceneText } from '@flat/scene';
import type { LoadResult, ValidationWarning } from '@flat/scene';
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
}

export const useSceneStore = create<SceneStore>((set) => ({
  scene: null,
  source: '',
  warnings: [],
  errors: [],
  fail: (errors) => set({ errors }),
  loadText: (text, source) => {
    latestLoad++; // a synchronous load supersedes any file still being read
    const result = loadSceneText(text);
    if (result.ok) {
      set({ scene: result.scene, source, warnings: result.warnings, errors: [] });
      useViewStore.getState().select(null);
    } else {
      set({ errors: result.errors });
    }
    return result;
  },
}));
