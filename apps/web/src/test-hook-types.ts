import type { LoadResult } from './scene-adapters';
import type { ViewState } from './viewer/view-types';

export interface FlatStats {
  calls: number;
  triangles: number;
  geometries: number;
  mode: string;
  sceneName: string;
}

export interface FlatTestHook {
  /** Resolves once the canvas has rendered its first frame with a scene. */
  ready: Promise<void>;
  stats: () => FlatStats;
  setView: (partial: Partial<ViewState>) => Promise<void>;
  loadScene: (json: unknown) => LoadResult;
  /** PNG data URL of the current canvas. */
  capture: () => string;
  select: (id: string | null) => boolean;
}

declare global {
  interface Window {
    __flat?: FlatTestHook;
  }
}
