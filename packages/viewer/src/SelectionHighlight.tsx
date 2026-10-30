import type { MeshData } from '@flat/scene';
import { useEffect, useMemo } from 'react';
import { MeshBasicMaterial } from 'three';
import { entityGeometry } from './geometry';

const tint = new MeshBasicMaterial({
  color: '#ff9f1a',
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});

/** Plan-check highlight: the walls or rooms a finding is about, in red. */
const flag = new MeshBasicMaterial({
  color: '#ff1f2d',
  transparent: true,
  opacity: 0.6,
  toneMapped: false,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});

/** Cheap selection tint: re-draws the selected entity's triangles with an orange translucent material (`flagged`: red, for plan-check findings). */
export function SelectionHighlight({ mesh, entityId, zoneId, flagged }: { mesh: MeshData; entityId: string; zoneId?: string; flagged?: boolean }) {
  const geometry = useMemo(() => entityGeometry(mesh, entityId, zoneId), [mesh, entityId, zoneId]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return <mesh name={flagged ? 'plan-highlight' : 'selection-highlight'} geometry={geometry} material={flagged ? flag : tint} raycast={() => null} renderOrder={10} />;
}
