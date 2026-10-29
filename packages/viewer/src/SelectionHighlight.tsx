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

/** Cheap selection tint: re-draws the selected entity's triangles with an orange translucent material. */
export function SelectionHighlight({ mesh, entityId, zoneId }: { mesh: MeshData; entityId: string; zoneId?: string }) {
  const geometry = useMemo(() => entityGeometry(mesh, entityId, zoneId), [mesh, entityId, zoneId]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return <mesh name="selection-highlight" geometry={geometry} material={tint} raycast={() => null} renderOrder={10} />;
}
