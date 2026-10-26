import type { Opening, Room, Scene, Vec2, Wall } from '../schema';
import { wallLeftNormal, wallLength } from '../schema';
import { pointInPolygon } from '../validate';

/**
 * Sky light reaching a room, as a 0..1 factor the viewer multiplies its sky ambient with, so
 * windowless rooms (WC, bathroom, inner hallway) are not lit by the sky as if the roof were
 * open. It is a heuristic daylight-factor estimate, not a simulation:
 *
 *   own      = clamp(DAYLIGHT_K x glazedArea / floorArea, 0, 1)      (K = 5, i.e. glazing >= 20% of the floor = 1)
 *   factor   = clamp(max(own, DAYLIGHT_FLOOR) + BORROW x max(own of the adjacent indoor rooms linked by a door or passage), 0, 1)
 *   balcony  = 1                                                       (open to the sky)
 *
 * `glazedArea` sums width x height of the glazed openings (windows, doors with `glazed: true`)
 * of the room whose other side is outdoors (no indoor room there; balconies count as outdoors).
 * Examples: a living room with 4.7 m2 of French doors in 26 m2 -> 0.9; a 12 m2 bedroom with a
 * 1.5 m2 window -> 0.63; a WC -> 0.08; a hallway with a door to a lit room -> 0.08 + 0.15 x the brightest neighbour.
 */
