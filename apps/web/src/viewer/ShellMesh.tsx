import { ownerAt } from '@flat/scene';
import type { MeshData } from '@flat/scene';
import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import type { Selection } from './view-types';
import { toBufferGeometry } from './geometry';
import type { MaterialLibrary } from './materials';

/** Pointer movement (px) above which a click is treated as a drag and ignored. */
export const CLICK_DRAG_TOLERANCE_PX = 4;

interface ShellMeshProps {
  name: string;
  data: MeshData;
  materials: MaterialLibrary;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Draw groups of these material ids with another material instead (e.g. translucent door leaves in walk mode). */
  swap?: Readonly<Record<string, string>>;
  /** Draw order among transparent objects (higher draws later). */
  renderOrder?: number;
  /** Omit to make the mesh non-interactive (e.g. in walk mode). */
  onSelect?: (selection: Selection, planPoint: [number, number]) => void;
}

/** One MeshData drawn with a material array aligned to its groups. Renders nothing when empty. */
export function ShellMesh({ name, data, materials, castShadow = false, receiveShadow = false, swap, renderOrder = 0, onSelect }: ShellMeshProps) {
  const geometry = useMemo(() => toBufferGeometry(data), [data]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const materialArray = useMemo(() => data.groups.map((g) => materials.get(swap?.[g.materialId] ?? g.materialId)), [data, materials, swap]);

  if (data.indices.length === 0) return null;

  const handleClick = onSelect
    ? (e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        if (e.delta > CLICK_DRAG_TOLERANCE_PX || e.faceIndex == null) return;
        const owner = ownerAt(data.owners, e.faceIndex);
        if (owner) onSelect({ kind: owner.kind, entityId: owner.entityId, face: owner.face, ...(owner.zoneId !== undefined ? { zoneId: owner.zoneId } : {}) }, [e.point.x, e.point.z]);
      }
    : undefined;

  return (
    <mesh
      name={name}
      geometry={geometry}
      renderOrder={renderOrder}
      material={materialArray}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
      onClick={handleClick}
    />
  );
}
