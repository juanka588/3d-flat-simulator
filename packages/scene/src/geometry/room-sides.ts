import type { Room, Scene, Vec2, Wall } from '../schema';
import { wallLeftNormal, wallLength } from '../schema';
import { pointInPolygon } from '../validate';

/**
 * Which wall faces border a room. A wall side "belongs" to a room when one of the room's
 * polygon edges runs along it: the edge lies within the wall's thickness band (so polygons
 * drawn on the inner faces, the convention, and on centrelines both work), overlaps the wall
 * by at least `MIN_SIDE_OVERLAP`, and the room's interior is on that side of the wall.
 *
 * `left`/`right` follow `wallLeftNormal`: a room on the +normal side of a wall sees its left face.
 */
export type WallSideName = 'left' | 'right';

export interface RoomWallSide {
  wallId: string;
  side: WallSideName;
  /**
   * `full` when the room is the only room on this wall side. `partial` when other rooms share
   * the same side. A whole-side finish (`wall.setFinish`) would show in those rooms too, so
   * `room.setWallFinish` leaves partial sides alone and paints the room's stretch via `Room.wallFinish`.
   */
  coverage: 'full' | 'partial';
}

export interface SharedWallSideWarning {
  code: 'shared_wall_side';
  wallId: string;
  side: WallSideName;
  /** The other rooms that see the same wall side. */
  roomIds: string[];
  message: string;
}

export type RoomWallSidesResult =
  | { ok: true; sides: RoomWallSide[]; warnings: SharedWallSideWarning[] }
  | { ok: false; errors: { code: 'unknown_entity' | 'no_wall_sides'; message: string }[] };

/** Distance, in metres, a room edge may be off a wall face (or the thickness band) and still count. */
export const SIDE_TOLERANCE = 0.03;
/** Shortest overlap, in metres, between a room edge and a wall for the side to count (ignores corner touches). */
export const MIN_SIDE_OVERLAP = 0.1;
/** How far beyond the edge the room interior is probed, in metres. */
const PROBE = 0.04;

interface Cover {
  roomId: string;
  /** Merged `[from, to]` stretches along the wall, in metres from its start. */
  spans: [number, number][];
}

type SideKey = `${string}|${WallSideName}`;

function mergeSpans(spans: [number, number][]): [number, number][] {
  const sorted = spans.map((s) => [...s] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], s[1]);
    else out.push(s);
  }
  return out;
}

function roomCovers(walls: readonly Wall[], room: Room): Map<SideKey, Cover> {
  const out = new Map<SideKey, [number, number][]>();
  const poly = room.polygon;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    for (const wall of walls) {
      const len = wallLength(wall);
      if (len < 1e-9) continue;
      const n = wallLeftNormal(wall);
      const dx = (wall.end[0] - wall.start[0]) / len;
      const dy = (wall.end[1] - wall.start[1]) / len;
      const band = wall.thickness / 2 + SIDE_TOLERANCE;
      const off = (p: Vec2) => (p[0] - wall.start[0]) * n[0] + (p[1] - wall.start[1]) * n[1];
      const along = (p: Vec2) => (p[0] - wall.start[0]) * dx + (p[1] - wall.start[1]) * dy;
      const da = off(a);
      const db = off(b);
      if (Math.abs(da) > band || Math.abs(db) > band) continue;
      const lo = Math.max(0, Math.min(along(a), along(b)));
      const hi = Math.min(len, Math.max(along(a), along(b)));
      if (hi - lo < MIN_SIDE_OVERLAP) continue;
      const t = (lo + hi) / 2;
      const mid: Vec2 = [wall.start[0] + dx * t, wall.start[1] + dy * t];
      // Move the probe point onto the edge's own offset, then step off it to either side.
      const edgeOffset = (da + db) / 2;
      const base: Vec2 = [mid[0] + n[0] * edgeOffset, mid[1] + n[1] * edgeOffset];
      let side: WallSideName | undefined;
      if (edgeOffset >= -SIDE_TOLERANCE && pointInPolygon([base[0] + n[0] * PROBE, base[1] + n[1] * PROBE], poly, 0)) side = 'left';
      else if (edgeOffset <= SIDE_TOLERANCE && pointInPolygon([base[0] - n[0] * PROBE, base[1] - n[1] * PROBE], poly, 0)) side = 'right';
      if (!side) continue;
      const key: SideKey = `${wall.id}|${side}`;
      const list = out.get(key) ?? [];
      list.push([lo, hi]);
      out.set(key, list);
    }
  }
  const covers = new Map<SideKey, Cover>();
  for (const [key, spans] of out) covers.set(key, { roomId: room.id, spans: mergeSpans(spans) });
  return covers;
}

