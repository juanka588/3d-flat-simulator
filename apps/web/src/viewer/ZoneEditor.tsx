import { useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, LineBasicMaterial, MeshBasicMaterial, SphereGeometry } from 'three';
import type { Scene } from '@flat/scene';
import { startZoneCornerDrag } from '../catalog/zone-drag';
import type { Selection } from './view-types';

const COLOR = '#ff9f1a';
const outlineMaterial = new LineBasicMaterial({ color: COLOR, depthTest: false, transparent: true, toneMapped: false });
const handleMaterial = new MeshBasicMaterial({ color: COLOR, depthTest: false, transparent: true, opacity: 0.95, side: DoubleSide, toneMapped: false });
/** Invisible and larger than the dot: a finger needs a target of about 40 px, a mouse hits the dot easily. */
const hitMaterial = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
const dot = new SphereGeometry(0.075, 16, 12);
const hit = new SphereGeometry(0.22, 12, 8);
const HEIGHT = 0.03;

/**
 * Corner handles of the selected floor zone, in orbit and top view. A pointer down on a handle starts the drag
 * (`catalog/zone-drag.ts`); the handles follow the zone while it is previewed.
 */
export function ZoneEditor({ scene, selection }: { scene: Scene; selection: Selection | null }) {
  const invalidate = useThree((s) => s.invalidate);
  const zone = selection?.kind === 'floor' && selection.zoneId ? scene.rooms.find((r) => r.id === selection.entityId)?.floorZones?.find((z) => z.id === selection.zoneId) : undefined;
  const roomId = selection?.entityId;
  useEffect(() => invalidate(), [zone, invalidate]);

  const outline = useMemo(() => {
    if (!zone) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(zone.polygon.flatMap((p) => [p[0], HEIGHT, p[1]]), 3));
    return g;
  }, [zone]);
  useEffect(() => () => outline?.dispose(), [outline]);

  if (!zone || !roomId || !outline) return null;
  const onDown = (corner: number) => (e: ThreeEvent<PointerEvent>) => {
    if (e.nativeEvent.button !== 0) return;
    e.stopPropagation();
    startZoneCornerDrag(roomId, zone.id, corner);
  };
  return (
    <group name="zone-editor" userData={{ roomId, zoneId: zone.id }}>
      <lineLoop name="zone-outline" geometry={outline} material={outlineMaterial} raycast={() => null} renderOrder={39} />
      {zone.polygon.map((p, i) => (
        <group key={i} name={`zone-handle-${i}`} position={[p[0], HEIGHT, p[1]]}>
          <mesh geometry={dot} material={handleMaterial} renderOrder={40} raycast={() => null} />
          <mesh name="zone-handle-hit" geometry={hit} material={hitMaterial} onPointerDown={onDown(i)} />
        </group>
      ))}
    </group>
  );
}
