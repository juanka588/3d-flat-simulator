import { addAfterEffect } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { Box3, Matrix4, NeutralToneMapping, Raycaster, Vector3 } from 'three';
import type { Camera, InstancedMesh, Light, Mesh, Object3D, OrthographicCamera, PerspectiveCamera } from 'three';
import { committedScene, getTransport, useSceneStore } from './state/sceneStore';
import { connectionInfo } from './sync/sync-store';
import { exportSceneText, flushAutosave } from './state/persistence';
import { alignContext, contextFor } from './state/siteContext';
import { setClockSource, tickClock, useClockStore } from './state/dayClock';
import { sunInfoFor } from './state/sunInfo';
import { useViewStore } from './state/viewStore';
import { MAX_VIEWPORT_DPR, MAX_VIEWPORT_PX, MIN_VIEWPORT_PX, parseViewport, useViewportStore } from './state/viewport';
import { activeViewRelay } from './sync/view-relay';
import { modelStats, selectionForId, selectionForWallFace } from '@flat/viewer';
import type { ViewState } from '@flat/viewer';
import { appliedPose, renderPasses, modelsSettled, probeControls, probesSettled, probeStats, setMeshResolverOverride, setModelOriginOverride, setProviderFrontOverride, stepWalker, texturesSettled, textureStats, transformBox, yawToHeadingDeg } from '@flat/viewer/testing';
import type { Box } from '@flat/assets';
import type { FlatStats, FlatTestHook, HistoryInfo } from './test-hook-types';
import { dragState } from './catalog/placement';
import { effectiveLighting } from './state/effectiveLighting';
import { CameraPose as CameraPoseSchema, sunPatches } from '@flat/scene';
import type { Command, Scene } from '@flat/scene';

interface FrameInfo {
  scene: Scene;
  view: ViewState;
  /** The camera pose the rig had put on the camera when the frame was drawn. */
  pose?: ViewState['camera'];
}

