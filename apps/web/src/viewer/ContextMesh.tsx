import { buildContextMeshes } from '@flat/scene';
import type { SiteContext } from '@flat/scene';
import { useEffect, useMemo } from 'react';
import { BufferAttribute, BufferGeometry, EdgesGeometry } from 'three';
import { canopyIds, contextGeometries, floorLineSegments, hostIds, storeyHeight } from './derived-geometry';
import type { BuildingMode, ViewMode } from './view-types';

const noRaycast = () => undefined;

/** Opacity of the ghosted building envelope (about 12%): the building shape shows without blocking the flat. */
export const GHOST_OPACITY = 0.12;
const FACADE_EDGE = '#4a433b';
const GHOST_EDGE = '#6f655c';
const GHOST_FILL = '#d4ccc2';

/** Edges of a geometry (creases over 25 degrees) plus extra line segments, as one line geometry. */
function edgeLines(base: BufferGeometry | null, extra: Float32Array): BufferGeometry | null {
  const edges = base ? (new EdgesGeometry(base, 25).getAttribute('position').array as Float32Array) : new Float32Array(0);
  if (edges.length + extra.length === 0) return null;
  const positions = new Float32Array(edges.length + extra.length);
  positions.set(edges, 0);
  positions.set(extra, edges.length);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  return g;
}

/**
 * Neighbouring buildings, the host building and the ground. Buildings cast shadows (only useful for the
 * sun, so `castShadow` is off at night); the ground only receives them. Nothing here is pickable.
 *
 * The host building is drawn in parts:
 *  - its lower floors (below the flat's floor) as a warm-grey façade with dark edges and a floor line
 *    every storey, so the flat reads as standing on the 2nd floor of a building;
 *  - the flat's own storey around it and the floors above, per `buildingMode` in orbit view:
 *    `hidden` = invisible, shadow only (the cut-away every camera needs); `ghost` = a translucent
 *    envelope (about 12% opacity, no depth write) that shows the building's shape without blocking
 *    the view, still shading through the invisible caster; `solid` = drawn opaque (exterior views).
 *    The top and walk views always keep it hidden.
 */
export function ContextMesh({
  context,
  castShadow,
  viewMode = 'orbit',
  buildingMode = 'hidden',
  floorElevation = 0,
}: {
  context: SiteContext;
  castShadow: boolean;
  viewMode?: ViewMode;
  buildingMode?: BuildingMode;
  floorElevation?: number;
}) {
  const geometries = useMemo(() => {
    try {
      const canopy = canopyIds(context);
      const g = contextGeometries(buildContextMeshes(context), canopy, hostIds(context));
      const storey = storeyHeight(floorElevation);
      const below = new Set([...hostIds(context)].filter((id) => !canopy.has(id)));
      return {
        ...g,
        facadeEdges: edgeLines(g.facade, floorLineSegments(context, below, storey)),
        ghostEdges: edgeLines(g.canopy, floorLineSegments(context, canopy, storey)),
      };
    } catch (error) {
      console.warn('could not build the site context', error);
      return { buildings: null, facade: null, ground: null, canopy: null, facadeEdges: null, ghostEdges: null };
    }
  }, [context, floorElevation]);
  useEffect(
    () => () => {
      for (const g of Object.values(geometries)) g?.dispose();
    },
    [geometries],
  );
  const envelope: BuildingMode = viewMode === 'orbit' ? buildingMode : 'hidden';
  return (
    <group name="context">
      {geometries.buildings && (
        <mesh name="context-buildings" geometry={geometries.buildings} castShadow={castShadow} receiveShadow raycast={noRaycast}>
          <meshStandardMaterial vertexColors roughness={0.95} />
        </mesh>
      )}
      {geometries.facade && (
        <mesh name="host-facade" geometry={geometries.facade} castShadow={castShadow} receiveShadow raycast={noRaycast}>
          <meshStandardMaterial vertexColors roughness={0.9} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
        </mesh>
      )}
      {geometries.facadeEdges && (
        <lineSegments name="host-facade-edges" geometry={geometries.facadeEdges} raycast={noRaycast}>
          <lineBasicMaterial color={FACADE_EDGE} />
        </lineSegments>
      )}
      {geometries.canopy && envelope !== 'solid' && castShadow && (
        <mesh name="context-canopy" geometry={geometries.canopy} castShadow raycast={noRaycast}>
          <meshBasicMaterial colorWrite={false} depthWrite={false} />
        </mesh>
      )}
      {geometries.canopy && envelope === 'ghost' && (
        <>
          <mesh name="host-ghost" geometry={geometries.canopy} renderOrder={3} raycast={noRaycast}>
            <meshBasicMaterial color={GHOST_FILL} transparent opacity={GHOST_OPACITY} depthWrite={false} />
          </mesh>
          {geometries.ghostEdges && (
            <lineSegments name="host-ghost-edges" geometry={geometries.ghostEdges} renderOrder={3} raycast={noRaycast}>
              <lineBasicMaterial color={GHOST_EDGE} transparent opacity={0.3} depthWrite={false} />
            </lineSegments>
          )}
        </>
      )}
      {geometries.canopy && envelope === 'solid' && (
        <mesh name="host-solid" geometry={geometries.canopy} castShadow={castShadow} receiveShadow raycast={noRaycast}>
          <meshStandardMaterial vertexColors roughness={0.9} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
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
