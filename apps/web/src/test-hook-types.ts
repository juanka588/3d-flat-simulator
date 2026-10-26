import type { LightingView, LoadResult } from '@flat/scene';
import type { SunInfo } from './state/sunInfo';
import type { ViewState } from './viewer/view-types';

export interface FlatStats {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  /** Compiled shader programs (renderer.info.programs). */
  programs: number;
  /** Names of the visible named meshes, e.g. walls, floors, ceilings. */
  meshes: string[];
  mode: string;
  sceneName: string;
  /** World position of the active camera. */
  camera: [number, number, number];
  /** Lights in the three.js scene right now. */
  lights: {
    directional: number;
    hemisphere: number;
    point: number;
    spot: number;
    area: number;
    /** Ids of the lamps currently emitting (intensity > 0). */
    lampsLit: string[];
    /** Lights that cast shadows and emit (the sun counts when it is up). */
    shadowCasters: number;
    /** Ids/names of those lights. */
    shadowCasterNames: string[];
    sunIntensity: number;
    hemisphereIntensity: number;
  };
  /** Meshes that cast shadows (the merged shell casters, context buildings). */
  shadowCasterMeshes: string[];
  exposure: number;
  toneMapping: 'neutral' | 'other';
}

export interface FlatTestHook {
  /** Resolves once the canvas has rendered its first frame with a scene. */
  ready: Promise<void>;
  /** Resolves after a frame reflecting the current scene, mode and selection has been rendered. */
  whenRendered: () => Promise<void>;
  stats: () => FlatStats;
  /** Draw calls of every frame rendered by the render loop since the last `clearFrameCalls()` (frames right after a change include the shadow passes). */
  frameCalls: () => number[];
  clearFrameCalls: () => void;
  /** Sun patches (lit floor areas, obstructed by the visible context) for the current lighting view, with plan-polygon vertex centroids as world points (y = 0). */
  sunPatches: () => { roomId: string; openingId: string; area: number; polygon: [number, number][]; centroid: [number, number, number] }[];
  /** Applies the view change and resolves after a frame reflecting it has been rendered. */
  setView: (partial: Partial<ViewState>) => Promise<void>;
  /** Loads a scene; on success resolves only after a frame with the new scene has been rendered. */
  loadScene: (json: unknown) => Promise<LoadResult>;
  /** Walk mode only: teleports the camera on the plan (world x/z) and sets its yaw (three.js rotation.y, degrees). */
  setWalkPose: (pose: { x: number; z: number; yawDeg: number }) => Promise<void>;
  /** Projects a world point through the active camera to viewport CSS pixels (for page.mouse). */
  project: (point: [number, number, number]) => { x: number; y: number };
  /** PNG data URL of the current canvas. */
  capture: () => string;
  select: (id: string | null) => boolean;
  /** Merges into the lighting view; resolves after a frame reflecting it has been rendered. */
  setLighting: (partial: Partial<LightingView>) => Promise<void>;
  /** Sun position and daylight times for the current lighting view (or why they are unavailable). */
  sunInfo: () => SunInfo;
  /** Chooses the day-animation time source: `manual` advances only through `tick`. */
  setClock: (source: 'real' | 'manual') => void;
  /** Starts/stops the day animation, optionally at `minutesPerSecond` simulated minutes per second. */
  setPlaying: (playing: boolean, minutesPerSecond?: number) => void;
  /** Manual clock: advances `ms` of real time (moves the sun if playing); resolves after the render. */
  tick: (ms: number) => Promise<void>;
  /**
   * Manual clock, walk mode: advances the walker (held keys and on-screen buttons) by `ms` in fixed
   * 16 ms frames, independent of the real frame rate; resolves after the render. In the manual clock
   * the walker ignores real frames, so movement is exactly what was stepped.
   */
  stepWalk: (ms: number) => Promise<void>;
}

declare global {
  interface Window {
    __flat?: FlatTestHook;
  }
}
