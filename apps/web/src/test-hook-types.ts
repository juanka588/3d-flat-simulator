import type { ApplyResult, CameraPose, Command, LightingView, LoadResult, Scene } from '@flat/scene';
import type { SunInfo } from './state/sunInfo';
import type { ModelStats } from './viewer/model-types';
import type { Front } from './viewer/model-math';
import type { ViewState } from './viewer/view-types';

export interface FlatStats {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  /** Library texture sets (the app-wide cache): loaded, still loading (incl. catalog lookups), and the loaded slugs. */
  textureSets: { loaded: number; pending: number; idle: number; slugs: string[] };
  /** Compiled shader programs (renderer.info.programs). */
  programs: number;
  /** Fragment texture units of the GPU (MAX_TEXTURE_IMAGE_UNITS); the lamp shadow budget derives from it. */
  maxTextures: number;
  /** Names of the visible named meshes, e.g. walls, floors, ceilings. */
  meshes: string[];
  mode: string;
  sceneName: string;
  /** World position of the active camera. */
  camera: [number, number, number];
  /**
   * Heading of the active camera on the plan, degrees, in the three.js yaw convention (`rotation.y` of a
   * walker: 0 looks along -z, positive turns LEFT / counter-clockwise on the plan). For a top camera: the
   * plan's clockwise rotation on screen. A `WalkPose` with `headingDeg` h reports `yawDeg === -h`.
   */
  yawDeg: number;
  /** The same direction as `WalkPose.headingDeg`: degrees CLOCKWISE from plan-up (-y), in [0, 360). `headingDeg === (-yawDeg) mod 360`. */
  headingDeg: number;
  /** The pose being followed (set by `setCamera` or the follow-assistant channel), or null while the camera is user-driven. */
  pose: CameraPose | null;
  /** Pixel size of the drawing buffer (`capture()` returns a PNG of exactly this size). */
  canvasSize: [number, number];
  /** Vertical field of view of the active camera in degrees (0 for an orthographic camera). */
  fov: number;
  /** Device pixel ratio the canvas renders at. */
  dpr: number;
  /** Lights in the three.js scene right now. */
  lights: {
    directional: number;
    hemisphere: number;
    point: number;
    spot: number;
    area: number;
    /** Ids of the lamps currently emitting (intensity > 0). */
    lampsLit: string[];
    /** Real three.js lights that stand for lamps (a grid is several), and how many of them cast shadows (on or off). */
    lampLights: number;
    lampShadowCasters: number;
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

export interface HistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  /** Labels of the undo stack, newest last. */
  labels: string[];
  /** The undo stack, newest last. */
  entries: { id: string; type: string; author: string }[];
  /** Entries available to redo. */
  redoCount: number;
  rev: number;
}

export interface FlatTestHook {
  /** Resolves once the canvas has rendered its first frame with a scene. */
  ready: Promise<void>;
  /** Resolves after a frame reflecting the current scene, mode and selection has been rendered, with pending library textures loaded and drawn. */
  whenRendered: () => Promise<void>;
  /** Applies the rest of the orbit-damping motion at once (the pose it coasts towards), then resolves after a rendered frame. */
  settleCamera: () => Promise<void>;
  stats: () => FlatStats;
  /** The materials the fittings mesh currently draws door leaves with (translucent in walk mode, opaque otherwise). */
  doorLeaves: () => { id: string; transparent: boolean; opacity: number; depthWrite: boolean }[];
  /** Draw calls of every frame rendered by the render loop since the last `clearFrameCalls()` (frames right after a change include the shadow passes). */
  frameCalls: () => number[];
  clearFrameCalls: () => void;
  /** Sun patches (lit floor areas, obstructed by the visible context) for the current lighting view, with plan-polygon vertex centroids as world points (y = 0). */
  sunPatches: () => { roomId: string; openingId: string; area: number; polygon: [number, number][]; centroid: [number, number, number] }[];
  /**
   * M5.12: model loading state. `loaded` items drawn from a GLB, `pending` still loading (a placeholder box is drawn),
   * `failed` model files that failed (each moved an item down provider -> lookalike -> parametric), `sources` the
   * final source per item (`builtin:*` items count as `parametric`), `offline` the items that want a provider /
   * local-only model while there is no server (the UI's "offline" badge), `warnings` the `dims_mismatch` ones
   * (provider > 10%, lookalike > 25% aspect distortion), `requests` every model URL fetched, `cache` its occupancy.
   * `whenRendered` waits for pending models.
   */
  modelStats: () => ModelStats;
  /** M5.13: the drag in progress (`drag` null when none), the ghost it shows (`valid`, the violation `message`) and the last refusal `notice`. */
  placement: () => {
    drag: { kind: 'new' | 'move' | 'rotate' | 'elevate'; label: string; itemId?: string } | null;
    notice: string | null;
    ghost: { position: [number, number]; rotation: number; elevation: number; valid: boolean; message: string | null; kind: string } | null;
  };
  /** World bounding box of the GLB-drawn item `id` (plain or instanced), measured on the objects in the three.js scene; null if it is not drawn from a model. */
  itemBounds: (id: string) => { min: [number, number, number]; max: [number, number, number] } | null;
  /** Replaces `resolveMesh` in the viewer (a self-contained function, or null to restore it). Tests drive the chain with it. */
  setMeshResolver: (fn: ((item: any, ctx: any) => any) | null) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Pretends the scene server is at `origin` (provider models are then fetched from it) or that there is none (`null`); `undefined` follows the real sync state. */
  setModelOrigin: (origin: string | null | undefined) => void;
  /** Per-item front axis override for provider models (default +z); null restores the default. */
  setProviderFront: (fn: ((item: { id: string }) => Front | undefined) | undefined) => void;
  /** Applies the view change and resolves after a frame reflecting it has been rendered. */
  setView: (partial: Partial<ViewState>) => Promise<void>;
  /** Loads a scene; on success resolves only after a frame with the new scene has been rendered. */
  loadScene: (json: unknown) => Promise<LoadResult>;
  /** Walk mode only: teleports the camera on the plan (world x/z) and sets its yaw (three.js rotation.y, degrees). */
  setWalkPose: (pose: { x: number; z: number; yawDeg: number }) => Promise<void>;
  /**
   * M4 (lane B, M4.8): puts the camera exactly at `pose` (switching the view mode to the pose's
   * `mode`), cancels damping/animation, and resolves after a frame reflecting it has been rendered.
   * Repeated calls with the same pose, scene and lighting give pixel-identical captures. Not
   * persisted, not undoable. Poses come from the pure presets in `@flat/scene` (`camera-presets`).
   */
  setCamera: (pose: CameraPose) => Promise<void>;
  /**
   * M4 (lane B, M4.8): resizes the render surface to `width` x `height` CSS pixels at device pixel
   * ratio `dpr` (what `capture()` then returns is `width*dpr` x `height*dpr`), updates the camera
   * aspect, and resolves after a rendered frame. For the headless renderer, which has no window.
   */
  setViewport: (viewport: { width: number; height: number; dpr: number }) => Promise<void>;
  /**
   * Server mode only: feeds a `ViewMsg` (as the WebSocket would deliver it, optionally with an `epoch`) to the
   * view channel. Returns what happened: `applied`, `not-following` (the sidebar toggle is off), `stale`
   * (seq not newer), `foreign-epoch`, `invalid`, or `no-server` in Local mode.
   */
  receiveView: (message: unknown) => 'applied' | 'not-following' | 'stale' | 'foreign-epoch' | 'invalid' | 'no-server';
  /** Projects a world point through the active camera to viewport CSS pixels (for page.mouse). */
  project: (point: [number, number, number]) => { x: number; y: number };
  /** PNG data URL of the current canvas. */
  capture: () => string;
  /**
   * Selects an entity by id, or a wall face as if clicked inside `roomId` (a wall id alone selects the wall without a face).
   * Returns false when the target does not exist.
   */
  select: (target: string | { wallId: string; side: 'left' | 'right'; roomId?: string } | null) => boolean;
  /** Merges into the lighting view; resolves after a frame reflecting it has been rendered. */
  setLighting: (partial: Partial<LightingView>) => Promise<void>;
  /**
   * M4: walk-mode comfort switches, for renders that must show reality. `translucentDoors: false` draws door
   * leaves opaque in walk mode too; `buildingMode` sets the orbit-view host-building envelope (default `ghost`). Not persisted; the user's tab never sets it. Resolves after a frame reflecting it.
   */
  setComfort: (partial: { translucentDoors?: boolean; buildingMode?: 'hidden' | 'ghost' | 'solid' }) => Promise<void>;
  /** The host-building meshes currently in the scene (façade, ghost envelope or solid), with how they are drawn. */
  hostBuilding: () => { name: string; visible: boolean; castShadow: boolean; pickable: boolean; opacity: number; transparent: boolean; depthWrite: boolean }[];
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
  /**
   * Dispatches a command (untrusted JSON is fine: invalid ones resolve `{ok:false, errors}` and leave
   * the scene alone). On success resolves after a frame reflecting it has been rendered and the
   * library textures it needs have loaded and been drawn.
   */
  applyCommand: (cmd: Command | Record<string, unknown>, author?: 'user' | 'llm' | 'planner') => Promise<ApplyResult>;
  /** Undoes the last entry; resolves after the render with the new availability. */
  undo: () => Promise<{ ok: boolean; canUndo: boolean; canRedo: boolean }>;
  redo: () => Promise<{ ok: boolean; canUndo: boolean; canRedo: boolean }>;
  history: () => HistoryInfo;
  /** A structured clone of the committed scene. */
  getScene: () => Scene;
  /** The `.flat.json` text export would download (byte-stable). */
  exportScene: () => string;
  /** Saves now if there are unsaved changes; resolves when the write finished or failed. */
  flushAutosave: () => Promise<void>;
  /**
   * Sync state. `local` (status 'local') unless a scene server is connected (`?server=`).
   * `rev` is the last server revision applied, `pending` the local changes not yet confirmed.
   */
  connection: () => {
    mode: 'local' | 'server';
    status: 'local' | 'connecting' | 'connected' | 'reconnecting' | 'conflict';
    rev: number;
    epoch: string | null;
    pending: number;
  };
}

declare global {
  interface Window {
    __flat?: FlatTestHook;
  }
}
