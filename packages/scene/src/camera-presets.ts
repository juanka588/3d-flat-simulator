import { DEFAULT_RADIUS, distanceToObstacle, insideFlat, wallObstacles } from './collision';
import { sceneBounds3, type Box3, type Point3 } from './camera';
import { roomWallSides } from './geometry/room-sides';
import { roomCeilingHeight } from './geometry/floors';
import { wallSideRooms } from './lighting/daylight';
import { polygonCentroid } from './measure';
import { footprintOf, insideConvex, itemDims } from './placement/footprint';
import { doorSwingPolygon, openingFrame } from './placement/swing';
import type { Room, Scene, Vec2, Wall } from './schema';
import { wallLeftNormal, wallLength } from './schema';
import { distanceToSegment, pointInPolygon } from './validate';
import type { CameraPose, OrbitPose, TopPose, WalkPose } from './view';

/**
 * Pure camera presets (M4.3, lane A). Each returns a `CameraPose` for a scene; none reads a clock,
 * a viewport or a renderer, so the same input gives the same pose and they run in node.
 * Contract tests: every preset on every fixture returns a pose that passes `CameraPose.parse`, has
 * finite numbers, and (walk) an eye position inside the room polygon.
 *
 * Aspect ratio: poses are fitted for `aspect` (default 4:3, the default render size), and so also
 * fit every wider viewport. Orbit azimuth is clockwise from plan-up; the camera sits at
 * `target + d * (sin az * cos el, sin el, -cos az * cos el)` in (X, Y, Z) with Z = plan y.
 */

/** Compass point (true north, after `site.northAngle`) or a plan heading in degrees clockwise from plan-up. */
export type Facing = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW' | number;

/** What a walk pose may look at: a `Facing`, a wall (`{wallId}`), or an opening (`{openingId}`). A plain string that is no compass point is read as a wall id, then an opening id. */
export type FacingTarget = Facing | string | { wallId: string } | { openingId: string };

/** An error the caller maps to `unknown_room` (the message lists the nearest room ids). */
export class UnknownRoomError extends Error {
  constructor(public readonly roomId: string) {
    super(`unknown room "${roomId}"`);
    this.name = 'UnknownRoomError';
  }
}

/** A walk target (wall or opening id, or a compass string) that does not exist. */
export class UnknownFacingError extends Error {
  constructor(public readonly facing: string) {
    super(`unknown facing target "${facing}": expected a compass point, degrees, a wall id or an opening id`);
    this.name = 'UnknownFacingError';
  }
}

const COMPASS_BEARING: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
const DEG = Math.PI / 180;
const norm360 = (d: number) => ((d % 360) + 360) % 360;
const DEFAULT_ASPECT = 4 / 3;
const DEFAULT_MARGIN = 0.1;

const findRoom = (scene: Scene, roomId: string): Room => {
  const room = scene.rooms.find((r) => r.id === roomId);
  if (!room) throw new UnknownRoomError(roomId);
  return room;
};

/** Resolves a `Facing` to a plan heading (degrees clockwise from plan-up, in [0, 360)) for the scene's `northAngle`. */
export function facingToHeadingDeg(scene: Scene, facing: Facing): number {
  if (typeof facing === 'number') return norm360(facing);
  const bearing = COMPASS_BEARING[facing];
  if (bearing === undefined) throw new UnknownFacingError(String(facing));
  return norm360(bearing + scene.site.northAngle);
}

/** Box of a room: its polygon bounds, floor to ceiling (balconies: the tallest wall of the flat). */
function roomBox(scene: Scene, room: Room): Box3 {
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);
  const h = room.type === 'balcony' ? (room.ceilingHeight ?? Math.max(1.1, ...scene.walls.map((w) => w.height))) : roomCeilingHeight(scene, room);
  return { min: [Math.min(...xs), 0, Math.min(...ys)], max: [Math.max(...xs), h, Math.max(...ys)] };
}

function targetBox(scene: Scene, roomId?: string): Box3 {
  return roomId === undefined ? sceneBounds3(scene) : roomBox(scene, findRoom(scene, roomId));
}