const index = new WeakMap<object, Map<SideKey, Cover[]>>();

/** Every wall side with the rooms (in scene order) that see it. Cached per scene object. */
function sideIndex(scene: Pick<Scene, 'walls' | 'rooms'>): Map<SideKey, Cover[]> {
  const cached = index.get(scene);
  if (cached) return cached;
  const all = new Map<SideKey, Cover[]>();
  for (const room of scene.rooms) {
    for (const [key, cover] of roomCovers(scene.walls, room)) {
      const list = all.get(key) ?? [];
      list.push(cover);
      all.set(key, list);
    }
  }
  index.set(scene, all);
  return all;
}

/**
 * Wall sides facing `roomId`, in wall order then left before right. Empty when the room is
 * unknown or has no walls along its edges (an unwalled room).
 */
export function roomWallSides(scene: Pick<Scene, 'walls' | 'rooms'>, roomId: string): RoomWallSide[] {
  const result = analyzeRoomWallSides(scene, roomId);
  return result.ok ? result.sides : [];
}

/** Like `roomWallSides` but with `shared_wall_side` warnings and `unknown_entity` / `no_wall_sides` errors. */
export function analyzeRoomWallSides(scene: Pick<Scene, 'walls' | 'rooms'>, roomId: string): RoomWallSidesResult {
  if (!scene.rooms.some((r) => r.id === roomId)) {
    return { ok: false, errors: [{ code: 'unknown_entity', message: `unknown room "${roomId}"` }] };
  }
  const all = sideIndex(scene);
  const sides: RoomWallSide[] = [];
  const warnings: SharedWallSideWarning[] = [];
  for (const wall of scene.walls) {
    for (const side of ['left', 'right'] as const) {
      const covers = all.get(`${wall.id}|${side}`);
      if (!covers?.some((c) => c.roomId === roomId)) continue;
      const others = covers.filter((c) => c.roomId !== roomId).map((c) => c.roomId);
      sides.push({ wallId: wall.id, side, coverage: others.length ? 'partial' : 'full' });
      if (others.length) {
        warnings.push({
          code: 'shared_wall_side',
          wallId: wall.id,
          side,
          roomIds: others,
          message: `the ${side} side of wall "${wall.id}" is shared with ${others.map((r) => `"${r}"`).join(', ')}; a whole-side finish on it would show in those rooms too`,
        });
      }
    }
  }
  if (sides.length === 0) {
    return { ok: false, errors: [{ code: 'no_wall_sides', message: `room "${roomId}" has no walls along its edges` }] };
  }
  return { ok: true, sides, warnings };
}

/** Rooms seeing each face of each wall (all room types, balconies included), by wall id. */
export function wallFaceRooms(scene: Pick<Scene, 'walls' | 'rooms'>): Map<string, { left: string[]; right: string[] }> {
  const all = sideIndex(scene);
  const out = new Map<string, { left: string[]; right: string[] }>();
  for (const wall of scene.walls) {
    out.set(wall.id, {
      left: (all.get(`${wall.id}|left`) ?? []).map((c) => c.roomId),
      right: (all.get(`${wall.id}|right`) ?? []).map((c) => c.roomId),
    });
  }
  return out;
}
