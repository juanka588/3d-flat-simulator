import type { RootState } from '@react-three/fiber';
import { useSceneStore } from './state/sceneStore';
import { useViewStore } from './state/viewStore';
import type { FlatTestHook } from './test-hook-types';
import { selectionForId } from './viewer/selection';

let canvas: (() => RootState) | null = null;
let resolveReady: () => void = () => undefined;

export function testHookEnabled(): boolean {
  return import.meta.env.DEV || new URLSearchParams(window.location.search).has('test');
}

/** Called by the host with the r3f state once the canvas exists. */
export function registerCanvas(state: RootState): void {
  canvas = state.get;
  // Wait for the first rendered frame before declaring ready.
  requestAnimationFrame(() => requestAnimationFrame(() => resolveReady()));
}

function renderNow(): RootState {
  if (!canvas) throw new Error('canvas not ready');
  const s = canvas();
  s.gl.render(s.scene, s.camera);
  return s;
}

const nextFrames = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export function installTestHook(): void {
  if (!testHookEnabled()) return;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const hook: FlatTestHook = {
    ready,
    stats() {
      const { gl, camera } = renderNow();
      return {
        calls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        geometries: gl.info.memory.geometries,
        mode: useViewStore.getState().mode,
        sceneName: useSceneStore.getState().scene?.name ?? '',
        camera: [camera.position.x, camera.position.y, camera.position.z],
      };
    },
    async setView(partial) {
      useViewStore.getState().setView(partial);
      await nextFrames();
    },
    loadScene(json) {
      return useSceneStore.getState().loadText(typeof json === 'string' ? json : JSON.stringify(json), 'test');
    },
    capture() {
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
