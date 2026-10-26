import type { Opening, Room, Scene, Vec2 } from './schema';
import { wallLength } from './schema';
import { polygonCentroid } from './measure';
import { distanceToSegment, pointInPolygon } from './validate';

/**
 * A solid wall footprint: the rectangle swept by the segment `a -> b` with `halfThickness`
 * on each side. Its ends are flush (no rounded caps), so doorways keep their full width.
 */
export interface Obstacle {
  wallId: string;
  a: Vec2;
  b: Vec2;
  halfThickness: number;
}

/** Eye-to-floor clearance and body radius defaults for walking, in metres. */
export const DEFAULT_RADIUS = 0.25;
/** An opening can be walked through when its sill is at most this high ... */
export const PASSABLE_MAX_SILL = 0.2;
/** ... and it is at least this tall. */
export const PASSABLE_MIN_HEIGHT = 1.8;

/** Doors and passages with a low sill and enough headroom can be walked through; windows never. */
export function isPassable(opening: Pick<Opening, 'type' | 'sill' | 'height'>): boolean {
  return opening.type !== 'window' && opening.sill <= PASSABLE_MAX_SILL && opening.height >= PASSABLE_MIN_HEIGHT;
}

/** Wall footprints as obstacles, with the spans of passable openings cut out. */
export function wallObstacles(scene: Scene): Obstacle[] {
  const result: Obstacle[] = [];
  const passableByWall = new Map<string, Opening[]>();
  for (const o of scene.openings) {
    if (!isPassable(o)) continue;
    const list = passableByWall.get(o.wallId);
    if (list) list.push(o);
    else passableByWall.set(o.wallId, [o]);
  }
  for (const wall of scene.walls) {
    const length = wallLength(wall);
    if (length < 1e-9) continue;
    const dx = (wall.end[0] - wall.start[0]) / length;
    const dy = (wall.end[1] - wall.start[1]) / length;
    const at = (s: number): Vec2 => [wall.start[0] + dx * s, wall.start[1] + dy * s];
    const gaps = (passableByWall.get(wall.id) ?? [])
      .map((o): [number, number] => [Math.max(0, o.offset - o.width / 2), Math.min(length, o.offset + o.width / 2)])
      .sort((x, y) => x[0] - y[0]);
    let cursor = 0;
    const push = (from: number, to: number) => {
      if (to - from > 1e-4) {
        result.push({ wallId: wall.id, a: at(from), b: at(to), halfThickness: wall.thickness / 2 });
      }
    };
    for (const [from, to] of gaps) {
      push(cursor, from);
      cursor = Math.max(cursor, to);
    }
    push(cursor, length);
  }
  return result;
}

/** Shortest distance from `p` to the obstacle's rectangle (0 when inside). */
export function distanceToObstacle(p: Vec2, o: Obstacle): number {
  const { du, dv } = offsetFromRect(p, o);
  return Math.hypot(du, dv);
}

function frame(o: Obstacle) {
  const length = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]);
  const dx = (o.b[0] - o.a[0]) / length;
  const dy = (o.b[1] - o.a[1]) / length;
  return { length, dx, dy };
}

/** Vector (in the rectangle's local axes) from the closest rectangle point to `p`. */
function offsetFromRect(p: Vec2, o: Obstacle) {
  const { length, dx, dy } = frame(o);
  const u = (p[0] - o.a[0]) * dx + (p[1] - o.a[1]) * dy;
  const v = -(p[0] - o.a[0]) * dy + (p[1] - o.a[1]) * dx;
  const cu = Math.min(Math.max(u, 0), length);
  const cv = Math.min(Math.max(v, -o.halfThickness), o.halfThickness);
  return { u, v, du: u - cu, dv: v - cv, length, dx, dy };
}

/** Pushes the circle out of one obstacle. Returns the corrected centre, or `undefined` if it was clear. */
function pushOut(p: Vec2, o: Obstacle, radius: number): Vec2 | undefined {
  const { u, v, du, dv, length, dx, dy } = offsetFromRect(p, o);
  const dist = Math.hypot(du, dv);
  if (dist >= radius - 1e-12) return undefined;
  let mu: number;
  let mv: number;
  if (dist > 1e-9) {
    const k = (radius - dist) / dist;
    mu = du * k;
    mv = dv * k;
  } else {
    // Centre is inside the rectangle: leave through the nearest face.
    const h = o.halfThickness;
    const exits: [number, number, number][] = [
      [u + radius, -(u + radius), 0],
      [length - u + radius, length - u + radius, 0],
      [v + h + radius, 0, -(v + h + radius)],
      [h - v + radius, 0, h - v + radius],
    ];
    const best = exits.reduce((m, e) => (e[0] < m[0] ? e : m));
    mu = best[1];
    mv = best[2];
  }
  // Local (u along wall, v along its normal) back to plan: normal = (-dy, dx).
  return [p[0] + mu * dx - mv * dy, p[1] + mu * dy + mv * dx];
}