function corners(b: Box3): Point3[] {
  const out: Point3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

/** Smallest distance at which every corner of `box` projects inside the frustum with `margin` to spare. */
export function fitOrbit(box: Box3, o: { azimuthDeg: number; elevationDeg: number; fovDeg: number; aspect: number; margin: number }): OrbitPose {
  const target: Point3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const az = o.azimuthDeg * DEG;
  const el = o.elevationDeg * DEG;
  // Unit vector from target to camera, then the camera basis.
  const dir: Point3 = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  const f: Point3 = [-dir[0], -dir[1], -dir[2]];
  const right: Point3 = [-f[2], 0, f[0]]; // f x up, normalised below
  const rl = Math.hypot(right[0], right[2]);
  right[0] /= rl;
  right[2] /= rl;
  const up: Point3 = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
  const dot = (a: Point3, b: Point3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const t = Math.tan((o.fovDeg * DEG) / 2);
  const lim = 1 / (1 + o.margin);
  let d = 0.5;
  for (const c of corners(box)) {
    const rel: Point3 = [c[0] - target[0], c[1] - target[1], c[2] - target[2]];
    const along = dot(rel, f);
    d = Math.max(d, Math.abs(dot(rel, right)) / (t * o.aspect * lim) - along, Math.abs(dot(rel, up)) / (t * lim) - along);
  }
  return {
    mode: 'orbit',
    target,
    azimuthDeg: o.azimuthDeg,
    elevationDeg: o.elevationDeg,
    distance: Math.min(200, d),
    fovDeg: o.fovDeg,
  };
}

/**
 * Orbit-style overview of one room (`render_view {view:'room'}`). The camera sits ABOVE the walls
 * (never inside the room): 45 degrees up, towards the south-east corner of the page (azimuth 135),
 * so the near walls cannot hide the floor and the far walls show their inner faces. It is fitted so
 * the whole room box (polygon bounds, floor to ceiling) is in the frustum with a 10% margin for any
 * aspect >= `opts.aspect` (default 4:3), and the user can keep orbiting from there.
 * Throws `UnknownRoomError` for an unknown room.
 */
export function roomOverviewPose(scene: Scene, roomId: string, opts?: { fovDeg?: number; aspect?: number }): OrbitPose {
  const room = findRoom(scene, roomId);
  return fitOrbit(roomBox(scene, room), {
    azimuthDeg: 135,
    elevationDeg: 45,
    fovDeg: opts?.fovDeg ?? 50,
    aspect: opts?.aspect ?? DEFAULT_ASPECT,
    margin: DEFAULT_MARGIN,
  });
}

// ---------------------------------------------------------------------------------------------
// Walk pose
// ---------------------------------------------------------------------------------------------

interface Aim {
  /** Plan point to look at (or undefined: look along `heading`). */
  point?: Vec2;
  heading?: number;
  /** Unit normal of the surface looked at, pointing into the room: views should not graze it. */
  surfaceNormal?: Vec2;
}

const COMPASS_KEYS = new Set(Object.keys(COMPASS_BEARING));

function resolveAim(scene: Scene, room: Room, facing: FacingTarget | undefined): Aim {
  if (facing === undefined) return { point: polygonCentroid(room.polygon) };
  if (typeof facing === 'number') return { heading: facingToHeadingDeg(scene, facing) };
  if (typeof facing === 'string' && COMPASS_KEYS.has(facing)) return { heading: facingToHeadingDeg(scene, facing as Facing) };
  const wallId = typeof facing === 'string' ? (scene.walls.some((w) => w.id === facing) ? facing : undefined) : 'wallId' in facing ? facing.wallId : undefined;
  const openingId =
    typeof facing === 'string' ? (wallId === undefined ? facing : undefined) : 'openingId' in facing ? facing.openingId : undefined;
  if (wallId !== undefined) {
    const wall = scene.walls.find((w) => w.id === wallId);
    if (!wall) throw new UnknownFacingError(wallId);
    return wallAim(scene, room, wall);
  }
  const opening = scene.openings.find((o) => o.id === openingId);
  if (!opening) throw new UnknownFacingError(String(openingId));
  const wall = scene.walls.find((w) => w.id === opening.wallId);
  if (!wall) throw new UnknownFacingError(opening.id);
  const len = wallLength(wall);
  const t = Math.min(len, Math.max(0, opening.offset)) / len;
  const point: Vec2 = [wall.start[0] + (wall.end[0] - wall.start[0]) * t, wall.start[1] + (wall.end[1] - wall.start[1]) * t];
  return { point, surfaceNormal: roomNormal(scene, room, wall) };
}

/** Normal of `wall` pointing into `room`, when one of its faces borders the room. */
function roomNormal(scene: Scene, room: Room, wall: Wall): Vec2 | undefined {
  const side = roomWallSides(scene, room.id).find((s) => s.wallId === wall.id);
  if (!side) return undefined;
  const n = wallLeftNormal(wall);
  return side.side === 'left' ? n : [-n[0], -n[1]];
}

/** Middle of the longest stretch of the wall face that borders the room (else the wall's midpoint). */
function wallAim(scene: Scene, room: Room, wall: Wall): Aim {
  const len = wallLength(wall);
  const side = roomWallSides(scene, room.id).find((s) => s.wallId === wall.id)?.side;
  let from = 0;
  let to = len;
  if (side) {
    let best = -1;
    for (const seg of wallSideRooms(scene)[wall.id]?.segments ?? []) {
      if (seg[side] === room.id && seg.to - seg.from > best) {
        best = seg.to - seg.from;
        from = seg.from;
        to = seg.to;
      }
    }
  }
  const t = (from + to) / 2 / len;
  return {
    point: [wall.start[0] + (wall.end[0] - wall.start[0]) * t, wall.start[1] + (wall.end[1] - wall.start[1]) * t],
    surfaceNormal: roomNormal(scene, room, wall),
  };
}

/** Distance from `p` along unit `d` to the first polygon edge (Infinity if none). */
function rayToPolygon(p: Vec2, d: Vec2, polygon: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const den = d[0] * ey - d[1] * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
    const u = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den;
    if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.min(best, t);
  }
  return best;
}

const headingVec = (deg: number): Vec2 => [Math.sin(deg * DEG), -Math.cos(deg * DEG)];

/** Distance a leaf or a tall item must keep from the eye so it does not fill the picture (m). */
const LEAF_EYE_MARGIN = 0.35;
/** Things nearer than this along a sight ray count as filling that part of the picture (m). */
const NEAR_BLOCK_M = 2;
/** Horizontal rays cast across the field of view to measure how much of the picture a near blocker covers. */
const COVERAGE_RAYS = 9;
/** A walk view with less than this free ahead is tilted down (m). */
const SHORT_VIEW_M = 3;
/** Most a short view is tilted down (degrees). */
const MAX_TILT_DEG = 25;
/** Items at least this tall (and standing below the eye) hide what is behind them from eye level (m). */
const TALL_ITEM_M = 1.1;

/** Open door leaves as drawn by `buildFittings` (unglazed doors, perpendicular to the wall, one leaf width long), as plan segments. */
function openDoorLeaves(scene: Scene): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (const o of scene.openings) {
    if (o.type !== 'door' || (o.glazed ?? false)) continue;
    const f = openingFrame(scene, o);
    if (!f) continue;
    const arc = doorSwingPolygon(f, o);
    out.push([arc[0]!, arc[arc.length - 1]!]);
  }
  return out;
}