export const DAYLIGHT_K = 5;
/** Minimum factor of an indoor room with no glazing at all. */
export const DAYLIGHT_FLOOR = 0.08;
/** Fraction of an adjacent room's own factor borrowed through doors and passages. */
export const DAYLIGHT_BORROW = 0.15;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function area(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

const isIndoor = (r: Room) => r.type !== 'balcony';
/** Offset beyond a wall face at which the side's room is sampled, metres. */
const FACE_OFFSET = 0.05;
/** Spacing of the samples along a wall, metres. */
const SAMPLE_STEP = 0.25;

function roomAt(rooms: readonly Room[], p: Vec2, pred: (r: Room) => boolean = () => true): Room | undefined {
  return rooms.find((r) => pred(r) && pointInPolygon(p, r.polygon));
}

function sides(wall: Wall, along: number, rooms: readonly Room[], pred?: (r: Room) => boolean): { left?: Room; right?: Room } {
  const len = wallLength(wall);
  const n = wallLeftNormal(wall);
  const x = wall.start[0] + ((wall.end[0] - wall.start[0]) / len) * along;
  const y = wall.start[1] + ((wall.end[1] - wall.start[1]) / len) * along;
  const d = wall.thickness / 2 + FACE_OFFSET;
  const left = roomAt(rooms, [x + n[0] * d, y + n[1] * d], pred);
  const right = roomAt(rooms, [x - n[0] * d, y - n[1] * d], pred);
  return { ...(left ? { left } : {}), ...(right ? { right } : {}) };
}

function isGlazed(o: Opening): boolean {
  return o.type !== 'passage' && (o.glazed ?? o.type === 'window');
}

/** The two rooms (or one room and outdoors) an opening connects, probed at its centre. */
function openingSides(scene: Scene, o: Opening, wall: Wall): { left?: Room; right?: Room } {
  const len = wallLength(wall);
  return sides(wall, Math.min(len, Math.max(0, o.offset)), scene.rooms);
}

/**
 * Estimated fraction (0..1) of sky light reaching each room, by room id. See `DAYLIGHT_K`,
 * `DAYLIGHT_FLOOR` and `DAYLIGHT_BORROW`. Every room is present; balconies are 1.
 */
export function roomDaylightFactors(scene: Scene): Record<string, number> {
  const walls = new Map(scene.walls.map((w) => [w.id, w]));
  const glazed: Record<string, number> = {};
  const neighbours = new Map<string, Set<string>>(scene.rooms.map((r) => [r.id, new Set()]));

  for (const o of scene.openings) {
    const wall = walls.get(o.wallId);
    if (!wall || wallLength(wall) < 1e-9) continue;
    const { left, right } = openingSides(scene, o, wall);
    if (left && right && left.id !== right.id) {
      if (isIndoor(left) && isIndoor(right) && o.type !== 'window') {
        neighbours.get(left.id)?.add(right.id);
        neighbours.get(right.id)?.add(left.id);
      }
    }
    if (!isGlazed(o)) continue;
    const opening = Math.min(o.width, wallLength(wall)) * Math.min(o.height, Math.max(0, wall.height - o.sill));
    // The light comes from the side with no indoor room (outdoors, balcony); the room is the other side.
    const lIn = left && isIndoor(left) ? left : undefined;
    const rIn = right && isIndoor(right) ? right : undefined;
    if (lIn && !rIn) glazed[lIn.id] = (glazed[lIn.id] ?? 0) + opening;
    else if (rIn && !lIn) glazed[rIn.id] = (glazed[rIn.id] ?? 0) + opening;
  }

  const own: Record<string, number> = {};
  for (const r of scene.rooms) {
    const floor = area(r.polygon);
    own[r.id] = isIndoor(r) ? clamp01((DAYLIGHT_K * (glazed[r.id] ?? 0)) / Math.max(floor, 1e-6)) : 1;
  }
  const out: Record<string, number> = {};
  for (const r of scene.rooms) {
    if (!isIndoor(r)) {
      out[r.id] = 1;
      continue;
    }
    let borrowed = 0; // the brightest neighbour only, so a hallway with many doors does not light up
    for (const id of neighbours.get(r.id) ?? []) borrowed = Math.max(borrowed, own[id] ?? 0);
    out[r.id] = clamp01(Math.max(own[r.id]!, DAYLIGHT_FLOOR) + DAYLIGHT_BORROW * borrowed);
  }
  return out;
}

/** Rooms on the two faces of a stretch of wall, from `from` to `to` metres along it. */
export interface WallSideSegment {
  from: number;
  to: number;
  left?: string;
  right?: string;
}

export interface WallSideRooms {
  /** Room on the left face (see `wallLeftNormal`) at mid-span, if any. Balconies count as rooms. */
  left?: string;
  /** Room on the right face at mid-span, if any. */
  right?: string;
  /** Per-stretch rooms along the wall (consecutive stretches with the same pair are merged). */
  segments: WallSideSegment[];
}

/**
 * Which room each face of each wall belongs to: rooms are sampled 5 cm beyond the face (half
 * the thickness + 5 cm from the centreline) every 25 cm along the wall, and at mid-span for
 * the summary `left`/`right`. A face with no room (outside, a gap) has no entry. Balcony
 * rooms are included, so a facade face towards a balcony resolves to the balcony.
 */
export function wallSideRooms(scene: Scene): Record<string, WallSideRooms> {
  const out: Record<string, WallSideRooms> = {};
  for (const wall of scene.walls) {
    const len = wallLength(wall);
    if (len < 1e-9) {
      out[wall.id] = { segments: [] };
      continue;
    }
    const mid = sides(wall, len / 2, scene.rooms);
    const count = Math.max(1, Math.ceil(len / SAMPLE_STEP));
    const segments: WallSideSegment[] = [];
    for (let i = 0; i < count; i++) {
      const s = sides(wall, ((i + 0.5) / count) * len, scene.rooms);
      const from = (i / count) * len;
      const to = ((i + 1) / count) * len;
      const last = segments[segments.length - 1];
      if (last && last.left === s.left?.id && last.right === s.right?.id) last.to = to;
      else segments.push({ from, to, ...(s.left ? { left: s.left.id } : {}), ...(s.right ? { right: s.right.id } : {}) });
    }
    out[wall.id] = { ...(mid.left ? { left: mid.left.id } : {}), ...(mid.right ? { right: mid.right.id } : {}), segments };
  }
  return out;
}
