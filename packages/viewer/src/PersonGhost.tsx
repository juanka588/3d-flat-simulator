import { useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CanvasTexture, CircleGeometry, CylinderGeometry, DoubleSide, MeshBasicMaterial, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { insideFlat, resolveWalk, walkObstacles } from '@flat/scene';
import type { Scene } from '@flat/scene';
import { loadPersonGlb } from './person-glb';
import type { PersonGlb } from './person-glb';
import { createPersonGeometry } from './person-model';
import { BODY_RADIUS } from './walk-start';
import type { PersonPlacement } from './walk-start';

// Saturated enough to read against grey walls and floors; drawn without depth test so it also shows through walls (a ghost).
const GHOST_COLOR = '#2f7df6';
const GHOST_OPACITY = 0.55;
const HIT_RADIUS = 0.32;

let shadowTexture: CanvasTexture | null = null;
/** A soft round blob, the faint contact shadow under the ghost. */
function contactShadowTexture(): CanvasTexture {
  if (shadowTexture) return shadowTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.38)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.16)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  shadowTexture = new CanvasTexture(canvas);
  return shadowTexture;
}

/**
 * A translucent mannequin at the person's height standing where a walk would start (orbit and top views), for a
 * sense of scale. Drag it to choose the walk start: it slides along walls and stays inside the rooms. It is drawn
 * unlit and casts/receives no shadow; a faint blob on the floor grounds it.
 */
export function PersonGhost({
  scene,
  heightCm,
  placement,
  onMove,
}: {
  scene: Scene;
  heightCm: number;
  placement: PersonPlacement;
  onMove?: (x: number, z: number) => void;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const get = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  const heightM = heightCm / 100;
  // The HD library figure when it is available (loaded once, lazily); the parametric mannequin until then and when it is not.
  const [glb, setGlb] = useState<PersonGlb | null>(null);
  useEffect(() => {
    let alive = true;
    void loadPersonGlb().then((g) => {
      if (alive && g) {
        setGlb(g);
        invalidate();
      }
    });
    return () => {
      alive = false;
    };
  }, [invalidate]);
  const parametric = useMemo(() => (glb ? null : createPersonGeometry(heightM)), [glb, heightM]);
  useEffect(() => () => parametric?.dispose(), [parametric]);
  const body = glb?.geometry ?? parametric!;
  const bodyScale = glb ? heightM / glb.height : 1; // uniform: the figure is exactly the person height
  const hit = useMemo(() => {
    const g = new CylinderGeometry(HIT_RADIUS, HIT_RADIUS, heightM, 10);
    g.translate(0, heightM / 2, 0);
    return g;
  }, [heightM]);
  useEffect(() => () => hit.dispose(), [hit]);
  const material = useMemo(
    () => new MeshBasicMaterial({ color: GHOST_COLOR, vertexColors: true, transparent: true, opacity: GHOST_OPACITY, depthTest: false, depthWrite: false, toneMapped: false }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  const hitMaterial = useMemo(() => new MeshBasicMaterial({ visible: false }), []);
  useEffect(() => () => hitMaterial.dispose(), [hitMaterial]);
  const blob = useMemo(() => new MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, depthWrite: false, toneMapped: false, side: DoubleSide }), []);
  useEffect(() => () => blob.dispose(), [blob]);
  const blobGeometry = useMemo(() => {
    const g = new CircleGeometry(0.45, 20);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  useEffect(() => () => blobGeometry.dispose(), [blobGeometry]);

  const inside = useMemo(() => insideFlat(scene), [scene]);
  const obstacles = useMemo(() => walkObstacles(scene), [scene]);
  const at = useRef<[number, number]>([placement.x, placement.z]);
  useEffect(() => {
    at.current = [placement.x, placement.z];
    invalidate();
  }, [placement.x, placement.z, invalidate]);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const begin = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0 || !onMove) return;
    e.stopPropagation();
    stop.current?.();
    const raycaster = new Raycaster();
    const ndc = new Vector2();
    const floor = new Plane(new Vector3(0, 1, 0), 0);
    const hitPoint = new Vector3();
    // The point under the pointer is not the feet: keep the grab offset so the figure does not jump.
    let grab: [number, number] | null = null;
    const ground = (clientX: number, clientY: number): [number, number] | null => {
      const r = gl.domElement.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return raycaster.ray.intersectPlane(floor, hitPoint) ? [hitPoint.x, hitPoint.z] : null;
    };
    const start = ground(e.clientX, e.clientY);
    if (start) grab = [at.current[0] - start[0], at.current[1] - start[1]];
    const pause = (enabled: boolean) => {
      const controls = get().controls as { enabled: boolean } | null;
      if (controls) controls.enabled = enabled;
    };
    pause(false);
    const move = (ev: PointerEvent) => {
      const p = ground(ev.clientX, ev.clientY);
      if (!p || !grab) return;
      const target: [number, number] = [p[0] + grab[0], p[1] + grab[1]];
      const from = at.current;
      const next = resolveWalk(inside, from, [target[0] - from[0], target[1] - from[1]], obstacles, BODY_RADIUS).position;
      if (next[0] !== from[0] || next[1] !== from[1]) {
        at.current = next;
        onMove(next[0], next[1]);
        invalidate();
      }
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      pause(true);
      stop.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    stop.current = end;
  };

  return (
    <group name="person" position={[placement.x, 0, placement.z]} rotation={[0, (placement.yawDeg * Math.PI) / 180 + Math.PI, 0]} userData={{ heightM }}>
      <mesh name="person-ghost" geometry={body} material={material} scale={bodyScale} userData={{ source: glb ? 'glb' : 'parametric' }} renderOrder={3} raycast={noop} />
      <mesh name="person-hit" geometry={hit} material={hitMaterial} onPointerDown={begin} onClick={(e) => e.stopPropagation()} />
      <mesh name="person-shadow" geometry={blobGeometry} material={blob} position={[0, 0.01, 0]} renderOrder={1} raycast={noop} />
    </group>
  );
}

const noop = () => undefined;