/**
 * What can hide the view from eye level: open door leaves and items that rise above the eye line's lower reach.
 * Polygons for `rayToPolygon` (a leaf is a two-point polygon).
 */
function viewBlockers(scene: Scene, room: Room, eyeHeight: number): { polys: Vec2[][]; leaves: [Vec2, Vec2][] } {
  const leaves = openDoorLeaves(scene);
  const polys: Vec2[][] = leaves.map(([a, b]) => [a, b]);
  for (const i of scene.items) {
    const d = itemDims(i);
    if ((i.elevation ?? 0) >= eyeHeight || (i.elevation ?? 0) + d.h < TALL_ITEM_M) continue;
    if (i.roomId !== undefined && i.roomId !== room.id) continue;
    polys.push(footprintOf(i.position, i.rotation, d));
  }
  return { polys, leaves };
}

/**
 * Eye-level pose standing inside the room, looking `facing`:
 * - a compass point or degrees: the heading is exact, and the room spot is the one with the longest
 *   clear sight line in that direction (the viewer stands at the back of the room);
 * - `{wallId}` / `{openingId}` (or such a string id): the heading points exactly at the middle of
 *   that wall's stretch in the room / at the opening's centre. The spot is the farthest one with a
 *   clear line of sight that does not graze the surface (angle to its normal at most 60 degrees);
 * - omitted: looks at the room's centroid from the farthest spot with a clear view.
 * The eye is always inside the room polygon, at least `DEFAULT_RADIUS` (the body radius) from every
 * wall and polygon edge when the room has any such spot (otherwise the most spacious point).
 * Throws `UnknownRoomError` for an unknown room, `UnknownFacingError` for an unknown target.
 */
