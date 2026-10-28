import { useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { BoxGeometry, ConeGeometry, DoubleSide, EdgesGeometry, MeshBasicMaterial, Raycaster, RingGeometry, Vector2 } from 'three';
import { itemDims, itemMountOf } from '@flat/scene';
import type { Item, Scene } from '@flat/scene';
import { useCatalogStore } from '../catalog/catalogStore';
import { ghostColor } from '../catalog/ghost';
import { floorPoint, lineHeight, registerViewer, startDrag } from '../catalog/placement';
import type { WorldRay } from '../catalog/placement';
import { normalizeDeg, rotationFacingDir } from '../catalog/snap';

const unitBox = new BoxGeometry(1, 1, 1);
unitBox.translate(0, 0.5, 0);
const unitEdges = new EdgesGeometry(unitBox);
const marker = new ConeGeometry(0.07, 0.16, 3);
marker.rotateX(Math.PI / 2); // tip along +z (the item's front)

/** Basic materials skip tone mapping: the scene's exposure is physical (very low) and would turn them black. */
const colourMaterials = new Map<string, { fill: MeshBasicMaterial; line: MeshBasicMaterial }>();
function materialsFor(color: string) {
  let m = colourMaterials.get(color);
  if (!m) {
    m = {
      fill: new MeshBasicMaterial({ color, transparent: true, opacity: 0.42, depthWrite: false, side: DoubleSide, toneMapped: false }),
      line: new MeshBasicMaterial({ color, depthTest: false, transparent: true, toneMapped: false }),
    };
    colourMaterials.set(color, m);
  }
  return m;
}

const GIZMO_COLOR = '#ff9f1a';
const gizmoMaterial = new MeshBasicMaterial({ color: GIZMO_COLOR, transparent: true, opacity: 0.85, depthTest: false, side: DoubleSide, toneMapped: false });
const hitMaterial = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
const handleGeometry = new ConeGeometry(0.06, 0.14, 12);

/**
 * Everything that lives in the 3D view for placing things (M5.13): the ghost shown while dragging a card or an
 * item, and the gizmo of the selected item (a move area, a rotate ring and, for wall mounts, an elevation handle).
 * It also tells the placement controller how to unproject the pointer and how to pause the camera controls.
 */
export function PlacementLayer({ scene, selectedId }: { scene: Scene; selectedId?: string }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const controls = useThree((s) => s.controls);
  const invalidate = useThree((s) => s.invalidate);
  const ghost = useCatalogStore((s) => s.ghost);
  const dragging = useCatalogStore((s) => s.drag);

  useEffect(() => {
    const raycaster = new Raycaster();
    const ndc = new Vector2();
    registerViewer({
      ray: (x, y): WorldRay | null => {
        const r = gl.domElement.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        return { origin: raycaster.ray.origin.toArray() as [number, number, number], dir: raycaster.ray.direction.toArray() as [number, number, number] };
      },
      setControlsEnabled: (enabled) => {
        if (controls) (controls as unknown as { enabled: boolean }).enabled = enabled;
      },
    });
    return () => registerViewer(null);
  }, [camera, gl, controls]);

  useEffect(() => invalidate(), [ghost, dragging, selectedId, scene, invalidate]);

  const item = selectedId ? scene.items.find((i) => i.id === selectedId) : undefined;
  
  return (
    <group name="placement">
      {ghost && <Ghost ghost={ghost} />}
      {item && !item.locked && <Gizmo item={item} />}
    </group>
  );
}

function Ghost({ ghost }: { ghost: NonNullable<ReturnType<typeof useCatalogStore.getState>['ghost']> }) {
  const m = materialsFor(ghostColor(ghost.verdict));
  const { w, d, h } = ghost.dims;
  const lift = Math.max(h, 0.02);
  return (
    <group name="placement-ghost" position={[ghost.position[0], ghost.elevation, ghost.position[1]]} rotation={[0, (ghost.rotation * Math.PI) / 180, 0]} userData={{ valid: ghost.verdict.valid }}>
      <mesh geometry={unitBox} material={m.fill} scale={[w, lift, d]} raycast={() => null} renderOrder={20} />
      <lineSegments geometry={unitEdges} material={m.line} scale={[w, lift, d]} raycast={() => null} renderOrder={21} />
      <mesh geometry={marker} material={m.line} position={[0, 0.03, d / 2 + 0.12]} raycast={() => null} renderOrder={21} />
    </group>
  );
}

const ringCache = new Map<string, RingGeometry>();
function ringGeometry(radius: number): RingGeometry {
  const key = radius.toFixed(2);
  let g = ringCache.get(key);
  if (!g) {
    g = new RingGeometry(radius - 0.045, radius + 0.045, 48);
    g.rotateX(-Math.PI / 2);
    ringCache.set(key, g);
  }
  return g;
}

function Gizmo({ item }: { item: Item }) {
  const dims = itemDims(item);
  const mount = itemMountOf(item);
  const radius = Math.hypot(dims.w, dims.d) / 2 + 0.14;
  const ring = useMemo(() => ringGeometry(radius), [radius]);
  const toWorld = (e: ThreeEvent<PointerEvent>): { floor: [number, number] | null; ray: WorldRay } => {
    const o = e.ray.origin;
    const d = e.ray.direction;
    const ray: WorldRay = { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] };
    return { floor: floorPoint(ray), ray };
  };
  const at = (e: ThreeEvent<PointerEvent>) => ({ clientX: e.nativeEvent.clientX, clientY: e.nativeEvent.clientY, shiftKey: e.nativeEvent.shiftKey, altKey: e.nativeEvent.altKey });
  const touch = (e: ThreeEvent<PointerEvent>) => e.nativeEvent.pointerType === 'touch';

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (e.nativeEvent.button !== 0) return;
    const { floor } = toWorld(e);
    if (!floor) return;
    e.stopPropagation();
    startDrag({ kind: 'move', itemId: item.id, grab: [floor[0] - item.position[0], floor[1] - item.position[1]], touch: touch(e) }, at(e));
  };
  const onRotate = (e: ThreeEvent<PointerEvent>) => {
    if (e.nativeEvent.button !== 0) return;
    const { floor } = toWorld(e);
    if (!floor) return;
    e.stopPropagation();
    const facing = rotationFacingDir([floor[0] - item.position[0], floor[1] - item.position[1]]);
    startDrag({ kind: 'rotate', itemId: item.id, offset: normalizeDeg(item.rotation - facing), touch: touch(e) }, at(e));
  };
  const onElevate = (e: ThreeEvent<PointerEvent>) => {
    if (e.nativeEvent.button !== 0) return;
    const { ray } = toWorld(e);
    const y = lineHeight(ray, item.position[0], item.position[1]);
    if (y === null) return;
    e.stopPropagation();
    startDrag({ kind: 'elevate', itemId: item.id, grab: y - item.elevation, touch: touch(e) }, at(e));
  };

  return (
    <group name="item-gizmo" position={[item.position[0], item.elevation, item.position[1]]} rotation={[0, (item.rotation * Math.PI) / 180, 0]} userData={{ itemId: item.id }}>
      {/* the move area: the item's own box, invisible, under the pointer wherever the item is */}
      <mesh name="gizmo-move" geometry={unitBox} material={hitMaterial} scale={[dims.w, dims.h, dims.d]} onPointerDown={onMove} />
      <mesh name="gizmo-rotate" geometry={ring} material={gizmoMaterial} position={[0, -item.elevation + 0.02, 0]} renderOrder={30} onPointerDown={onRotate} />
      {mount !== 'floor' && (
        <mesh name="gizmo-elevate" geometry={handleGeometry} material={gizmoMaterial} position={[0, dims.h + 0.12, 0]} renderOrder={30} onPointerDown={onElevate} />
      )}
    </group>
  );
}