const FRAME_TIMEOUT_MS = 15_000;
/** Longest wait for a light-probe bake (a software renderer needs several seconds per bake, more on a loaded CI runner). */
const PROBE_TIMEOUT_MS = 120_000;
/** How long a frame waits for model downloads before drawing the placeholders instead; null = the frame timeout, as an error. */
let modelWaitMs: number | null = null;
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
  const { mode, selection, lighting, walkLightsOn, translucentDoors, buildingMode, camera, showPerson, person } = useViewStore.getState();
  return (
    renderedFrame !== null &&
    (camera === undefined || renderedFrame.pose === camera) &&
    viewportReady() &&
    (scene === null || (renderedFrame.scene === scene && sceneRevs.get(scene) === rev)) &&
    renderedFrame.view.mode === mode &&
    renderedFrame.view.translucentDoors === translucentDoors &&
    renderedFrame.view.buildingMode === buildingMode &&
    renderedFrame.view.showPerson === showPerson &&
    renderedFrame.view.person === person &&
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
  const modelsDeadline = performance.now() + (modelWaitMs ?? FRAME_TIMEOUT_MS);
  for (;;) {
    await Promise.race([
      texturesSettled(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for textures')), FRAME_TIMEOUT_MS)),
    ]);
    // Models (GLB items) load the same way: wait for them too, then for a frame that draws them. With a model wait set, items whose
    // model is still downloading when it runs out are drawn as placeholder boxes (reported by `modelStats().loading`) instead of failing the frame.
    const gaveUp = await Promise.race([
      modelsSettled().then(() => false),
      new Promise<boolean>((resolve, reject) =>
        setTimeout(() => (modelWaitMs === null ? reject(new Error('timed out waiting for models')) : resolve(true)), Math.max(0, modelsDeadline - performance.now())),
      ),
    ]);
    // Baked light probes: the bake is debounced and time-sliced (seconds on a software renderer), the frame must show its result.
    await Promise.race([
      probesSettled(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for the light-probe bake')), PROBE_TIMEOUT_MS)),
    ]);
    await nextRenderedFrame();
    if (gaveUp) return;
    if (textureStats().pending === 0 && modelStats().pending === 0 && !probeStats().pending) return;
  }
}

/** True when a ray dropped from far above the mesh's bounding-box centre hits it (host-building meshes must never be pickable). */
function isPickable(mesh: Mesh): boolean {
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  if (!box) return false;
  const c = box.getCenter(new Vector3());
  const ray = new Raycaster(new Vector3(c.x, 1000, c.z), new Vector3(0, -1, 0));
  const hits: unknown[] = [];
  mesh.raycast(ray, hits as never);
  return hits.length > 0;
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
    lampLights: 0,
    lampShadowCasters: 0,
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
    if (o.name.startsWith('lamp:')) {
      // grid tiles are `lamp:<id>#<tile>`: report the lamp once
      const id = o.name.slice(5).split('#')[0]!;
      out.lampLights++;
      if (l.castShadow) out.lampShadowCasters++;
      if (l.intensity > 0 && !out.lampsLit.includes(id)) out.lampsLit.push(id);
    }
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

/** World bounding box of the GLB-drawn item `id` (plain or instanced), read from the objects actually in the scene. */
function itemWorldBox(root: Object3D, id: string): Box | null {
  const box = new Box3();
  const m = new Matrix4();
  root.updateMatrixWorld(true);
  let found = false;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || mesh.name !== 'items-glb') return;
    mesh.geometry.computeBoundingBox();
    const g = mesh.geometry.boundingBox!;
    const native: Box = { min: [g.min.x, g.min.y, g.min.z], max: [g.max.x, g.max.y, g.max.z] };
    const inst = o as InstancedMesh;
    if (inst.isInstancedMesh) {
      const ids = (inst.userData['itemIds'] ?? []) as string[];
      const at = ids.indexOf(id);
      if (at < 0) return;
      inst.getMatrixAt(at, m);
      m.premultiply(inst.matrixWorld);
    } else {
      let owner: Object3D | null = o;
      while (owner && owner.userData['itemId'] === undefined) owner = owner.parent;
      if (owner?.userData['itemId'] !== id) return;
      m.copy(mesh.matrixWorld);
    }
    const b = transformBox(native, m);
    box.expandByPoint(new Vector3(...b.min)).expandByPoint(new Vector3(...b.max));
    found = true;
  });
  return found ? { min: box.min.toArray() as Box['min'], max: box.max.toArray() as Box['max'] } : null;
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

/** Degrees above (+) or below (-) the horizon the camera looks. */
function cameraPitchDeg(camera: Camera): number {
  camera.getWorldDirection(heading);
  return (Math.asin(Math.max(-1, Math.min(1, heading.y))) * 180) / Math.PI;
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
    personGhost() {
      const root = canvas?.().scene;
      if (!root) return null;
      let found: Mesh | null = null;
      root.traverse((o) => {
        if (o.name === 'person-ghost' && (o as Mesh).isMesh) found = o as Mesh;
      });
      const mesh = found as Mesh | null;
      if (!mesh) return null;
      mesh.updateWorldMatrix(true, false);
      const box = new Box3().setFromObject(mesh);
      const group = mesh.parent!;
      const material = mesh.material as { opacity: number };
      return {
        heightM: box.max.y - box.min.y,
        x: group.position.x,
        z: group.position.z,
        yawDeg: (group.rotation.y * 180) / Math.PI - 180,
        castShadow: mesh.castShadow,
        receiveShadow: mesh.receiveShadow,
        opacity: material.opacity,
        source: mesh.userData['source'] === 'glb' ? 'glb' : 'parametric',
      };
    },
    hostBuilding() {
      const out: ReturnType<FlatTestHook['hostBuilding']> = [];
      canvas?.().scene.traverse((o) => {
        if (!o.name.startsWith('host-')) return;
        const mesh = o as Mesh;
        const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as { opacity?: number; transparent?: boolean; depthWrite?: boolean } | undefined;
        out.push({
          name: o.name,
          visible: o.visible,
          castShadow: !!o.castShadow,
          pickable: isPickable(mesh),
          opacity: material?.opacity ?? 1,
          transparent: !!material?.transparent,
          depthWrite: material?.depthWrite !== false,
        });
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
        maxTextures: gl.capabilities.maxTextures,
        meshes: meshNames(scene),
        mode: useViewStore.getState().mode,
        sceneName: useSceneStore.getState().scene?.name ?? '',
        camera: [camera.position.x, camera.position.y, camera.position.z],
        yawDeg: cameraYawDeg(camera),
        pitchDeg: cameraPitchDeg(camera),
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
    async passes(request) {
      await canvasReady;
      const size = request?.size ? parseViewport(request.size.width, request.size.height, 1) : null;
      if (request?.size && !size) throw new Error(`invalid passes size: width/height must be ${MIN_VIEWPORT_PX}..${MAX_VIEWPORT_PX} px`);
      const before = useViewportStore.getState().forced;
      if (size) useViewportStore.getState().force(size);
      try {
        await whenRendered();
        const { gl, scene, camera } = canvas!();
        const model = renderedFrame?.scene ?? useSceneStore.getState().scene;
        if (!model) throw new Error('no scene loaded');
        return await renderPasses({ gl, scene, camera, model }, request);
      } finally {
        if (size) useViewportStore.getState().force(before);
      }
    },
    async setLighting(partial) {
      await canvasReady;
      useViewStore.getState().setLighting(partial);
      await whenRendered();
    },
    async setComfort(partial) {
      await canvasReady;
      if (partial.translucentDoors !== undefined) useViewStore.getState().setTranslucentDoors(partial.translucentDoors);
      if (partial.showPerson !== undefined) useViewStore.getState().setShowPerson(partial.showPerson);
      if (partial.buildingMode !== undefined) useViewStore.getState().setBuildingMode(partial.buildingMode);
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
    modelStats: () => modelStats(),
    probes: () => probeStats(),
    async rebakeProbes() {
      await canvasReady;
      await probeControls()?.rebake();
      await whenRendered();
    },
    probeHash: () => probeControls()?.hash() ?? '',
    placement: () => dragState(),
    itemBounds: (id) => {
      if (!canvas) throw new Error('canvas not ready');
      return itemWorldBox(canvas().scene, id);
    },
    setMeshResolver: (fn) => setMeshResolverOverride(fn as Parameters<typeof setMeshResolverOverride>[0]),
    setModelOrigin: (origin) => setModelOriginOverride(origin),
    setModelWaitMs: (ms) => {
      modelWaitMs = ms;
    },
    setProviderFront: (fn) => setProviderFrontOverride(fn),
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
