import { addAfterEffect } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { NeutralToneMapping, Vector3 } from 'three';
import type { Camera, Light, Mesh, Object3D, PerspectiveCamera } from 'three';
import { useSceneStore } from './state/sceneStore';
import { alignContext, contextFor } from './state/siteContext';
import { setClockSource, tickClock, useClockStore } from './state/dayClock';
import { sunInfoFor } from './state/sunInfo';
import { useViewStore } from './state/viewStore';
import type { FlatStats, FlatTestHook } from './test-hook-types';
import { stepWalker } from './viewer/walk-input';
import { selectionForId } from './viewer/selection';
import type { ViewState } from './viewer/view-types';
import { sunPatches } from '@flat/scene';
import type { Scene } from '@flat/scene';

interface FrameInfo {
  scene: Scene;
  view: ViewState;
}

const FRAME_TIMEOUT_MS = 15_000;
const WALK_STEP_MS = 16;

let canvas: (() => RootState) | null = null;
let resolveCanvas: () => void = () => undefined;
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
  pendingFrame = frame;
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

function reflectsStores(): boolean {
  const { scene } = useSceneStore.getState();
  const { mode, selection, lighting } = useViewStore.getState();
  return (
    renderedFrame !== null &&
    (scene === null || renderedFrame.scene === scene) &&
    renderedFrame.view.mode === mode &&
    renderedFrame.view.selection === selection &&
    renderedFrame.view.lighting === lighting
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
    if (reflectsStores()) return;
    if (performance.now() > deadline) throw new Error('timed out waiting for a rendered frame');
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

function cameraYawDeg(camera: Camera): number {
  camera.getWorldDirection(heading);
  return (Math.atan2(-heading.x, -heading.z) * 180) / Math.PI;
}

export function installTestHook(): void {
  if (!testHookEnabled()) return;
  const canvasReady = new Promise<void>((resolve) => {
    resolveCanvas = resolve;
  });
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
    stats() {
      const { gl, camera, scene } = renderNow();
      return {
        calls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        programs: gl.info.programs?.length ?? 0,
        meshes: meshNames(scene),
        mode: useViewStore.getState().mode,
        sceneName: useSceneStore.getState().scene?.name ?? '',
        camera: [camera.position.x, camera.position.y, camera.position.z],
        yawDeg: cameraYawDeg(camera),
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
    select(id) {
      const scene = useSceneStore.getState().scene;
      const selection = scene && id ? selectionForId(scene, id) : null;
      useViewStore.getState().select(selection);
      return id === null || selection !== null;
    },
  };
  window.__flat = hook;
}
