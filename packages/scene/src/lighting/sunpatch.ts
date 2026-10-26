import type { Opening, Room, Scene, Vec2, Wall } from '../schema';
import { wallLength, wallLeftNormal } from '../schema';
import type { Point3 } from '../camera';
import { triangulatePolygon } from '../geometry/floors';
import { pointInPolygon } from '../validate';
import type { SiteContext } from '../context/schema';
import { contextPrisms, rayBlocked, type Prism } from './obstruction';
import { localDayBounds, sunAtInstant } from './sun';

export interface SunPatch {
  openingId: string;
  roomId: string;
  /** Lit area on the room floor, in plan coordinates, clipped to the room polygon. */
  polygon: Vec2[];
  area: number;
}

/** Sunlight smaller than this (m²) is not counted as "sun in the room". */
export const SUN_PATCH_MIN_AREA = 0.05;

const EPS = 1e-9;
/** Probe distance beyond the wall face used to decide which room/outside a wall side belongs to. */
const PROBE_MARGIN = 0.15;

function signedArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Sutherland–Hodgman: clips `subject` by the CONVEX counter-clockwise (y-down: positive signed area) `clip`. */
function clipConvex(subject: Vec2[], clip: readonly Vec2[]): Vec2[] {
  let out = subject;
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const side = (p: Vec2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k++) {
      const cur = input[k]!;
      const prev = input[(k + input.length - 1) % input.length]!;
      const sc = side(cur);
      const sp = side(prev);
      if (sc >= 0) {
        if (sp < 0) out.push(intersect(prev, cur, sp, sc));
        out.push(cur);
      } else if (sp >= 0) {
        out.push(intersect(prev, cur, sp, sc));
      }
    }
  }
  return out;
}

function intersect(p: Vec2, q: Vec2, sp: number, sq: number): Vec2 {
  const t = sp / (sp - sq);
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

function isConvex(poly: readonly Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const c = poly[(i + 2) % poly.length]!;
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < EPS) continue;
    const s = Math.sign(cr);
    if (sign !== 0 && s !== sign) return false;
    sign = s;
  }
  return true;
}

/** Pieces of `subject` (convex) lying inside `room`: one piece for convex rooms, one per triangle otherwise. */
function clipToRoom(subject: Vec2[], room: readonly Vec2[]): Vec2[][] {
  const orient = (poly: Vec2[]) => (signedArea(poly) < 0 ? [...poly].reverse() : poly);
  const subj = orient(subject);
  if (isConvex(room)) {
    const piece = clipConvex(subj, orient([...room]));
    return piece.length >= 3 ? [piece] : [];
  }
  const tri = triangulatePolygon(room);
  const pieces: Vec2[][] = [];
  for (let i = 0; i + 2 < tri.length; i += 3) {
    const t = orient([room[tri[i]!]!, room[tri[i + 1]!]!, room[tri[i + 2]!]!]);
    const piece = clipConvex(subj, t);
    if (piece.length >= 3 && Math.abs(signedArea(piece)) > EPS) pieces.push(piece);
  }
  return pieces;
}

const isIndoor = (r: Room) => r.type !== 'balcony';

function roomAt(rooms: readonly Room[], p: Vec2, pred: (r: Room) => boolean = () => true): Room | undefined {
  return rooms.find((r) => pred(r) && pointInPolygon(p, r.polygon));
}

function isGlazed(o: Opening): boolean {
  if (o.type === 'passage') return false;
  return o.glazed ?? o.type === 'window';
}

/**
 * Projects every glazed opening onto the floors along the sun direction (`direction` points
 * towards the sun). Ignores obstruction by interior walls and, unless `context` is given, by
 * neighbouring buildings.
 *
 * For each glazed window/door the rectangle (sill..sill+height, offset ± width/2) in the wall's
 * centreline plane is moved along -direction to the floor plane y = 0. Light only enters when
 * the sun is on the exterior side of the wall: the side facing the sun must not lie inside an
 * indoor room (balconies count as outdoors), and the side facing away must lie inside a room.
 * The projection is clipped to that receiving room (Sutherland–Hodgman against its earcut
 * triangulation when the room is concave; a concave room may therefore yield several
 * fragments for one opening, which share `openingId`/`roomId` and do not overlap).
 *
 * With `context` (neighbouring buildings, see `contextPrisms`), the opening is cut into a 3 x 3
 * grid of cells along the wall and up the glass. A cell's projection is kept only when the ray
 * from the cell centre (on the wall centreline plane) towards the sun is not blocked by a
 * context prism. All cells free: one patch exactly as without context. Some blocked: one patch
 * per free cell (cells project to disjoint parallelograms, so areas add up; the lit area
 * is quantised to ninths of the unobstructed area). All blocked: none.
 */
export function sunPatches(scene: Scene, direction: Point3, context?: SiteContext): SunPatch[] {
  const flatTop = Math.max(0, ...scene.walls.map((w) => w.height));
  return sunPatchesWith(scene, direction, context ? contextPrisms(context, flatTop) : undefined);
}

