import type { Room, Scene, Vec2 } from './schema';

/** Signed polygon area (shoelace formula): positive when vertices run counter-clockwise in math axes. */
function signedArea(polygon: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]!;
    const [x2, y2] = polygon[(i + 1) % polygon.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Absolute polygon area in m². */
export function polygonArea(polygon: readonly Vec2[]): number {
  return Math.abs(signedArea(polygon));
}

/** Gross room area in m², measured on wall centrelines. */
export function roomArea(room: Pick<Room, 'polygon'>): number {
  return polygonArea(room.polygon);
}

/** Area-weighted centroid; lies inside convex rooms and is the natural label anchor. */
export function polygonCentroid(polygon: readonly Vec2[]): Vec2 {
  const a = signedArea(polygon);
  if (Math.abs(a) < 1e-12) {
    const n = polygon.length;
    return [polygon.reduce((s, p) => s + p[0], 0) / n, polygon.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]!;
    const [x2, y2] = polygon[(i + 1) % polygon.length]!;
    const cross = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** True when no two non-adjacent edges intersect (and no adjacent edges fold back). */
export function isSimplePolygon(polygon: readonly Vec2[]): boolean {
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) continue;
      if (segmentsIntersect(polygon[i]!, polygon[(i + 1) % n]!, polygon[j]!, polygon[(j + 1) % n]!)) {
        return false;
      }
    }
  }
  return true;
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const orient = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const onSegment = (p: Vec2, q: Vec2, r: Vec2) =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (
    (d1 === 0 && onSegment(c, d, a)) ||
    (d2 === 0 && onSegment(c, d, b)) ||
    (d3 === 0 && onSegment(a, b, c)) ||
    (d4 === 0 && onSegment(a, b, d))
  );
}

export interface Bounds {
  min: Vec2;
  max: Vec2;
}

/** Plan-space bounding box of all walls (a zero box at the origin when there are none). */
export function sceneBounds(scene: Pick<Scene, 'walls'>): Bounds {
  if (scene.walls.length === 0) return { min: [0, 0], max: [0, 0] };
  const xs = scene.walls.flatMap((w) => [w.start[0], w.end[0]]);
  const ys = scene.walls.flatMap((w) => [w.start[1], w.end[1]]);
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

export interface SceneSummary {
  name: string;
  /** Sum of gross (wall-centreline) room areas, in m². */
  totalArea: number;
  rooms: { id: string; name: string; type: Room['type']; area: number }[];
  wallCount: number;
  doorCount: number;
  windowCount: number;
  lightCount: number;
  itemCount: number;
}

/** Compact overview of a flat, also intended as the basis of the MCP `get_scene_summary` tool. */
export function summarizeScene(scene: Scene): SceneSummary {
  const rooms = scene.rooms.map((r) => ({ id: r.id, name: r.name, type: r.type, area: roomArea(r) }));
  return {
    name: scene.name,
    totalArea: rooms.reduce((sum, r) => sum + r.area, 0),
    rooms,
    wallCount: scene.walls.length,
    doorCount: scene.openings.filter((o) => o.type === 'door').length,
    windowCount: scene.openings.filter((o) => o.type === 'window').length,
    lightCount: scene.lights.length,
    itemCount: scene.items.length,
  };
}
