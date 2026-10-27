import { paintMaterial, pointInPolygon, polygonCentroid, zoneProblems } from '@flat/scene';
import type { Command, FloorZone, Room, Scene, Vec2 } from '@flat/scene';
import { snapValue } from './snap';

/**
 * Floor-zone editing, pure (no store, no three): the rectangle "Add zone" creates, the corner drag with grid
 * snapping, and the clamp that keeps a zone inside its room and off the other zones of that room.
 */

/** Side of the rectangle "Add zone" creates, metres. */
export const NEW_ZONE_SIZE_M = 1;
/** A zone rectangle may not be dragged thinner than this, metres. */
export const MIN_ZONE_SIDE_M = 0.1;
/** Grid of the corner handles, metres (same 5 cm grid as the item placement). */
export const ZONE_GRID_M = 0.05;

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

export interface AxisRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The rectangle of an axis-aligned 4-corner polygon, or null for any other shape. */
export function axisRect(polygon: readonly Vec2[]): AxisRect | null {
  if (polygon.length !== 4) return null;
  const xs = [...new Set(polygon.map((p) => Math.round(p[0] * 1e6)))];
  const ys = [...new Set(polygon.map((p) => Math.round(p[1] * 1e6)))];
  if (xs.length !== 2 || ys.length !== 2) return null;
  for (let i = 0; i < 4; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % 4]!;
    if (!(near(a[0], b[0]) || near(a[1], b[1]))) return null; // consecutive corners share an x or a y
  }
  return { x0: Math.min(...xs) / 1e6, x1: Math.max(...xs) / 1e6, y0: Math.min(...ys) / 1e6, y1: Math.max(...ys) / 1e6 };
}

/** Corners in the order the rectangle is stored: top-left, top-right, bottom-right, bottom-left (plan y down). */
export const rectPolygon = (r: AxisRect): Vec2[] => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** A zone id not used in the room: `zone-1`, `zone-2`, ... */
export function nextZoneId(room: Pick<Room, 'floorZones'>): string {
  const used = new Set((room.floorZones ?? []).map((z) => z.id));
  let n = (room.floorZones?.length ?? 0) + 1;
  while (used.has(`zone-${n}`)) n++;
  return `zone-${n}`;
}

const fits = (room: Room, polygon: Vec2[]) => zoneProblems(room.polygon, [...(room.floorZones ?? []), { id: '\u0000new', polygon }]).length === 0;

/**
 * A `size` x `size` rectangle for a new zone: centred on the room's centroid when that fits, else on the free spot
 * closest to it (L-shaped rooms have centroids outside the room). Smaller squares are tried when the room is tight.
 * Null when no spot fits at all.
 */
export function newZoneRect(room: Room, size: number = NEW_ZONE_SIZE_M): Vec2[] | null {
  const centre = polygonCentroid(room.polygon);
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);
  for (const side of [size, size / 2, size / 4]) {
    const half = side / 2;
    const make = (cx: number, cy: number): Vec2[] => rectPolygon({ x0: r4(cx - half), y0: r4(cy - half), x1: r4(cx + half), y1: r4(cy + half) });
    const first = [snapValue(centre[0]), snapValue(centre[1])] as Vec2;
    if (pointInPolygon(first, room.polygon as Vec2[], 0) && fits(room, make(first[0], first[1]))) return make(first[0], first[1]);
    const candidates: Vec2[] = [];
    for (let x = Math.min(...xs) + half; x <= Math.max(...xs) - half + 1e-9; x += ZONE_GRID_M * 2) {
      for (let y = Math.min(...ys) + half; y <= Math.max(...ys) - half + 1e-9; y += ZONE_GRID_M * 2) candidates.push([snapValue(x), snapValue(y)]);
    }
    candidates.sort((a, b) => Math.hypot(a[0] - centre[0], a[1] - centre[1]) - Math.hypot(b[0] - centre[0], b[1] - centre[1]));
    for (const c of candidates) {
      const poly = make(c[0], c[1]);
      if (fits(room, poly)) return poly;
    }
  }
  return null;
}

/**
 * The material "Add zone" gives a new zone: another floor material of the flat that differs from the room's own
 * (so the zone is visible), else a neutral grey paint that the command defines first.
 */
export function newZoneMaterial(scene: Scene, room: Room): { id: string; define?: Command } {
  const floor = room.floorMaterial ?? scene.defaults.floor;
  const others = [...scene.rooms.flatMap((r) => [r.floorMaterial, ...(r.floorZones ?? []).map((z) => z.material)]), scene.defaults.floor].filter((m): m is string => !!m && m !== floor);
  if (others[0]) return { id: others[0] };
  const paint = paintMaterial('#9fa3a8', 'matt');
  return { id: paint.id, define: { type: 'material.define', material: paint } };
}