export interface MoveResult {
  position: Vec2;
  /** True when a wall pushed the circle back at any point of the move. */
  collided: boolean;
}

/**
 * Moves a circle of `radius` by `delta` against wall obstacles. The move is cut into
 * substeps of at most `radius / 2` so a fast mover cannot jump a thin wall; after each
 * substep the circle is pushed out of any wall it penetrates along the wall normal, which
 * makes it slide along walls (the tangential part of the motion is kept) and handles
 * corners by iterating. A start position inside a wall is also pushed out.
 */
export function resolveMove(
  pos: Vec2,
  delta: Vec2,
  obstacles: readonly Obstacle[],
  radius = DEFAULT_RADIUS,
): MoveResult {
  const distance = Math.hypot(delta[0], delta[1]);
  const steps = Math.min(2000, Math.max(1, Math.ceil(distance / (radius / 2))));
  let p: Vec2 = [pos[0], pos[1]];
  let collided = false;
  const stepX = delta[0] / steps;
  const stepY = delta[1] / steps;
  for (let s = 0; s < steps; s++) {
    p = [p[0] + stepX, p[1] + stepY];
    for (let iter = 0; iter < 8; iter++) {
      let moved = false;
      for (const o of obstacles) {
        const fixed = pushOut(p, o, radius);
        if (fixed) {
          p = fixed;
          moved = true;
          collided = true;
        }
      }
      if (!moved) break;
    }
  }
  return { position: p, collided };
}

export interface Spawn {
  position: Vec2;
  roomId: string;
}

const SPAWN_PREFERENCE: Room['type'][] = ['hallway', 'living'];

/**
 * Picks a standing point: first a hallway (entrance), then a living room, then any other
 * non-balcony room, then a balcony. In the chosen room it scans a 10 cm grid (coarser, at most 200 cells per axis, for large rooms) for points
 * inside the polygon at least `radius` from every wall and from the room's edges, and takes
 * the one closest to the centroid among the most spacious. `null` when nothing fits.
 */
export function findSpawn(scene: Scene, radius = DEFAULT_RADIUS): Spawn | null {
  const obstacles = wallObstacles(scene);
  const rank = (r: Room) => {
    const i = SPAWN_PREFERENCE.indexOf(r.type);
    return i >= 0 ? i : r.type === 'balcony' ? SPAWN_PREFERENCE.length + 1 : SPAWN_PREFERENCE.length;
  };
  const ordered = [...scene.rooms].sort((a, b) => rank(a) - rank(b));
  for (const room of ordered) {
    const spot = spawnInRoom(room, obstacles, radius);
    if (spot) return { position: spot, roomId: room.id };
  }
  return null;
}

/** Grid cells per axis at most, regardless of room size. */
const MAX_CELLS = 200;
/** Rooms with coordinates or extents beyond this (in scene units) are skipped. */
const MAX_SPAWN_EXTENT = 1e6;

function spawnInRoom(room: Room, obstacles: readonly Obstacle[], radius: number): Vec2 | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of room.polygon) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const extentX = maxX - minX;
  const extentY = maxY - minY;
  if (
    ![minX, maxX, minY, maxY].every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_SPAWN_EXTENT) ||
    extentX > MAX_SPAWN_EXTENT ||
    extentY > MAX_SPAWN_EXTENT
  ) {
    return null;
  }
  // 10 cm grid, coarsened for rooms drawn in other units so the cell count stays bounded.
  const step = Math.max(0.1, extentX / MAX_CELLS, extentY / MAX_CELLS);
  const nx = Math.floor(extentX / step);
  const ny = Math.floor(extentY / step);
  const candidates: { p: Vec2; clearance: number }[] = [];
  for (let i = 0; i <= nx; i++) {
    const x = minX + i * step;
    for (let j = 0; j <= ny; j++) {
      const y = minY + j * step;
      const p: Vec2 = [x, y];
      if (!pointInPolygon(p, room.polygon, 0)) continue;
      let clearance = Infinity;
      for (const o of obstacles) clearance = Math.min(clearance, distanceToObstacle(p, o));
      for (let k = 0; k < room.polygon.length; k++) {
        clearance = Math.min(clearance, distanceToSegment(p, room.polygon[k]!, room.polygon[(k + 1) % room.polygon.length]!));
      }
      if (clearance >= radius) candidates.push({ p, clearance });
    }
  }
  if (candidates.length === 0) return null;
  const target = Math.min(0.6, Math.max(...candidates.map((c) => c.clearance)));
  const centre = polygonCentroid(room.polygon);
  let best: Vec2 | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (c.clearance < target - 1e-9) continue;
    const d = Math.hypot(c.p[0] - centre[0], c.p[1] - centre[1]);
    if (d < bestDist) {
      bestDist = d;
      best = c.p;
    }
  }
  return best;
}
