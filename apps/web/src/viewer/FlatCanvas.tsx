import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { BUILTIN_MATERIALS, buildItems } from '@flat/scene';
import type { ShellMeshes } from '@flat/scene';
import type { Scene, SiteContext } from '@flat/scene';
import { CameraRig } from './CameraRig';
import { buildingFraming } from './building-framing';
import { CompassDriver, CompassOverlay } from './Compass';
import { SelectionHighlight } from './SelectionHighlight';
import { StructuralOverlay } from './StructuralOverlay';
import { ShellMesh, CLICK_DRAG_TOLERANCE_PX } from './ShellMesh';
import { ItemsMesh, useItemModels } from './ItemsMesh';
import { PlacementLayer } from './PlacementLayer';
import { ZoneEditor } from './ZoneEditor';
import { VIEWER_ELEMENT_ID, WalkControls } from './WalkControls';
import { WalkOverlay } from './WalkOverlay';
import { DOOR_WALK_MATERIAL, createMaterialLibrary } from './materials';
import { getPerfProfile } from './perf';
import { createRoomAmbient, withRoomAmbient } from './room-ambient';
import { shellFor } from './shell-cache';
import { withHitContext } from './selection';
import { MAX_ANISOTROPY, textureCache } from './texture-cache';
import { shadowCasterGeometry } from './derived-geometry';
import { ContactShadows } from './ContactShadows';
import { LightingRig } from './LightingRig';
import { computeLighting, resolveLamps, roomLampBounce } from './lighting';
import { sceneKey } from './scene-identity';
import { contextReach } from './sun-bounds';
import type { Selection, ViewState } from './view-types';
import { ViewerGuard } from './ViewerGuard';
import { shouldInjectFault, useViewerHealth } from './viewer-health';

export interface FlatCanvasProps {
  scene: Scene;
  view: ViewState;
  /** Neighbouring buildings and ground (optional); shown when `view.lighting.showContext`. */
  context?: SiteContext | null;
  onSelect: (selection: Selection | null) => void;
  /** Called when the user leaves walk mode (Esc / pointer-lock release). */
  onExitWalk?: () => void;
  /** Gives the host access to the r3f state (used by the test hook). */
  onCreated?: (state: RootState) => void;
  /** Called every frame with the scene/view the frame is drawn from (used by the test hook). */
  onFrame?: (frame: { scene: Scene; view: ViewState }) => void;
  /** The user started moving the camera by hand: `view.camera`, if set, should be dropped. */
  onUserCamera?: () => void;
  /** A forced render surface (CSS px + dpr) instead of filling the stage; used by the test hook and the headless renderer. */
  viewport?: { width: number; height: number; dpr: number } | null;
}

