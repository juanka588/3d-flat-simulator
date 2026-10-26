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
  /** Omit to make the mesh non-interactive (e.g. in walk mode). */
  onSelect?: (selection: Selection) => void;
}

/** One MeshData drawn with a material array aligned to its groups. Renders nothing when empty. */
export function ShellMesh({ name, data, materials, castShadow = false, receiveShadow = false, onSelect }: ShellMeshProps) {
  const geometry = useMemo(() => toBufferGeometry(data), [data]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const materialArray = useMemo(() => data.groups.map((g) => materials.get(g.materialId)), [data, materials]);

  if (data.indices.length === 0) return null;

  const handleClick = onSelect
    ? (e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        if (e.delta > CLICK_DRAG_TOLERANCE_PX || e.faceIndex == null) return;
        const owner = ownerAt(data.owners, e.faceIndex);
        if (owner) onSelect({ kind: owner.kind, entityId: owner.entityId, face: owner.face });
      }
    : undefined;

  return (
    <mesh
      name={name}
      geometry={geometry}
      material={materialArray}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
      onClick={handleClick}
    />
  );
}