export function walkPoseInRoom(
  scene: Scene,
  roomId: string,
  opts?: { facing?: FacingTarget; eyeHeight?: number; fovDeg?: number },
): WalkPose {
  const room = findRoom(scene, roomId);
  const eyeHeight = opts?.eyeHeight ?? 1.6;
  const fov = opts?.fovDeg ?? 70;
  const aim = resolveAim(scene, room, opts?.facing);
  const obstacles = wallObstacles(scene);
  const inFlat = insideFlat(scene);
  const poly = room.polygon;
  const clearance = (p: Vec2) => {
    let c = Infinity;
    for (const o of obstacles) c = Math.min(c, distanceToObstacle(p, o));
    for (let k = 0; k < poly.length; k++) c = Math.min(c, distanceToSegment(p, poly[k]!, poly[(k + 1) % poly.length]!));
    return c;
  };

  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const step = Math.max(0.1, (Math.max(...xs) - minX) / 120, (Math.max(...ys) - minY) / 120);
  const centre = polygonCentroid(poly);
  const cands: { p: Vec2; clear: number }[] = [];
  for (let x = minX; x <= Math.max(...xs); x += step) {
    for (let y = minY; y <= Math.max(...ys); y += step) {
      const p: Vec2 = [x, y];
      if (pointInPolygon(p, poly, 0) && inFlat(p)) cands.push({ p, clear: clearance(p) });
    }
  }
  // The eye must not stand inside furniture (a wardrobe around the camera renders as one flat colour):
  // drop spots within a body radius of any item that reaches into the body zone. Kept only if some spot remains.
  const bodies = scene.items
    .filter((i) => (i.elevation ?? 0) < 1.8 && (i.elevation ?? 0) + itemDims(i).h > 0.25)
    .map((i) => footprintOf(i.position, i.rotation, { w: itemDims(i).w + 2 * DEFAULT_RADIUS, d: itemDims(i).d + 2 * DEFAULT_RADIUS }));
  if (bodies.length) {
    const free = cands.filter((c) => !bodies.some((b) => insideConvex(c.p, b)));
    if (free.length) cands.splice(0, cands.length, ...free);
  }
  // Nor within reach of an open door leaf: drawn opaque, it fills half the picture (or all of it, in a small room).
  const view = viewBlockers(scene, room, eyeHeight);
  // What there is to look at: the furniture of the room (a view of bare walls says nothing, and a plain wall renders as one flat colour).
  const content = scene.items
    .filter((i) => (i.roomId === undefined || i.roomId === room.id) && (i.elevation ?? 0) < eyeHeight && (i.elevation ?? 0) + itemDims(i).h > 0.3)
    .map((i) => footprintOf(i.position, i.rotation, itemDims(i)));
  if (view.leaves.length) {
    const away = cands.filter((c) => !view.leaves.some(([a, b]) => distanceToSegment(c.p, a, b) < LEAF_EYE_MARGIN));
    if (away.length) cands.splice(0, cands.length, ...away);
  }
  if (cands.length === 0) cands.push({ p: pointInPolygon(centre, poly, 0) ? centre : poly[0]!, clear: 0 });
  let pool = cands.filter((c) => c.clear >= DEFAULT_RADIUS);
  if (pool.length === 0) {
    const best = Math.max(...cands.map((c) => c.clear));
    pool = cands.filter((c) => c.clear >= best - 1e-9);
  }

  const lineClear = (p: Vec2, q: Vec2) => {
    const n = Math.max(2, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 0.1));
    for (let i = 1; i < n; i++) {
      const s: Vec2 = [p[0] + ((q[0] - p[0]) * i) / n, p[1] + ((q[1] - p[1]) * i) / n];
      if (!pointInPolygon(s, poly, 1e-6) && !inFlat(s)) return false;
    }
    return true;
  };

  /** Share of the field of view (0..1) that a near blocker fills when looking from `p` along `heading`, and whether the middle ray is free up to `reach`. */
  const coverage = (p: Vec2, headingDeg: number, reach: number): { cover: number; centreClear: boolean; seen: number } => {
    if (view.polys.length === 0 && content.length === 0) return { cover: 0, centreClear: true, seen: 0 };
    let hits = 0;
    let seenRays = 0;
    let centreClear = true;
    for (let k = 0; k < COVERAGE_RAYS; k++) {
      const off = (k / (COVERAGE_RAYS - 1) - 0.5) * fov * 0.9;
      const d = headingVec(headingDeg + off);
      let t = Infinity;
      for (const poly of view.polys) t = Math.min(t, rayToPolygon(p, d, poly));
      const wall = Math.min(rayToPolygon(p, d, poly), 1e6);
      if (t < Math.min(wall, NEAR_BLOCK_M)) hits++;
      if (off === 0 && t < reach) centreClear = false;
      let seen = Math.min(t, wall);
      for (const poly of content) seen = Math.min(seen, rayToPolygon(p, d, poly));
      if (seen < wall - 0.05) seenRays++;
    }
    return { cover: hits / COVERAGE_RAYS, centreClear, seen: seenRays / COVERAGE_RAYS };
  };
  /** From strictest to loosest: how much of the picture a blocker may fill. The last level accepts anything. */
  const COVER_LEVELS = [0.12, 0.25, 0.5, 1.01];

  let pos: Vec2;
  let heading: number;
  if (aim.point) {
    const target = aim.point;
    // Aim at the surface a hair in front of the wall face so the line of sight stays in the room.
    const score = (c: { p: Vec2; clear: number }, strict: boolean, maxCover: number) => {
      const dx = target[0] - c.p[0];
      const dy = target[1] - c.p[1];
      const dist = Math.hypot(dx, dy);
      if (dist < 0.3) return -Infinity;
      if (strict && aim.surfaceNormal) {
        const cos = Math.abs((dx * aim.surfaceNormal[0] + dy * aim.surfaceNormal[1]) / dist);
        if (cos < 0.5) return -Infinity;
      }
      const inFront: Vec2 = aim.surfaceNormal ? [target[0] + aim.surfaceNormal[0] * 0.1, target[1] + aim.surfaceNormal[1] * 0.1] : target;
      if (!lineClear(c.p, inFront)) return -Infinity;
      const heading0 = norm360((Math.atan2(dx, -dy) * 180) / Math.PI);
      // the target must be seen: nothing in front of it, and no door leaf or tall piece filling the picture
      const v = coverage(c.p, heading0, Math.max(0, dist - 0.15));
      if (maxCover <= 1 && !v.centreClear) return -Infinity;
      if (v.cover > maxCover) return -Infinity;
      return dist - 0.05 * Math.hypot(c.p[0] - centre[0], c.p[1] - centre[1]) - 3 * v.cover + (aim.surfaceNormal ? 0 : 2 * v.seen);
    };
    let best = -Infinity;
    let pick = pool[0]!;
    search: for (const maxCover of COVER_LEVELS) {
      for (const strict of [true, false]) {
        for (const c of pool) {
          const sc = score(c, strict, maxCover);
          if (sc > best + 1e-9) {
            best = sc;
            pick = c;
          }
        }
        if (best > -Infinity) break search;
      }
    }
    if (best === -Infinity) pick = pool.reduce((a, b) => (Math.hypot(a.p[0] - target[0], a.p[1] - target[1]) > Math.hypot(b.p[0] - target[0], b.p[1] - target[1]) ? a : b));
    pos = pick.p;
    const dx = target[0] - pos[0];
    const dy = target[1] - pos[1];
    heading = Math.hypot(dx, dy) < 1e-9 ? 0 : norm360((Math.atan2(dx, -dy) * 180) / Math.PI);
  } else {
    heading = aim.heading ?? 0;
    const d = headingVec(heading);
    let best = -Infinity;
    let pick = pool[0]!;
    for (const maxCover of COVER_LEVELS) {
      for (const c of pool) {
        const v = coverage(c.p, heading, 1.5);
        if (v.cover > maxCover) continue;
        let free = Math.min(rayToPolygon(c.p, d, poly), 1e6);
        for (const b of view.polys) free = Math.min(free, rayToPolygon(c.p, d, b));
        const sc = free - 0.05 * Math.hypot(c.p[0] - centre[0], c.p[1] - centre[1]) - 3 * v.cover + 2 * v.seen;
        if (sc > best + 1e-9) {
          best = sc;
          pick = c;
        }
      }
      if (best > -Infinity) break;
    }
    pos = pick.p;
  }

  // A short view (a WC, a corridor end): tilt down so the floor and the furniture show, not just two plain walls.
  let ahead = Math.min(rayToPolygon(pos, headingVec(heading), poly), 1e6);
  for (const b of view.polys) ahead = Math.min(ahead, rayToPolygon(pos, headingVec(heading), b));
  const pitchDeg = ahead < SHORT_VIEW_M ? -Math.round(Math.min(MAX_TILT_DEG, Math.atan((eyeHeight - 0.8) / Math.max(ahead, 0.5)) / DEG)) : 0;

  return {
    mode: 'walk',
    position: [Math.round(pos[0] * 1e4) / 1e4, Math.round(pos[1] * 1e4) / 1e4],
    eyeHeight,
    headingDeg: heading,
    pitchDeg,
    fovDeg: fov,
  };
}

