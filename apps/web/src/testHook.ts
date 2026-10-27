import { addAfterEffect } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { NeutralToneMapping, Vector3 } from 'three';
import type { Camera, Light, Mesh, Object3D, OrthographicCamera, PerspectiveCamera } from 'three';
import { committedScene, getTransport, useSceneStore } from './state/sceneStore';
import { connectionInfo } from './sync/sync-store';
import { exportSceneText, flushAutosave } from './state/persistence';
import { alignContext, contextFor } from './state/siteContext';
import { setClockSource, tickClock, useClockStore } from './state/dayClock';
import { sunInfoFor } from './state/sunInfo';
import { useViewStore } from './state/viewStore';
import { MAX_VIEWPORT_DPR, MAX_VIEWPORT_PX, MIN_VIEWPORT_PX, parseViewport, useViewportStore } from './state/viewport';
import { activeViewRelay } from './sync/view-relay';
import { appliedPose, yawToHeadingDeg } from './viewer/camera-pose';
import type { FlatStats, FlatTestHook, HistoryInfo } from './test-hook-types';
import { textureStats, texturesSettled } from './viewer/texture-cache';
import { stepWalker } from './viewer/walk-input';
import { effectiveLighting } from './state/effectiveLighting';
import { selectionForId, selectionForWallFace } from './viewer/selection';
import type { ViewState } from './viewer/view-types';
import { CameraPose as CameraPoseSchema, sunPatches } from '@flat/scene';
import type { Command, Scene } from '@flat/scene';

interface FrameInfo {
  scene: Scene;
  view: ViewState;
  /** The camera pose the rig had put on the camera when the frame was drawn. */
  pose?: ViewState['camera'];
}

const FRAME_TIMEOUT_MS = 15_000;
const WALK_STEP_MS = 16;

let canvas: (() => RootState) | null = null;
let resolveCanvas: () => void = () => undefined;
let canvasReady: Promise<void> = Promise.resolve();
/** What the next rendered frame is drawn from (reported by the viewer each frame, before drawing). */
let pendingFrame: FrameInfo | null = null;
/** What the last frame that actually reached the GPU was drawn from. */
let renderedFrame: FrameInfo | null = null;
let frameWaiters: (() => void)[] = [];
/** Draw calls of every frame the r3f loop rendered since the last `clearFrameCalls`. */
let frameCalls: number[] = [];

export function testHookEnabled(): boolean {
  return import.meta.env.DEV || new URLSearchParams(window.location.search).has('test');
}

/** Called by the host with the r3f state once the canvas exists. */
export function registerCanvas(state: RootState): void {
  canvas = state.get;
  resolveCanvas();
}

/** Called by the viewer every frame with the scene/view props it is about to draw. */
export function noteFrame(frame: FrameInfo): void {
  pendingFrame = { ...frame, pose: appliedPose() };
}

function renderNow(): RootState {
  if (!canvas) throw new Error('canvas not ready');
  const s = canvas();
  s.gl.render(s.scene, s.camera);
  return s;
}

/** Resolves after the next frame has been rendered (requests one). */
function nextRenderedFrame(): Promise<void> {
  return new Promise((resolve) => {
    frameWaiters.push(resolve);
    canvas?.().invalidate();
  });
}

/** The store revision each Scene object was published at (a frame is stale when its scene is for an older rev). */
const sceneRevs = new WeakMap<Scene, number>();

/** True when the canvas has the forced viewport's size and pixel ratio (always true when none is forced). */
function viewportReady(): boolean {
  const forced = useViewportStore.getState().forced;
  if (!forced || !canvas) return true;
  const { size, gl } = canvas();
  return size.width === forced.width && size.height === forced.height && gl.getPixelRatio() === forced.dpr;
}

function reflectsStores(): boolean {
  const { scene, rev } = useSceneStore.getState();
  const { mode, selection, lighting, walkLightsOn, translucentDoors, camera } = useViewStore.getState();
  return (
    renderedFrame !== null &&
    (camera === undefined || renderedFrame.pose === camera) &&
    viewportReady() &&
    (scene === null || (renderedFrame.scene === scene && sceneRevs.get(scene) === rev)) &&
    renderedFrame.view.mode === mode &&
    renderedFrame.view.translucentDoors === translucentDoors &&
    renderedFrame.view.selection === selection &&
    renderedFrame.view.lighting === effectiveLighting(lighting, mode, walkLightsOn, scene?.lights)
  );
}