const GRID = 3;

function sunPatchesWith(scene: Scene, direction: Point3, prisms: readonly Prism[] | undefined): SunPatch[] {
  const [dx, dy, dz] = direction;
  if (!(dy > 1e-6)) return [];
  const wallsById = new Map<string, Wall>(scene.walls.map((w) => [w.id, w]));
  const out: SunPatch[] = [];

  for (const o of scene.openings) {
    if (!isGlazed(o)) continue;
    const wall = wallsById.get(o.wallId);
    if (!wall) continue;
    const len = wallLength(wall);
    if (len < EPS) continue;
    const n = wallLeftNormal(wall);
    // Which wall side faces the sun? (horizontal sun vector dotted with the left normal)
    const facing = dx * n[0] + dz * n[1];
    if (Math.abs(facing) < 1e-6) continue;
    const sunSide = Math.sign(facing);

    const ux = (wall.end[0] - wall.start[0]) / len;
    const uy = (wall.end[1] - wall.start[1]) / len;
    const from = Math.max(0, o.offset - o.width / 2);
    const to = Math.min(len, o.offset + o.width / 2);
    const sill = Math.min(o.sill, wall.height);
    const top = Math.min(o.sill + o.height, wall.height);
    if (to - from < EPS || top - sill < EPS) continue;

    const mid = (from + to) / 2;
    const reach = wall.thickness / 2 + PROBE_MARGIN;
    const probe = (side: number): Vec2 => [
      wall.start[0] + ux * mid + n[0] * side * reach,
      wall.start[1] + uy * mid + n[1] * side * reach,
    ];
    if (roomAt(scene.rooms, probe(sunSide), isIndoor)) continue; // sun side is not exterior
    const room = roomAt(scene.rooms, probe(-sunSide), isIndoor); // balconies never receive patches
    if (!room) continue;

    const onFloor = (s: number, y: number): Vec2 => [
      wall.start[0] + ux * s - dx * (y / dy),
      wall.start[1] + uy * s - dz * (y / dy),
    ];
    const emit = (s0: number, s1: number, y0: number, y1: number) => {
      const quad: Vec2[] = [onFloor(s0, y0), onFloor(s1, y0), onFloor(s1, y1), onFloor(s0, y1)];
      for (const polygon of clipToRoom(quad, room.polygon)) {
        const area = Math.abs(signedArea(polygon));
        if (area > EPS) out.push({ openingId: o.id, roomId: room.id, polygon, area });
      }
    };
    if (!prisms || prisms.length === 0) {
      emit(from, to, sill, top);
      continue;
    }
    const free: boolean[] = [];
    for (let iy = 0; iy < GRID; iy++) {
      for (let is = 0; is < GRID; is++) {
        const s = from + ((is + 0.5) / GRID) * (to - from);
        const y = sill + ((iy + 0.5) / GRID) * (top - sill);
        free.push(!rayBlocked(prisms, wall.start[0] + ux * s, wall.start[1] + uy * s, y, direction));
      }
    }
    if (free.every(Boolean)) {
      emit(from, to, sill, top);
      continue;
    }
    for (let iy = 0; iy < GRID; iy++) {
      for (let is = 0; is < GRID; is++) {
        if (!free[iy * GRID + is]) continue;
        emit(
          from + (is / GRID) * (to - from),
          from + ((is + 1) / GRID) * (to - from),
          sill + (iy / GRID) * (top - sill),
          sill + ((iy + 1) / GRID) * (top - sill),
        );
      }
    }
  }
  return out;
}

/**
 * Hours of direct sun per room on a local date (any patch with area > 0.05 m² counts),
 * sampled every `stepMinutes` at the middle of each step across the local civil day
 * (23/24/25 h on DST days). With `context`, neighbouring buildings obstruct the sun (see `sunPatches`). Every room is present in the result (0 when never sunlit).
 */
export function sunlightHours(scene: Scene, date: string, stepMinutes = 10, context?: SiteContext): Record<string, number> {
  if (!(stepMinutes > 0)) throw new RangeError('stepMinutes must be positive');
  const prisms = context ? contextPrisms(context, Math.max(0, ...scene.walls.map((w) => w.height))) : undefined;
  const hours: Record<string, number> = Object.fromEntries(scene.rooms.map((r) => [r.id, 0]));
  const { start, end } = localDayBounds(date, scene.site.timezone);
  const step = stepMinutes * 60_000;
  for (let t = start.getTime(); t < end.getTime(); t += step) {
    const slice = Math.min(step, end.getTime() - t);
    const sun = sunAtInstant(scene.site, new Date(t + slice / 2));
    if (!sun.isUp) continue;
    const area: Record<string, number> = {};
    for (const p of sunPatchesWith(scene, sun.direction, prisms)) area[p.roomId] = (area[p.roomId] ?? 0) + p.area;
    for (const [id, a] of Object.entries(area)) {
      if (a > SUN_PATCH_MIN_AREA) hours[id] = (hours[id] ?? 0) + slice / 3_600_000;
    }
  }
  return hours;
}
