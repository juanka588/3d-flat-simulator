import { footprintOf, pointInPolygon } from '@flat/scene';
import type { Vec2 } from '@flat/scene';

/**
 * Pure snapping for drag-to-place (M5.13). Plan coordinates in metres, rotations in degrees
 * (counter-clockwise seen from above, the item front faces plan +y at 0; see `placement/footprint.ts`).
 */

/** Position grid (centre of the item). */
export const GRID_M = 0.05;
/** Rotation step. */
export const ROTATION_STEP_DEG = 15;
/** The back of an item within this distance of a wall is pulled flush against it. */
export const WALL_SNAP_M = 0.1;
/** After a wall snap, a side within this distance of the adjacent wall is pulled against it too (corner). */
export const CORNER_SNAP_M = 0.1;
/** A wall only attracts items whose front points away from it within this angle. */
const WALL_FACING_TOLERANCE_DEG = 45;

const DEG = Math.PI / 180;
const r4 = (n: number): number => {
  const v = Math.round(n * 1e4) / 1e4;
  return Object.is(v, -0) ? 0 : v;
};

export const normalizeDeg = (deg: number): number => r4(((deg % 360) + 360) % 360);

/** Nearest multiple of `step` (default 5 cm). */
export const snapValue = (v: number, step: number = GRID_M): number => r4(Math.round(v / step) * step);

/** Nearest multiple of `step` degrees, in [0, 360). */
export const snapAngle = (deg: number, step: number = ROTATION_STEP_DEG): number => normalizeDeg(Math.round(deg / step) * step);

export interface SnapOptions {
  /** 5 cm grid on the item centre (Alt turns it off). */
  grid: boolean;
  /** 15 degree steps (Shift turns it off, rotation is then free). */
  angle: boolean;
  /** Back-to-wall and corner snaps. */
  wall: boolean;
}

export const DEFAULT_SNAP: SnapOptions = { grid: true, angle: true, wall: true };

export interface SnapRoom {
  id: string;
  polygon: readonly Vec2[];
}

export interface SnapInput {
  /** Where the pointer is on the floor (the wanted item centre). */
  point: Vec2;
  /** Wanted rotation. */
  rotation: number;
  dims: { w: number; d: number };
  rooms: readonly SnapRoom[];
  /** Wall snaps only apply to floor and wall mounted items. */
  mount?: 'floor' | 'wall' | 'ceiling';
}

export type SnapKind = 'grid' | 'angle' | 'wall' | 'corner';

export interface SnapResult {
  position: Vec2;
  rotation: number;
  /** Room whose polygon contains the raw pointer point, when any. */
  roomId?: string;
  snaps: SnapKind[];
}

interface Edge {
  a: Vec2;
  b: Vec2;
  dir: Vec2;
  len: number;
  /** Unit normal pointing into the room. */
  inward: Vec2;
}

/** The edges of a room polygon with their inward normals. */
export function roomEdges(polygon: readonly Vec2[]): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const dir: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let inward: Vec2 = [-dir[1], dir[0]];
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!pointInPolygon([mid[0] + inward[0] * 0.05, mid[1] + inward[1] * 0.05], polygon as Vec2[], 0)) inward = [-inward[0], -inward[1]];
    out.push({ a, b, dir, len, inward });
  }
  return out;
}

const dot = (u: Vec2, v: Vec2): number => u[0] * v[0] + u[1] * v[1];
const sub = (u: Vec2, v: Vec2): Vec2 => [u[0] - v[0], u[1] - v[1]];

/** Smallest distance from any footprint corner to the edge line, along the inward normal (negative = poking into the wall). */
function gapToEdge(footprint: readonly Vec2[], e: Edge): number {
  let gap = Infinity;
  for (const c of footprint) gap = Math.min(gap, dot(sub(c, e.a), e.inward));
  return gap;
}

/** Rotation whose front faces the plan direction `dir`. */
export function rotationFacingDir(dir: Vec2): number {
  return normalizeDeg(Math.atan2(dir[0], dir[1]) / DEG);
}

/** Smallest absolute difference between two angles, degrees. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return d;
}

/**
 * Snaps a wanted pose: rotation to 15 degree steps, centre to the 5 cm grid, then the back of the item flush
 * against a wall within `WALL_SNAP_M` (the item turns to face into the room) and, once against a wall, a side
 * flush against an adjacent wall within `CORNER_SNAP_M` (corner). Pure and deterministic.
 */
export function snapPose(input: SnapInput, options: Partial<SnapOptions> = {}): SnapResult {
  const opt = { ...DEFAULT_SNAP, ...options };
  const snaps: SnapKind[] = [];
  let rotation = opt.angle ? snapAngle(input.rotation) : normalizeDeg(input.rotation);
  if (opt.angle) snaps.push('angle');
  let position: Vec2 = opt.grid ? [snapValue(input.point[0]), snapValue(input.point[1])] : [r4(input.point[0]), r4(input.point[1])];
  if (opt.grid) snaps.push('grid');
  const room = input.rooms.find((r) => pointInPolygon(input.point, r.polygon as Vec2[], 0.003));

  if (opt.wall && room && input.mount !== 'ceiling') {
    const edges = roomEdges(room.polygon);
    let best: { edge: Edge; gap: number; rotation: number } | undefined;
    for (const edge of edges) {
      const facing = rotationFacingDir(edge.inward);
      // with angle snapping the item turns its back to any wall it is close to; with free rotation only a wall behind it counts
      if (!opt.angle && angleDiff(rotation, facing) > WALL_FACING_TOLERANCE_DEG) continue;
      // the centre must lie along the wall stretch
      const along = dot(sub(position, edge.a), edge.dir);
      if (along < 0 || along > edge.len) continue;
      const rot = opt.angle ? facing : rotation;
      const gap = gapToEdge(footprintOf(position, rot, input.dims), edge);
      if (Math.abs(gap) <= WALL_SNAP_M && (!best || Math.abs(gap) < Math.abs(best.gap))) best = { edge, gap, rotation: rot };
    }
    if (best) {
      rotation = best.rotation;
      position = [r4(position[0] - best.edge.inward[0] * best.gap), r4(position[1] - best.edge.inward[1] * best.gap)];
      snaps.push('wall');
      // corner: a side of the (now aligned) item against the adjacent wall
      const sides: Vec2[] = [
        [Math.cos(rotation * DEG), -Math.sin(rotation * DEG)],
        [-Math.cos(rotation * DEG), Math.sin(rotation * DEG)],
      ];
      let corner: { edge: Edge; gap: number } | undefined;
      for (const edge of edges) {
        if (edge === best.edge) continue;
        // the adjacent wall faces the item's side: its inward normal opposes the side direction
        if (!sides.some((s) => dot(edge.inward, s) < -0.95)) continue;
        const gap = gapToEdge(footprintOf(position, rotation, input.dims), edge);
        if (Math.abs(gap) <= CORNER_SNAP_M && (!corner || Math.abs(gap) < Math.abs(corner.gap))) corner = { edge, gap };
      }
      if (corner) {
        position = [r4(position[0] - corner.edge.inward[0] * corner.gap), r4(position[1] - corner.edge.inward[1] * corner.gap)];
        snaps.push('corner');
      }
    }
  }
  return { position, rotation, ...(room ? { roomId: room.id } : {}), snaps };
}
