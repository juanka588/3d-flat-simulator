import type { LoadResult } from '@flat/scene';
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
}

export interface FlatTestHook {
  /** Resolves once the canvas has rendered its first frame with a scene. */
  ready: Promise<void>;
  /** Resolves after a frame reflecting the current scene, mode and selection has been rendered. */
  whenRendered: () => Promise<void>;
  stats: () => FlatStats;
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
}

declare global {
  interface Window {
    __flat?: FlatTestHook;
  }
}