/**
 * Orthographic plan view fitting the room (`roomId`) or the whole flat, plan-up at the top of the
 * screen. `halfHeight` includes `margin` (default 10%) and is wide enough for `aspect` (default 4:3).
 */
export function topPose(scene: Scene, opts?: { roomId?: string; margin?: number; aspect?: number }): TopPose {
  const box = targetBox(scene, opts?.roomId);
  const w = box.max[0] - box.min[0];
  const h = box.max[2] - box.min[2];
  const aspect = opts?.aspect ?? DEFAULT_ASPECT;
  const half = Math.max(h / 2, w / 2 / aspect, 0.5) * (1 + (opts?.margin ?? DEFAULT_MARGIN));
  return {
    mode: 'top',
    center: [(box.min[0] + box.max[0]) / 2, (box.min[2] + box.max[2]) / 2],
    halfHeight: Math.min(200, half),
    rotationDeg: 0,
  };
}

/** Orbit view of the whole flat (or of `roomId`) from `azimuthDeg` (default 135) / `elevationDeg` (default 45). */
export function orbitPose(
  scene: Scene,
  opts?: { roomId?: string; azimuthDeg?: number; elevationDeg?: number; fovDeg?: number; aspect?: number },
): OrbitPose {
  return fitOrbit(targetBox(scene, opts?.roomId), {
    azimuthDeg: opts?.azimuthDeg ?? 135,
    elevationDeg: Math.min(89, Math.max(5, opts?.elevationDeg ?? 45)),
    fovDeg: opts?.fovDeg ?? 50,
    aspect: opts?.aspect ?? DEFAULT_ASPECT,
    margin: DEFAULT_MARGIN,
  });
}

export type { CameraPose };
