/**
 * TODO(lead): TEMPORARY ADAPTERS. Each export below must be replaced by the real pure function
 * from `@flat/scene` (same names; swap this file's body for `export { ... } from '@flat/scene'`
 * and adjust the call sites if the signatures differ). The web app imports ONLY from here for
 * these names, so the swap is local.
 *
 *  - loadSceneText(text)            -> {ok, scene, warnings} | {ok:false, errors}
 *  - wallStats / roomStats          -> numeric stats for the properties panel
 *  - wallObstacles / resolveMove / findSpawn -> walk-mode collision and spawn
 *  - sceneBounds3 / fitCamera       -> camera framing
 */
import { parseScene, polygonCentroid, roomArea, sceneBounds, wallLength } from '@flat/scene';
import type { Scene, Vec2 } from '@flat/scene';

export type Vec3 = [number, number, number];

/* ------------------------------------------------------------------ loading */

export interface SceneWarning {
  message: string;
  /** Entity (wall, opening, room, ...) the warning is about; clicking the warning selects it. */
  entityId?: string;
}

export type LoadResult =
  | { ok: true; scene: Scene; warnings: SceneWarning[] }
  | { ok: false; errors: string[] };

export function loadSceneText(text: string): LoadResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const parsed = parseScene(json);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return { ok: true, scene: parsed.scene, warnings: [] };
}

/* -------------------------------------------------------------------- stats */

export interface WallStats {
  length: number;
  thickness: number;
  height: number;
  /** Face area minus openings, one side, m². */
  netArea: number;
}

export function wallStats(scene: Scene, wallId: string): WallStats | undefined {
  const wall = scene.walls.find((w) => w.id === wallId);
  if (!wall) return undefined;
  const length = wallLength(wall);
  const openings = scene.openings
    .filter((o) => o.wallId === wall.id)
    .reduce((sum, o) => sum + o.width * o.height, 0);
  return { length, thickness: wall.thickness, height: wall.height, netArea: length * wall.height - openings };
}

export interface RoomStats {
  name: string;
  type: string;
  area: number;
  perimeter: number;
  floorMaterialId: string | undefined;
}

export function roomStats(scene: Scene, roomId: string): RoomStats | undefined {
  const room = scene.rooms.find((r) => r.id === roomId);
  if (!room) return undefined;
  let perimeter = 0;
  room.polygon.forEach((p, i) => {
    const q = room.polygon[(i + 1) % room.polygon.length]!;
    perimeter += Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
  return {
    name: room.name,
    type: room.type,
    area: roomArea(room),
    perimeter,
    floorMaterialId: room.floorMaterial ?? scene.defaults.floor,
  };
}

/* ------------------------------------------------------------ walk collision */

/** A wall span as a capsule: segment a-b inflated by `halfThickness`. */
export interface Obstacle {
  a: Vec2;
  b: Vec2;
  halfThickness: number;
}

/** Solid wall spans; sill-0 openings (doors, passages) are left passable, windows block. */
export function wallObstacles(scene: Scene): Obstacle[] {
  const out: Obstacle[] = [];
  for (const wall of scene.walls) {
    const length = wallLength(wall);
    const ux = (wall.end[0] - wall.start[0]) / length;
    const uy = (wall.end[1] - wall.start[1]) / length;
    const at = (d: number): Vec2 => [wall.start[0] + ux * d, wall.start[1] + uy * d];
    const gaps = scene.openings
      .filter((o) => o.wallId === wall.id && o.sill <= 0.01)
      .map((o) => [o.offset - o.width / 2, o.offset + o.width / 2] as const)
      .sort((p, q) => p[0] - q[0]);
    let cursor = 0;
    for (const [from, to] of gaps) {
      if (from > cursor + 1e-6) out.push({ a: at(cursor), b: at(from), halfThickness: wall.thickness / 2 });
      cursor = Math.max(cursor, to);
    }
    if (length > cursor + 1e-6) out.push({ a: at(cursor), b: at(length), halfThickness: wall.thickness / 2 });
  }
  return out;
}

/** Moves a circle of `radius` from `from` towards `to`, sliding along obstacles. */
export function resolveMove(obstacles: readonly Obstacle[], from: Vec2, to: Vec2, radius: number): Vec2 {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (radius * 0.5)));
  let x = from[0];
  let y = from[1];
  for (let s = 0; s < steps; s++) {
    x += dx / steps;
    y += dy / steps;
    for (let iter = 0; iter < 3; iter++) {
      for (const o of obstacles) {
        const abx = o.b[0] - o.a[0];
        const aby = o.b[1] - o.a[1];
        const len2 = abx * abx + aby * aby || 1;
        const t = Math.max(0, Math.min(1, ((x - o.a[0]) * abx + (y - o.a[1]) * aby) / len2));
        const cx = o.a[0] + abx * t;
        const cy = o.a[1] + aby * t;
        const dist = Math.hypot(x - cx, y - cy);
        const min = radius + o.halfThickness;
        if (dist < min) {
          const nx = dist > 1e-9 ? (x - cx) / dist : -aby / Math.sqrt(len2);
          const ny = dist > 1e-9 ? (y - cy) / dist : abx / Math.sqrt(len2);
          x = cx + nx * min;
          y = cy + ny * min;
        }
      }
    }
  }
  return [x, y];
}

export interface Spawn {
  position: Vec2;
  /** Degrees counter-clockwise seen from above (three.js `rotation.y`); 0 looks towards plan up. */
  yaw: number;
}

export function findSpawn(scene: Scene): Spawn {
  const room = scene.rooms.find((r) => r.type === 'hallway') ?? scene.rooms[0];
  if (room) return { position: polygonCentroid(room.polygon), yaw: 0 };
  const b = sceneBounds(scene);
  return { position: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2], yaw: 0 };
}

/* ------------------------------------------------------------------ camera */

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

export function sceneBounds3(scene: Scene): Bounds3 {
  const b = sceneBounds(scene);
  const height = Math.max(...scene.walls.map((w) => w.height));
  return { min: [b.min[0], 0, b.min[1]], max: [b.max[0], height, b.max[1]] };
}

export interface CameraFit {
  position: Vec3;
  target: Vec3;
  near: number;
  far: number;
  /** Top view only: half of the visible world height in metres. */
  halfHeight: number;
}

export function fitCamera(
  bounds: Bounds3,
  opts: { mode: 'orbit' | 'top'; aspect: number; fovDeg: number },
): CameraFit {
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const w = bounds.max[0] - bounds.min[0];
  const d = bounds.max[2] - bounds.min[2];
  const radius = Math.max(0.5, Math.hypot(w, bounds.max[1] - bounds.min[1], d) / 2);
  const target: Vec3 = [cx, opts.mode === 'top' ? 0 : cy, cz];
  if (opts.mode === 'top') {
    const halfHeight = Math.max(d / 2, w / 2 / Math.max(opts.aspect, 0.1), 0.5) * 1.1;
    return { position: [cx, radius * 2 + 10, cz], target, near: 0.1, far: radius * 4 + 50, halfHeight };
  }
  const dist = (radius / Math.tan((opts.fovDeg * Math.PI) / 360)) * 1.1;
  const dir: Vec3 = [0.5, 0.75, 0.9];
  const n = Math.hypot(...dir);
  return {
    position: [cx + (dir[0] / n) * dist, cy + (dir[1] / n) * dist, cz + (dir[2] / n) * dist],
    target,
    near: Math.max(0.05, dist / 200),
    far: dist * 6 + 50,
    halfHeight: 0,
  };
}