/** The 3D viewer: a pure function of `Scene` + `ViewState`. All UI chrome lives outside it. */
export function FlatCanvas({ scene, view, context = null, onSelect, onExitWalk, onCreated, onFrame, onUserCamera, viewport = null }: FlatCanvasProps) {
  const needle = useRef<HTMLDivElement>(null);
  const downAt = useRef<[number, number]>([0, 0]);

  const setNeedle = useCallback((degrees: number) => {
    const el = needle.current;
    if (!el) return;
    el.style.transform = `rotate(${degrees.toFixed(2)}deg)`;
    el.dataset.angle = degrees.toFixed(1);
  }, []);

  // One object per (scene, lighting, context) so the guard can keep the last combination that drew fine.
  const buildingMode = view.buildingMode ?? 'ghost';
  const framing = useMemo(() => buildingFraming(scene, view.lighting.showContext ? context : null), [scene, context, view.lighting.showContext]);
  const lightingInput = useMemo(() => ({ scene, lighting: view.lighting, context, viewMode: view.mode, buildingMode }), [scene, view.lighting, context, view.mode, buildingMode]);

  const rememberPointerDown = (e: ReactPointerEvent) => {
    downAt.current = [e.clientX, e.clientY];
  };

  return (
    <>
    <div
      id={VIEWER_ELEMENT_ID}
      className={viewport ? 'viewer forced' : 'viewer'}
      style={viewport ? { right: 'auto', bottom: 'auto', width: viewport.width, height: viewport.height } : undefined}
      onPointerDownCapture={rememberPointerDown}>
      <Canvas
        frameloop="demand"
        shadows="percentage"
        gl={{ antialias: true }}
        dpr={viewport ? viewport.dpr : [1, getPerfProfile().maxDpr]}
        onCreated={onCreated}
        onPointerMissed={(e) => {
          const moved = Math.hypot(e.clientX - downAt.current[0], e.clientY - downAt.current[1]);
          if (view.mode !== 'walk' && moved <= CLICK_DRAG_TOLERANCE_PX) onSelect(null);
        }}
      >
        <color attach="background" args={['#e8ebf0']} />
        <ViewerGuard value={lightingInput} source="lighting">
          {(l) => <LightingRig scene={l.scene} lighting={l.lighting} context={l.context} viewMode={l.viewMode} buildingMode={l.buildingMode} />}
        </ViewerGuard>
        <ViewerGuard value={scene} source="shell">
          {(sc) => <Shell scene={sc} view={view} onSelect={onSelect} />}
        </ViewerGuard>
        {view.mode === 'top' && <StructuralOverlay scene={scene} />}
        {view.mode !== 'walk' && <PlacementLayer scene={scene} selectedId={view.selection?.kind === 'item' ? view.selection.entityId : undefined} />}
        {view.mode !== 'walk' && <ZoneEditor scene={scene} selection={view.selection} />}
        {view.mode === 'walk' ? (
          <WalkControls key={`walk:${sceneKey(scene)}`} scene={scene} personHeightCm={view.personHeightCm} onExit={onExitWalk ?? noop} pose={view.camera?.mode === 'walk' ? view.camera : undefined} onUserCamera={onUserCamera} />
        ) : (
          <CameraRig key={`${view.mode}:${sceneKey(scene)}`} scene={scene} mode={view.mode} extraReach={contextReach(scene, view.lighting.showContext ? context : null)} framing={framing} pose={view.camera} onUserCamera={onUserCamera} />
        )}
        {onFrame && <FrameReporter scene={scene} view={view} onFrame={onFrame} />}
        <CompassDriver onAngle={setNeedle} northAngle={scene.site.northAngle} />
      </Canvas>
      <CompassOverlay needle={needle} />
    </div>
      {/* A sibling of the viewer: clicks on it must not engage pointer lock. */}
      {view.mode === 'walk' && <WalkOverlay onExit={onExitWalk} />}
    </>
  );
}

const noop = () => undefined;

function FrameReporter({ scene, view, onFrame }: { scene: Scene; view: ViewState; onFrame: NonNullable<FlatCanvasProps['onFrame']> }) {
  useFrame(() => onFrame({ scene, view }));
  return null;
}

/** Walk mode draws door leaves see-through (see DOOR_WALK_MATERIAL). */
const WALK_SWAP = { [BUILTIN_MATERIALS.door]: DOOR_WALK_MATERIAL } as const;