/** The polygon after dragging corner `corner` to `target`: a rectangle stays a rectangle (the opposite corner is fixed), any other shape moves just that vertex. */
export function dragCorner(polygon: readonly Vec2[], corner: number, target: Vec2): Vec2[] {
  const rect = axisRect(polygon);
  if (rect) {
    const anchor = polygon[(corner + 2) % 4]!;
    return rectPolygon({ x0: Math.min(anchor[0], target[0]), x1: Math.max(anchor[0], target[0]), y0: Math.min(anchor[1], target[1]), y1: Math.max(anchor[1], target[1]) });
  }
  return polygon.map((p, i) => (i === corner ? [target[0], target[1]] : [p[0], p[1]]));
}

/** Which corner index of the NEW rectangle sits where the dragged one is, after `dragCorner` re-sorted the rectangle's corners. */
export function cornerAfterDrag(before: readonly Vec2[], after: readonly Vec2[], corner: number, target: Vec2): number {
  if (!axisRect(before)) return corner;
  let best = 0;
  after.forEach((p, i) => {
    if (Math.hypot(p[0] - target[0], p[1] - target[1]) < Math.hypot(after[best]![0] - target[0], after[best]![1] - target[1])) best = i;
  });
  return best;
}

function valid(room: Room, zoneId: string, polygon: Vec2[]): boolean {
  const rect = axisRect(polygon);
  if (rect && (rect.x1 - rect.x0 < MIN_ZONE_SIDE_M - 1e-9 || rect.y1 - rect.y0 < MIN_ZONE_SIDE_M - 1e-9)) return false;
  const others = (room.floorZones ?? []).filter((z) => z.id !== zoneId);
  return zoneProblems(room.polygon, [...others, { id: zoneId, polygon }]).length === 0;
}

export interface DragResult {
  polygon: Vec2[];
  /** Index of the dragged corner in `polygon` (a rectangle's corners are re-sorted). */
  corner: number;
  /** True when the pointer was beyond what the room allows and the zone stopped at the limit. */
  clamped: boolean;
}

/**
 * Drags corner `corner` of zone `zoneId` towards `pointer`: snapped to the grid (unless `grid` is false), then
 * clamped so the zone stays inside the room, off the room's other zones and at least 10 cm wide. When the pointer
 * is beyond the limit the corner stops at the last valid spot along the way, and slides along a wall when the
 * pointer keeps moving along it.
 */
export function dragZoneCorner(room: Room, zoneId: string, polygon: readonly Vec2[], corner: number, pointer: Vec2, grid = true): DragResult {
  const want: Vec2 = grid ? [snapValue(pointer[0], ZONE_GRID_M), snapValue(pointer[1], ZONE_GRID_M)] : [r4(pointer[0]), r4(pointer[1])];
  const build = (at: Vec2): DragResult => {
    const next = dragCorner(polygon, corner, at).map((p): Vec2 => [r4(p[0]), r4(p[1])]);
    return { polygon: next, corner: cornerAfterDrag(polygon, next, corner, at), clamped: false };
  };
  const full = build(want);
  if (valid(room, zoneId, full.polygon)) return full;
  const from = polygon[corner]!;
  /** Furthest valid point on the segment `a` -> `b` (a itself is valid). */
  const along = (a: Vec2, b: Vec2): Vec2 => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const at: Vec2 = [a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid];
      if (valid(room, zoneId, build(at).polygon)) lo = mid;
      else hi = mid;
    }
    return [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo];
  };
  // Move one axis at a time too, so the corner slides along a wall while the pointer keeps going past it.
  const xFirst = along(along(from, [want[0], from[1]]), want);
  const xThenY = ((p) => along(p, [p[0], want[1]]))(along(from, [want[0], from[1]]));
  const yThenX = ((p) => along(p, [want[0], p[1]]))(along(from, [from[0], want[1]]));
  const diagonal = along(from, want);
  const best = [diagonal, xFirst, xThenY, yThenX].reduce((a, b) => (Math.hypot(b[0] - want[0], b[1] - want[1]) < Math.hypot(a[0] - want[0], a[1] - want[1]) ? b : a));
  const result = build(best);
  return valid(room, zoneId, result.polygon) ? { ...result, clamped: true } : { polygon: polygon.map((p): Vec2 => [p[0], p[1]]), corner, clamped: true };
}

/** The `room.setFloorZone` command that stores `polygon` for the zone (name and material kept). */
export function zoneCommand(roomId: string, zone: FloorZone, polygon: Vec2[]): Command {
  return { type: 'room.setFloorZone', roomId, zone: { ...zone, polygon } };
}

/** Command that adds a zone rectangle to the room, defining its material first when needed. */
export function addZoneCommand(scene: Scene, room: Room): { command: Command; zoneId: string } | null {
  const polygon = newZoneRect(room);
  if (!polygon) return null;
  const zoneId = nextZoneId(room);
  const material = newZoneMaterial(scene, room);
  const name = `Zone ${(room.floorZones?.length ?? 0) + 1}`;
  const add: Command = { type: 'room.setFloorZone', roomId: room.id, zone: { id: zoneId, name, polygon, material: material.id } };
  return { zoneId, command: material.define ? { type: 'batch', label: `Add floor zone ${name} in ${room.name}`, commands: [material.define as never, add as never] } : add };
}