/**
 * Resolves once a frame has been rendered that reflects the current scene, mode and selection,
 * i.e. React has committed them and the GPU frame has been submitted.
 */
async function whenRendered(): Promise<void> {
  const deadline = performance.now() + FRAME_TIMEOUT_MS;
  for (;;) {
    await nextRenderedFrame();
    if (reflectsStores()) break;
    if (performance.now() > deadline) throw new Error('timed out waiting for a rendered frame');
  }
  // Textures requested by that frame (material first use) load asynchronously: wait for them, then
  // for a frame that actually draws them. Loop because a settled load can start another (catalog -> maps).
  for (;;) {
    await Promise.race([
      texturesSettled(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for textures')), FRAME_TIMEOUT_MS)),
    ]);
    await nextRenderedFrame();
    if (textureStats().pending === 0) return;
  }
}

function meshNames(root: Object3D): string[] {
  const names: string[] = [];
  root.traverseVisible((o) => {
    if ((o as Mesh).isMesh && o.name) names.push(o.name);
  });
  return names;
}

function lightStats(root: Object3D): FlatStats['lights'] {
  const out: FlatStats['lights'] = {
    directional: 0,
    hemisphere: 0,
    point: 0,
    spot: 0,
    area: 0,
    lampsLit: [],
    shadowCasters: 0,
    shadowCasterNames: [],
    sunIntensity: 0,
    hemisphereIntensity: 0,
  };
  root.traverseVisible((o) => {
    const l = o as Light & { isDirectionalLight?: boolean; isHemisphereLight?: boolean; isPointLight?: boolean; isSpotLight?: boolean; isRectAreaLight?: boolean };
    if (!l.isLight) return;
    if (l.isDirectionalLight) {
      out.directional++;
      out.sunIntensity += l.intensity;
    } else if (l.isHemisphereLight) {
      out.hemisphere++;
      out.hemisphereIntensity += l.intensity;
    } else if (l.isPointLight) out.point++;
    else if (l.isSpotLight) out.spot++;
    else if (l.isRectAreaLight) out.area++;
    if (o.name.startsWith('lamp:') && l.intensity > 0) out.lampsLit.push(o.name.slice(5));
    if (l.castShadow && l.intensity > 0) {
      out.shadowCasters++;
      out.shadowCasterNames.push(o.name || l.type);
    }
  });
  return out;
}

function shadowCasterMeshes(root: Object3D): string[] {
  const names: string[] = [];
  root.traverseVisible((o) => {
    if ((o as Mesh).isMesh && o.castShadow) names.push(o.name);
  });
  return names;
}

const projected = new Vector3();
const heading = new Vector3();

/**
 * Heading of the camera on the plan, three.js yaw convention (`rotation.y`: positive turns left, forward
 * is `(-sin yaw, -cos yaw)`). A top camera looks straight down, so its screen-up vector stands in for the
 * look direction (yaw = the plan's clockwise rotation on screen).
 */
function cameraYawDeg(camera: Camera): number {
  if ((camera as OrthographicCamera).isOrthographicCamera) heading.copy(camera.up);
  else camera.getWorldDirection(heading);
  return (Math.atan2(-heading.x, -heading.z) * 180) / Math.PI;
}

async function stepAndRender(kind: 'undo' | 'redo'): Promise<{ ok: boolean; canUndo: boolean; canRedo: boolean }> {
  const transport = getTransport();
  // Server mode: the step is a server call; wait until its `applied` entry is shown.
  const ok = transport?.step ? transport.canStep?.(kind) === true && (await transport.step(kind)) : useSceneStore.getState()[kind]();
  if (ok) {
    await canvasReady;
    await whenRendered();
  }
  const { canUndo, canRedo } = useSceneStore.getState();
  return { ok, canUndo, canRedo };
}

export function installTestHook(): void {
  if (!testHookEnabled()) return;
  canvasReady = new Promise<void>((resolve) => {
    resolveCanvas = resolve;
  });
  const noteRev = () => {
    const { scene, rev } = useSceneStore.getState();
    if (scene) sceneRevs.set(scene, rev);
  };
  noteRev();
  useSceneStore.subscribe(noteRev);
  addAfterEffect(() => {
    renderedFrame = pendingFrame;
    if (canvas) frameCalls.push(canvas().gl.info.render.calls);
    const waiters = frameWaiters;
    frameWaiters = [];
    waiters.forEach((w) => w());
  });
  const hook: FlatTestHook = {
    ready: canvasReady.then(whenRendered),
    whenRendered: async () => {
      await canvasReady;
      await whenRendered();
    },
    doorLeaves() {
      const out: ReturnType<FlatTestHook['doorLeaves']> = [];
      canvas?.().scene.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh || o.name !== 'fittings') return;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          if (m.name.startsWith('builtin:door')) out.push({ id: m.name, transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite });
        }
      });
      return out;
    },
    async settleCamera() {
      await canvasReady;
      // Orbit damping keeps coasting for ~100 frames after a drag. Applying the rest of the motion at once lands on the
      // same pose the coasting converges to (the damped steps sum to the whole delta), so tests need not wait frames.
      const controls = canvas?.().controls as { enableDamping?: boolean; update?: () => unknown } | null | undefined;
      // A followed pose is already exact (no momentum): leave the camera alone.
      if (controls?.update && useViewStore.getState().camera === undefined) {
        const damping = controls.enableDamping;
        controls.enableDamping = false;
        controls.update();
        controls.enableDamping = damping;
      }
      await whenRendered();
    },
    stats() {
      const { gl, camera, scene } = renderNow();
      return {
        calls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        textureSets: textureStats(),
        programs: gl.info.programs?.length ?? 0,
        meshes: meshNames(scene),
        mode: useViewStore.getState().mode,
        sceneName: useSceneStore.getState().scene?.name ?? '',
        camera: [camera.position.x, camera.position.y, camera.position.z],
        yawDeg: cameraYawDeg(camera),
        headingDeg: yawToHeadingDeg(cameraYawDeg(camera)),
        pose: useViewStore.getState().camera ?? null,
        canvasSize: [gl.domElement.width, gl.domElement.height],
        fov: (camera as PerspectiveCamera).isPerspectiveCamera ? (camera as PerspectiveCamera).fov : 0,
        dpr: gl.getPixelRatio(),
        lights: lightStats(scene),
        shadowCasterMeshes: shadowCasterMeshes(scene),
        exposure: gl.toneMappingExposure,
        toneMapping: gl.toneMapping === NeutralToneMapping ? 'neutral' : 'other',
      };
    },
    frameCalls: () => [...frameCalls],
    clearFrameCalls() {
      frameCalls = [];
    },
    sunPatches() {
      const { scene, source } = useSceneStore.getState();
      const { lighting } = useViewStore.getState();
      const info = scene ? sunInfoFor(scene, lighting) : null;
      if (!scene || !info?.available) return [];
      // Obstructed by the neighbouring buildings exactly when the viewer draws them.
      const raw = lighting.showContext ? contextFor(source) : null;
      const context = raw ? (alignContext(raw, scene.site).context ?? undefined) : undefined;
      return sunPatches(scene, info.direction, context).map((p) => {
        let cx = 0;
        let cz = 0;
        for (const [x, y] of p.polygon) {
          cx += x;
          cz += y;
        }
        return { roomId: p.roomId, openingId: p.openingId, area: p.area, polygon: p.polygon, centroid: [cx / p.polygon.length, 0, cz / p.polygon.length] as [number, number, number] };
      });
    },
    async setView(partial) {
      await canvasReady;
      useViewStore.getState().setView(partial);
      await whenRendered();
    },
    async loadScene(json) {
      const result = useSceneStore.getState().loadText(typeof json === 'string' ? json : JSON.stringify(json), 'test');
      if (result.ok) {
        await canvasReady;
        await whenRendered();
      }
      return result;
    },
    async setWalkPose({ x, z, yawDeg }) {
      const { camera } = canvas!();
      camera.position.set(x, camera.position.y, z);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(0, (yawDeg * Math.PI) / 180, 0);
      await whenRendered();
    },
    async setCamera(pose) {
      // Defaults (fov, eye height, ...) are filled in; an invalid pose throws.
      const parsed = CameraPoseSchema.parse(pose);
      await canvasReady;
      useViewStore.getState().setCamera(parsed);
      await whenRendered();
    },
    async setViewport(viewport) {
      const parsed = parseViewport(viewport.width, viewport.height, viewport.dpr);
      if (!parsed) {
        throw new Error(
          `invalid viewport: width/height must be ${MIN_VIEWPORT_PX}..${MAX_VIEWPORT_PX} px and dpr in (0, ${MAX_VIEWPORT_DPR}]`,
        );
      }
      await canvasReady;
      useViewportStore.getState().force(parsed);
      await whenRendered();
    },
    receiveView(message) {
      const relay = activeViewRelay();
      return relay ? relay.handle(message) : 'no-server';
    },
    project([x, y, z]) {
      const { camera, gl } = canvas!();
      camera.updateMatrixWorld();
      projected.set(x, y, z).project(camera);
      const rect = gl.domElement.getBoundingClientRect();
      return {
        x: rect.left + ((projected.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - projected.y) / 2) * rect.height,
      };
    },
    capture() {
      // Render synchronously right before reading: no need for preserveDrawingBuffer.
      return renderNow().gl.domElement.toDataURL('image/png');
    },
    async setLighting(partial) {
      await canvasReady;
      useViewStore.getState().setLighting(partial);
      await whenRendered();
    },
    async setComfort(partial) {
      await canvasReady;
      if (partial.translucentDoors !== undefined) useViewStore.getState().setTranslucentDoors(partial.translucentDoors);
      await whenRendered();
    },
    sunInfo() {
      const scene = useSceneStore.getState().scene;
      if (!scene) return { available: false, error: 'no scene loaded' };
      return sunInfoFor(scene, useViewStore.getState().lighting);
    },
    setClock(source) {
      setClockSource(source);
    },
    setPlaying(playing, minutesPerSecond) {
      const clock = useClockStore.getState();
      if (minutesPerSecond !== undefined) clock.setSpeed(minutesPerSecond);
      clock.setPlaying(playing);
    },
    async tick(ms) {
      if (useClockStore.getState().source !== 'manual') throw new Error("tick() needs setClock('manual')");
      await canvasReady;
      tickClock(ms);
      await whenRendered();
    },
    async stepWalk(ms) {
      if (useClockStore.getState().source !== 'manual') throw new Error("stepWalk() needs setClock('manual')");
      await canvasReady;
      for (let left = ms; left > 1e-9; left -= WALK_STEP_MS) {
        if (!stepWalker(Math.min(left, WALK_STEP_MS) / 1000)) throw new Error('stepWalk() needs walk mode');
      }
      await whenRendered();
    },
    async applyCommand(cmd, author) {
      const result = useSceneStore.getState().dispatch(cmd as Command, { author });
      if (result.ok && !('noop' in result && result.noop)) {
        await canvasReady;
        await whenRendered();
      }
      return result;
    },
    async undo() {
      return stepAndRender('undo');
    },
    async redo() {
      return stepAndRender('redo');
    },
    history() {
      const s = useSceneStore.getState();
      const info: HistoryInfo = {
        canUndo: s.canUndo,
        canRedo: s.canRedo,
        labels: [...s.historyLabels],
        entries: s.remoteHistory
          ? s.remoteHistory.past.map((e) => ({ id: e.id, type: e.type, author: e.author }))
          : s.history.past.map((e) => ({ id: e.envelope.id, type: e.envelope.cmd.type, author: e.envelope.author.kind })),
        redoCount: s.remoteHistory ? s.remoteHistory.futureCount : s.history.future.length,
        rev: s.rev,
      };
      return info;
    },
    getScene() {
      const scene = committedScene(useSceneStore.getState());
      if (!scene) throw new Error('no scene loaded');
      return structuredClone(scene);
    },
    exportScene() {
      const text = exportSceneText();
      if (text === null) throw new Error('no scene loaded');
      return text;
    },
    flushAutosave: () => flushAutosave(),
    connection: () => connectionInfo(),
    select(target) {
      const scene = useSceneStore.getState().scene;
      const selection = !scene || !target ? null : typeof target === 'string' ? selectionForId(scene, target) : selectionForWallFace(scene, target);
      useViewStore.getState().select(selection);
      return target === null || selection !== null;
    },
  };
  window.__flat = hook;
}
