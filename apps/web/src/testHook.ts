import { addAfterEffect } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { Vector3 } from 'three';
import type { Mesh, Object3D } from 'three';
import { useSceneStore } from './state/sceneStore';
import { useViewStore } from './state/viewStore';
import type { FlatTestHook } from './test-hook-types';
import { selectionForId } from './viewer/selection';
import type { ViewState } from './viewer/view-types';
import type { Scene } from '@flat/scene';

interface FrameInfo {
  scene: Scene;
  view: ViewState;
}

const FRAME_TIMEOUT_MS = 15_000;

let canvas: (() => RootState) | null = null;
let resolveCanvas: () => void = () => undefined;
/** What the next rendered frame is drawn from (reported by the viewer each frame, before drawing). */
let pendingFrame: FrameInfo | null = null;
/** What the last frame that actually reached the GPU was drawn from. */
let renderedFrame: FrameInfo | null = null;
let frameWaiters: (() => void)[] = [];

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
  const { mode, selection } = useViewStore.getState();
  return (
    renderedFrame !== null &&
    (scene === null || renderedFrame.scene === scene) &&
    renderedFrame.view.mode === mode &&
    renderedFrame.view.selection === selection
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

const projected = new Vector3();

export function installTestHook(): void {
  if (!testHookEnabled()) return;
  const canvasReady = new Promise<void>((resolve) => {
    resolveCanvas = resolve;
  });
  addAfterEffect(() => {
    renderedFrame = pendingFrame;
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
      };
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
    select(id) {
      const scene = useSceneStore.getState().scene;
      const selection = scene && id ? selectionForId(scene, id) : null;
      useViewStore.getState().select(selection);
      return id === null || selection !== null;
    },
  };
  window.__flat = hook;
}
