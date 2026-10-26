import { Canvas, useFrame } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Scene, SiteContext } from '@flat/scene';
import { CameraRig } from './CameraRig';
import { CompassDriver, CompassOverlay } from './Compass';
import { SelectionHighlight } from './SelectionHighlight';
import { ShellMesh, CLICK_DRAG_TOLERANCE_PX } from './ShellMesh';
import { VIEWER_ELEMENT_ID, WalkControls } from './WalkControls';
import { WalkOverlay } from './WalkOverlay';
import { createMaterialLibrary } from './materials';
import { createRoomAmbient, withRoomAmbient } from './room-ambient';
import { shellFor } from './shell-cache';
import { shadowCasterGeometry } from './derived-geometry';
import { LightingRig } from './LightingRig';
import { sceneKey } from './scene-identity';
import { contextReach } from './sun-bounds';
import type { Selection, ViewState } from './view-types';

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
}

/** The 3D viewer: a pure function of `Scene` + `ViewState`. All UI chrome lives outside it. */
export function FlatCanvas({ scene, view, context = null, onSelect, onExitWalk, onCreated, onFrame }: FlatCanvasProps) {
  const needle = useRef<HTMLDivElement>(null);
  const downAt = useRef<[number, number]>([0, 0]);

  const setNeedle = useCallback((degrees: number) => {
    const el = needle.current;
    if (!el) return;
    el.style.transform = `rotate(${degrees.toFixed(2)}deg)`;
    el.dataset.angle = degrees.toFixed(1);
  }, []);

  const rememberPointerDown = (e: ReactPointerEvent) => {
    downAt.current = [e.clientX, e.clientY];
  };

  return (
    <>
    <div id={VIEWER_ELEMENT_ID} className="viewer" onPointerDownCapture={rememberPointerDown}>
      <Canvas
        frameloop="demand"
        shadows="percentage"
        gl={{ antialias: true }}
        dpr={[1, 2]}
        onCreated={onCreated}
        onPointerMissed={(e) => {
          const moved = Math.hypot(e.clientX - downAt.current[0], e.clientY - downAt.current[1]);
          if (view.mode !== 'walk' && moved <= CLICK_DRAG_TOLERANCE_PX) onSelect(null);
        }}
      >
        <color attach="background" args={['#e8ebf0']} />
        <LightingRig
          scene={scene}
          lighting={view.lighting}
          context={context}
        />
        <Shell scene={scene} view={view} onSelect={onSelect} />
        {view.mode === 'walk' ? (
          <WalkControls key={`walk:${sceneKey(scene)}`} scene={scene} onExit={onExitWalk ?? noop} />
        ) : (
          <CameraRig key={`${view.mode}:${sceneKey(scene)}`} scene={scene} mode={view.mode} extraReach={contextReach(scene, view.lighting.showContext ? context : null)} />
        )}
        {onFrame && <FrameReporter scene={scene} view={view} onFrame={onFrame} />}
        <CompassDriver onAngle={setNeedle} northAngle={scene.site.northAngle} />
      </Canvas>
      <CompassOverlay needle={needle} />
    </div>
      {/* A sibling of the viewer: clicks on it must not engage pointer lock. */}
      {view.mode === 'walk' && <WalkOverlay />}
    </>
  );
}

const noop = () => undefined;

function FrameReporter({ scene, view, onFrame }: { scene: Scene; view: ViewState; onFrame: NonNullable<FlatCanvasProps['onFrame']> }) {
  useFrame(() => onFrame({ scene, view }));
  return null;
}

function Shell({ scene, view, onSelect }: { scene: Scene; view: ViewState; onSelect: (s: Selection) => void }) {
  const shell = useMemo(() => shellFor(scene), [scene]);
  // Per-room sky ambient (windowless rooms get less): an aoMap on the shell materials, see room-ambient.ts.
  const ambient = useMemo(() => createRoomAmbient(scene), [scene]);
  useEffect(() => () => ambient.dispose(), [ambient]);
  const materials = useMemo(() => createMaterialLibrary(scene, ambient.texture), [scene, ambient]);
  useEffect(() => () => materials.dispose(), [materials]);
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
  const pick = walk ? undefined : onSelect;
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
      <ShellMesh name="fittings" data={roomMeshes.fittings} materials={materials} receiveShadow onSelect={pick} />
      <ShellMesh name="items" data={roomMeshes.items} materials={materials} receiveShadow onSelect={pick} />
      <ShellMesh name="glass" data={shell.glass} materials={materials} onSelect={pick} />
      {selectedId && meshes.map((m, i) => <SelectionHighlight key={i} mesh={m} entityId={selectedId} />)}
    </group>
  );
}
