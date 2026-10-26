import { Canvas, useFrame } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Scene } from '@flat/scene';
import { CameraRig } from './CameraRig';
import { CompassDriver, CompassOverlay } from './Compass';
import { SelectionHighlight } from './SelectionHighlight';
import { ShellMesh, CLICK_DRAG_TOLERANCE_PX } from './ShellMesh';
import { VIEWER_ELEMENT_ID, WalkControls } from './WalkControls';
import { createMaterialLibrary } from './materials';
import { shellFor } from './shell-cache';
import type { Selection, ViewState } from './view-types';

export interface FlatCanvasProps {
  scene: Scene;
  view: ViewState;
  onSelect: (selection: Selection | null) => void;
  /** Called when the user leaves walk mode (Esc / pointer-lock release). */
  onExitWalk?: () => void;
  /** Gives the host access to the r3f state (used by the test hook). */
  onCreated?: (state: RootState) => void;
  /** Called every frame with the scene/view the frame is drawn from (used by the test hook). */
  onFrame?: (frame: { scene: Scene; view: ViewState }) => void;
}

/** The 3D viewer: a pure function of `Scene` + `ViewState`. All UI chrome lives outside it. */
export function FlatCanvas({ scene, view, onSelect, onExitWalk, onCreated, onFrame }: FlatCanvasProps) {
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
    <div id={VIEWER_ELEMENT_ID} className="viewer" onPointerDownCapture={rememberPointerDown}>
      <Canvas
        frameloop="demand"
        gl={{ antialias: true }}
        dpr={[1, 2]}
        onCreated={onCreated}
        onPointerMissed={(e) => {
          const moved = Math.hypot(e.clientX - downAt.current[0], e.clientY - downAt.current[1]);
          if (view.mode !== 'walk' && moved <= CLICK_DRAG_TOLERANCE_PX) onSelect(null);
        }}
      >
        <color attach="background" args={['#e8ebf0']} />
        {/* Neutral lighting for now; M2 replaces it with the sun. */}
        <hemisphereLight args={['#ffffff', '#8c8578', 1.4]} />
        <directionalLight position={[8, 18, 6]} intensity={1.6} />
        <Shell scene={scene} view={view} onSelect={onSelect} />
        {view.mode === 'walk' ? (
          <WalkControls key={`walk:${sceneKey(scene)}`} scene={scene} onExit={onExitWalk ?? noop} />
        ) : (
          <CameraRig key={`${view.mode}:${sceneKey(scene)}`} scene={scene} mode={view.mode} />
        )}
        {onFrame && <FrameReporter scene={scene} view={view} onFrame={onFrame} />}
        <CompassDriver onAngle={setNeedle} northAngle={scene.site.northAngle} />
      </Canvas>
      <CompassOverlay needle={needle} />
    </div>
  );
}

const noop = () => undefined;

function FrameReporter({ scene, view, onFrame }: { scene: Scene; view: ViewState; onFrame: NonNullable<FlatCanvasProps['onFrame']> }) {
  useFrame(() => onFrame({ scene, view }));
  return null;
}

// Stable identity key per Scene object, so camera rigs remount when a new scene loads.
const keys = new WeakMap<Scene, number>();
let nextKey = 0;
function sceneKey(scene: Scene): number {
  let k = keys.get(scene);
  if (k === undefined) {
    k = nextKey++;
    keys.set(scene, k);
  }
  return k;
}

function Shell({ scene, view, onSelect }: { scene: Scene; view: ViewState; onSelect: (s: Selection) => void }) {
  const shell = useMemo(() => shellFor(scene), [scene]);
  const materials = useMemo(() => createMaterialLibrary(scene), [scene]);
  useEffect(() => () => materials.dispose(), [materials]);

  const walk = view.mode === 'walk';
  const pick = walk ? undefined : onSelect;
  const selectedId = view.selection?.entityId;
  const meshes = [shell.walls, shell.floors, shell.fittings, shell.glass, ...(walk ? [shell.ceilings] : [])];

  return (
    <group name="shell">
      <ShellMesh name="walls" data={shell.walls} materials={materials} castShadow receiveShadow onSelect={pick} />
      <ShellMesh name="floors" data={shell.floors} materials={materials} receiveShadow onSelect={pick} />
      {/* Ceilings are hidden in orbit/top so the interior stays visible from above. */}
      {walk && <ShellMesh name="ceilings" data={shell.ceilings} materials={materials} castShadow onSelect={pick} />}
      <ShellMesh name="fittings" data={shell.fittings} materials={materials} castShadow receiveShadow onSelect={pick} />
      <ShellMesh name="glass" data={shell.glass} materials={materials} castShadow={false} onSelect={pick} />
      {selectedId && meshes.map((m, i) => <SelectionHighlight key={i} mesh={m} entityId={selectedId} />)}
    </group>
  );
}
