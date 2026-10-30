/**
 * Renderer-agnostic mesh contract. `packages/scene` builds these from a Scene; the web app
 * (or a headless renderer) turns them into GPU buffers. World axes: X = plan x, Z = plan y,
 * Y = up, metres. Triangles are counter-clockwise when seen from the side their normal faces.
 */

/** What a range of triangles belongs to, so picks can be mapped back to scene entities. */
export type OwnerKind = 'wall' | 'opening' | 'floor' | 'ceiling' | 'context' | 'item';

/** Which face of a wall a triangle range belongs to. `left`/`right` follow `wallLeftNormal`. */
export type WallFace = 'left' | 'right' | 'top' | 'end' | 'jamb';

export interface Owner {
  /** First triangle index (not vertex index) in the mesh. */
  start: number;
  /** Number of triangles. */
  count: number;
  kind: OwnerKind;
  /** Scene entity id: wall id, opening id, or room id for floors/ceilings, item id for items. */
  entityId: string;
  face?: WallFace;
  /** Floors only: the id of the floor zone (`Room.floorZones`) the triangles belong to; absent for the rest of the room floor. */
  zoneId?: string;
}

/** A contiguous index range rendered with one material. */
export interface MaterialGroup {
  /** First index (into `indices`), a multiple of 3. */
  start: number;
  /** Number of indices, a multiple of 3. */
  count: number;
  /** Scene material id, or a built-in id such as `builtin:glass`, `builtin:frame`, `builtin:door`. */
  materialId: string;
}

export interface MeshData {
  /** xyz per vertex. */
  positions: Float32Array;
  /** xyz unit normal per vertex. */
  normals: Float32Array;
  /** uv per vertex, in metres (u along the surface, v up or along plan y), so textures tile at real scale. */
  uvs: Float32Array;
  indices: Uint32Array;
  /** Sorted by `start`, non-overlapping, covering every index. */
  groups: MaterialGroup[];
  /** Sorted by `start`, non-overlapping, covering every triangle. */
  owners: Owner[];
}

/** Everything needed to draw the static shell of a flat. */
export interface ShellMeshes {
  /** Walls (all faces, jambs, sills, heads). */
  walls: MeshData;
  floors: MeshData;
  /** Hidden in orbit/top views. */
  ceilings: MeshData;
  /** Door leaves and window/door frames (opaque). */
  fittings: MeshData;
  /** Window/door glass panes (transparent, must not cast shadows). */
  glass: MeshData;
  /** Furniture and equipment (built-in assets, placeholders for unknown ones). */
  items: MeshData;
}

export const BUILTIN_MATERIALS = {
  glass: 'builtin:glass',
  frame: 'builtin:frame',
  door: 'builtin:door',
  /** White lacquered interior door leaf (`Opening.finish = 'white'`). */
  doorWhite: 'builtin:door-white',
  /** White painted door frame, architrave and white PVC window profiles. */
  frameWhite: 'builtin:frame-white',
  /** Brushed-steel door furniture (lever handle, rose, key rose). */
  handle: 'builtin:handle',
  /** White window handle. */
  handleWhite: 'builtin:handle-white',
  /** Used when neither the element nor `scene.defaults` names a material. */
  fallbackWall: 'builtin:wall',
  fallbackFloor: 'builtin:floor',
  fallbackCeiling: 'builtin:ceiling',
} as const;
