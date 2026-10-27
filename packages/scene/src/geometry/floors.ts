import earcut from 'earcut';
import type { Room, Scene, Vec2, Wall } from '../schema';
import { MeshBuilder } from './builder';
import { ceilingMaterial, floorMaterial } from './materials';
import type { MeshData } from './types';
import { floorParts } from './zones';

/** Ceiling height used when a room has no `ceilingHeight` and no bounding wall is found. */
export const DEFAULT_CEILING_HEIGHT = 2.5;

/**
 * Triangulates a simple polygon (convex or concave, either winding) with earcut.
 * Returns vertex indices into `polygon`, three per triangle. Empty for degenerate input.
 */
export function triangulatePolygon(polygon: readonly Vec2[]): number[] {
  if (polygon.length < 3) return [];
  const flat = polygon.flatMap((p) => [p[0], p[1]]);
  return earcut(flat);
}

export interface EdgeCoverage {
  /** Walls whose centreline runs along the edge (parallel, within thickness/2 + 1 cm) and overlap it. */
  walls: Wall[];
  /** Length of the edge, in metres, that no wall covers. */
  uncovered: number;
}

/** Walls closer than half their thickness plus this slack count as running along an edge. */
const EDGE_SLACK = 0.01;
/** sin of the largest angle between an edge and a wall still considered parallel (about 2 degrees). */
const PARALLEL_SIN = 0.035;

/**
 * Finds which walls back the room edge `a -> b`. A wall backs an edge when it is (nearly)
 * parallel, both edge ends lie within `thickness / 2 + 1 cm` of its centreline, and the
 * wall (extended by half its thickness at both ends, to cover corners) overlaps the edge
 * by more than 5 cm. The uncovered length is the part of the edge no wall reaches.
 */
export function edgeCoverage(walls: readonly Wall[], a: Vec2, b: Vec2): EdgeCoverage {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 1e-9) return { walls: [], uncovered: 0 };
  const ux = (b[0] - a[0]) / length;
  const uy = (b[1] - a[1]) / length;
  const intervals: [number, number][] = [];
  const backing: Wall[] = [];
  for (const wall of walls) {
    const wl = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
    if (wl < 1e-9) continue;
    const wx = (wall.end[0] - wall.start[0]) / wl;
    const wy = (wall.end[1] - wall.start[1]) / wl;
    if (Math.abs(ux * wy - uy * wx) > PARALLEL_SIN) continue;
    const dist = (p: Vec2) => Math.abs((p[0] - wall.start[0]) * wy - (p[1] - wall.start[1]) * wx);
    const limit = wall.thickness / 2 + EDGE_SLACK;
    if (dist(a) > limit || dist(b) > limit) continue;
    const s0 = (wall.start[0] - a[0]) * ux + (wall.start[1] - a[1]) * uy;
    const s1 = (wall.end[0] - a[0]) * ux + (wall.end[1] - a[1]) * uy;
    const lo = Math.max(0, Math.min(s0, s1) - wall.thickness / 2);
    const hi = Math.min(length, Math.max(s0, s1) + wall.thickness / 2);
    if (hi - lo <= 0.05) continue;
    intervals.push([lo, hi]);
    backing.push(wall);
  }
  intervals.sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let cursor = 0;
  for (const [lo, hi] of intervals) {
    const from = Math.max(lo, cursor);
    if (hi > from) covered += hi - from;
    cursor = Math.max(cursor, hi);
  }
  return { walls: backing, uncovered: Math.max(0, length - covered) };
}

/** Distinct walls backing any edge of the room polygon. */
export function roomBoundaryWalls(scene: Pick<Scene, 'walls'>, room: Pick<Room, 'polygon'>): Wall[] {
  const found = new Set<Wall>();
  const n = room.polygon.length;
  for (let i = 0; i < n; i++) {
    for (const wall of edgeCoverage(scene.walls, room.polygon[i]!, room.polygon[(i + 1) % n]!).walls) {
      found.add(wall);
    }
  }
  return [...found];
}

/**
 * Floor-to-ceiling height of a room: its `ceilingHeight`, else the lowest wall running along
 * its edges, else 2.5 m.
 */
export function roomCeilingHeight(scene: Pick<Scene, 'walls'>, room: Room): number {
  if (room.ceilingHeight !== undefined) return room.ceilingHeight;
  const walls = roomBoundaryWalls(scene, room);
  return walls.length > 0 ? Math.min(...walls.map((w) => w.height)) : DEFAULT_CEILING_HEIGHT;
}

function addRoomSurface(
  builder: MeshBuilder,
  room: Room,
  y: number,
  up: boolean,
  materialId: string,
  kind: 'floor' | 'ceiling',
): void {
  const tris = triangulatePolygon(room.polygon);
  if (tris.length === 0) return;
  const normal: [number, number, number] = [0, up ? 1 : -1, 0];
  const base = room.polygon.map((p) => builder.vertex([p[0], y, p[1]], normal, [p[0], p[1]]));
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i]!;
    let b = tris[i + 1]!;
    let c = tris[i + 2]!;
    const pa = room.polygon[a]!;
    const pb = room.polygon[b]!;
    const pc = room.polygon[c]!;
    // y component of (b - a) x (c - a) in world space (plan y is world z).
    const ny = (pb[1] - pa[1]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[1] - pa[1]);
    if (ny === 0) continue;
    if (up !== ny > 0) [b, c] = [c, b];
    builder.triangle(base[a]!, base[b]!, base[c]!, materialId, { kind, entityId: room.id });
  }
}

/** One convex piece of a floor part (fan-triangulated, facing up), UVs = plan coordinates in metres. */
function addFloorPiece(builder: MeshBuilder, piece: readonly Vec2[], roomId: string, zoneId: string | undefined, materialId: string): void {
  const base = piece.map((p) => builder.vertex([p[0], 0, p[1]], [0, 1, 0], [p[0], p[1]]));
  for (let k = 1; k + 1 < piece.length; k++) {
    const pa = piece[0]!;
    const pb = piece[k]!;
    const pc = piece[k + 1]!;
    const ny = (pb[1] - pa[1]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[1] - pa[1]);
    if (ny === 0) continue;
    const [b, c] = ny > 0 ? [base[k]!, base[k + 1]!] : [base[k + 1]!, base[k]!];
    builder.triangle(base[0]!, b, c, materialId, { kind: 'floor', entityId: roomId, ...(zoneId !== undefined ? { zoneId } : {}) });
  }
}

/**
 * Floor per room, facing up (+Y) at y = 0. UVs are plan coordinates in metres. A room with floor zones is
 * split into one part per zone plus the remainder, each with its own material; every triangle is owned by
 * the room (`entityId`), and zone triangles also carry `zoneId`.
 */
export function buildFloors(scene: Scene): MeshData {
  const builder = new MeshBuilder();
  for (const room of scene.rooms) {
    if (!room.floorZones?.length) {
      addRoomSurface(builder, room, 0, true, floorMaterial(scene, room), 'floor');
      continue;
    }
    for (const part of floorParts(scene, room)) {
      for (const piece of part.pieces) addFloorPiece(builder, piece, room.id, part.zoneId, part.materialId);
    }
  }
  return builder.build();
}

/** Ceiling per room, facing down (-Y) at the room's ceiling height. Balconies get none. */
export function buildCeilings(scene: Scene): MeshData {
  const builder = new MeshBuilder();
  for (const room of scene.rooms) {
    if (room.type === 'balcony') continue;
    addRoomSurface(builder, room, roomCeilingHeight(scene, room), false, ceilingMaterial(scene, room), 'ceiling');
  }
  return builder.build();
}