function Shell({ scene, view, onSelect }: { scene: Scene; view: ViewState; onSelect: (s: Selection) => void }) {
  if (shouldInjectFault(scene.name)) throw new Error('injected viewer fault (test)');
  const baseShell = useMemo(() => shellFor(scene), [scene]);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  // Items that resolve to a GLB model (or wait for one) are drawn by ItemsMesh; the rest stay in the shell's items mesh.
  const models = useItemModels(scene, invalidate);
  const shell = useMemo<ShellMeshes>(
    () => (models.claimed.size === 0 ? baseShell : { ...baseShell, items: buildItems({ items: scene.items.filter((i) => !models.claimed.has(i.id)) }) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `claimed` is a new set per render; its content changes with `version`
    [baseShell, scene.items, models.version, models.claimed.size],
  );
  // Per-room sky ambient (windowless rooms get less): an aoMap on the shell materials, see room-ambient.ts.
  const ambient = useMemo(() => createRoomAmbient(scene), [scene]);
  useEffect(() => () => ambient.dispose(), [ambient]);
  // Per-room lamp bounce (approximate indirect light of the lamps that are on, local to their room): data in a texture,
  // so switching a lamp changes texels and never the shaders.
  const lamps = useMemo(() => resolveLamps(scene, view.lighting), [scene, view.lighting]);
  // The bounce is white-balanced like the lamps themselves (see `awbWeight`).
  const awb = useMemo(() => {
    const m = computeLighting(scene, view.lighting);
    return m.ok ? m.awb : 0;
  }, [scene, view.lighting]);
  useLayoutEffect(() => {
    ambient.bounce.set(roomLampBounce(scene, lamps, awb));
    invalidate();
  }, [ambient, scene, lamps, awb, invalidate]);
  // One material library per canvas, kept in step with the scene: an edit updates changed materials in place
  // (the same objects, so no texture is released, re-fetched or re-uploaded); it is never rebuilt per scene.
  const library = useMemo(
    () =>
      createMaterialLibrary(null, undefined, {
        anisotropy: Math.min(MAX_ANISOTROPY, gl.capabilities.getMaxAnisotropy()),
        onChange: () => invalidate(),
      }),
    [gl, invalidate],
  );
  // Updated while rendering (idempotent) so that meshes rendered below already see the new materials.
  const materials = useMemo(() => {
    library.update(scene.materials, ambient.texture, ambient.bounce.texture);
    return library.snapshot();
  }, [library, scene.materials, ambient]);
  // Materials the update removed are disposed once the render that stopped using them is committed.
  useEffect(() => library.commit());
  useEffect(() => {
    library.resume();
    return () => library.dispose();
  }, [library]);
  // After a lost WebGL context everything is re-uploaded: drop the cached sets and reload the used ones.
  useEffect(() => {
    const canvas = gl.domElement;
    const restored = () => {
      textureCache.reset();
      models.controller.restore();
      invalidate();
      useViewerHealth.getState().clear('webgl');
    };
    const lost = () => useViewerHealth.getState().report({ source: 'webgl', message: 'the graphics context was lost (GPU reset or too many tabs); it will be restored if the browser allows', keptLastGood: false });
    canvas.addEventListener('webglcontextrestored', restored);
    canvas.addEventListener('webglcontextlost', lost);
    return () => {
      canvas.removeEventListener('webglcontextrestored', restored);
      canvas.removeEventListener('webglcontextlost', lost);
    };
  }, [gl, models.controller, invalidate]);
  const roomMeshes = useMemo(
    () => ({
      walls: withRoomAmbient(shell.walls, scene, ambient),
      floors: withRoomAmbient(shell.floors, scene, ambient),
      ceilings: withRoomAmbient(shell.ceilings, scene, ambient),
      fittings: withRoomAmbient(shell.fittings, scene, ambient),
      items: withRoomAmbient(shell.items, scene, ambient),
    }),
    [shell, scene, ambient],
  );

  const walk = view.mode === 'walk';
  const pick = walk ? undefined : (sel: Selection, point: [number, number]) => onSelect(withHitContext(scene, sel, point));
  const selectedId = view.selection?.entityId;
  const casters = useMemo(() => shadowCasterGeometry(shell), [shell]);
  useEffect(() => () => casters.dispose(), [casters]);
  const meshes = [shell.walls, shell.floors, shell.fittings, shell.items, shell.glass, ...(walk ? [shell.ceilings] : [])];

  return (
    <group name="shell">
      {/* Shadows come from one invisible merged mesh (see shadowCasterGeometry); the visible meshes only receive. */}
      <mesh name="shadow-casters" geometry={casters} castShadow raycast={noop}>
        <meshBasicMaterial colorWrite={false} depthWrite={false} />
      </mesh>
      <ShellMesh name="walls" data={roomMeshes.walls} materials={materials} receiveShadow onSelect={pick} />
      <ShellMesh name="floors" data={roomMeshes.floors} materials={materials} receiveShadow onSelect={pick} />
      {/* Ceilings are hidden in orbit/top so the interior stays visible from above. */}
      {walk && <ShellMesh name="ceilings" data={roomMeshes.ceilings} materials={materials} onSelect={pick} />}
      <ShellMesh name="fittings" data={roomMeshes.fittings} materials={materials} receiveShadow swap={walk && view.translucentDoors !== false ? WALK_SWAP : undefined} renderOrder={1} onSelect={pick} />
      <ShellMesh name="items" data={roomMeshes.items} materials={materials} receiveShadow onSelect={pick} />
      <ItemsMesh scene={scene} models={models} selectedId={selectedId} onSelect={pick} />
      {getPerfProfile().contactShadows && <ContactShadows scene={scene} itemMesh={shell.items} controller={models.controller} version={models.version} />}
      <ShellMesh name="glass" data={shell.glass} materials={materials} renderOrder={2} onSelect={pick} />
      {selectedId && meshes.map((m, i) => <SelectionHighlight key={i} mesh={m} entityId={selectedId} zoneId={view.selection?.zoneId} />)}
    </group>
  );
}
