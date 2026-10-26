import { buildContextMeshes } from '@flat/scene';
import type { SiteContext } from '@flat/scene';
import { useEffect, useMemo } from 'react';
import { canopyIds, contextGeometries } from './derived-geometry';

const noRaycast = () => undefined;

/**
 * Neighbouring buildings and ground in neutral greys. Buildings cast shadows (only useful for the
 * sun, so `castShadow` is off at night); the ground only receives them. Not pickable.
 */
export function ContextMesh({ context, castShadow }: { context: SiteContext; castShadow: boolean }) {
  const geometries = useMemo(() => {
    try {
      return contextGeometries(buildContextMeshes(context), canopyIds(context));
    } catch (error) {
      console.warn('could not build the site context', error);
      return { buildings: null, ground: null, canopy: null };
    }
  }, [context]);
  useEffect(
    () => () => {
      geometries.buildings?.dispose();
      geometries.ground?.dispose();
      geometries.canopy?.dispose();
    },
    [geometries],
  );
  return (
    <group name="context">
      {geometries.buildings && (
        <mesh name="context-buildings" geometry={geometries.buildings} castShadow={castShadow} receiveShadow raycast={noRaycast}>
          <meshStandardMaterial vertexColors roughness={0.95} />
        </mesh>
      )}
      {geometries.canopy && castShadow && (
        <mesh name="context-canopy" geometry={geometries.canopy} castShadow raycast={noRaycast}>
          <meshBasicMaterial colorWrite={false} depthWrite={false} />
        </mesh>
      )}
      {geometries.ground && (
        <mesh name="context-ground" geometry={geometries.ground} receiveShadow raycast={noRaycast}>
          <meshStandardMaterial vertexColors roughness={1} />
        </mesh>
      )}
    </group>
  );
}
