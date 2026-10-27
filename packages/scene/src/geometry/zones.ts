import earcut from 'earcut';
import { isSimplePolygon, polygonArea } from '../measure';
import type { Room, Scene, Vec2 } from '../schema';
import { floorMaterial } from './materials';

/**
 * Floor zones: parts of a room floor with their own material (`Room.floorZones`).
 *
 * A zone must be a simple polygon lying inside the room polygon (within `ZONE_TOLERANCE`), and zones
 * of one room may not overlap (touching is fine). Everything here is pure plan geometry in metres;
 * the mesh builder (`floors.ts`) and the validators use it.
 */

/** A zone vertex may lie this far (metres) outside the room polygon (1 cm: wall faces are drawn to the mm). */
export const ZONE_TOLERANCE = 0.01;
/** Two zones overlapping by more than this area (m²) are refused. */
export const ZONE_OVERLAP_AREA = 1e-4;
/** Pieces smaller than this (m²) are dropped when splitting the floor. */
const MIN_PIECE_AREA = 1e-9;

type Poly = Vec2[];

function triangleList(polygon: readonly Vec2[]): Poly[] {
  const idx = polygon.length < 3 ? [] : earcut(polygon.flatMap((p) => [p[0], p[1]]));
  const out: Poly[] = [];
  for (let i = 0; i < idx.length; i += 3) out.push(ccw([polygon[idx[i]!]!, polygon[idx[i + 1]!]!, polygon[idx[i + 2]!]!]));
  return out;
}

/** Counter-clockwise in math axes (positive shoelace sum). */
function ccw(poly: Poly): Poly {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum < 0 ? poly.slice().reverse() : poly;
}

function isConvex(poly: readonly Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const c = poly[(i + 2) % poly.length]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-12) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/** Part of the convex polygon on one side of the line through `a`, `b`: `sign` 1 keeps `side >= 0`, -1 keeps `side <= 0`. */
function clipHalf(poly: Poly, a: Vec2, b: Vec2, sign: 1 | -1): Poly {
  const side = (p: Vec2) => sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
  const out: Poly = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!;
    const prev = poly[(i + poly.length - 1) % poly.length]!;
    const sc = side(cur);
    const sp = side(prev);
    const cross = () => {
      const t = sp / (sp - sc);
      return [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])] as Vec2;
    };
    if (sc >= 0) {
      if (sp < 0) out.push(cross());
      out.push(cur);
    } else if (sp >= 0) {
      out.push(cross());
    }
  }
  return out;
}

/** Drops repeated points (clipping a polygon along an edge it already has yields them); fewer than 3 left means nothing. */
function dedupe(poly: Poly): Poly {
  const out = poly.filter((p, i) => {
    const q = poly[(i + poly.length - 1) % poly.length]!;
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9;
  });
  return out.length >= 3 ? out : [];
}

/** Intersection of two convex polygons (the second counter-clockwise). */
function intersectConvex(subject: Poly, clip: Poly): Poly {
  let out = subject;
  for (let i = 0; i < clip.length && out.length > 0; i++) out = dedupe(clipHalf(out, clip[i]!, clip[(i + 1) % clip.length]!, 1));
  return out;
}

/** `subject` minus a convex counter-clockwise `clip`, as disjoint convex pieces. */
function subtractConvex(subject: Poly, clip: Poly): Poly[] {
  const pieces: Poly[] = [];
  let rest = subject;
  for (let i = 0; i < clip.length && rest.length >= 3; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= 1e-9) continue; // a repeated vertex: no line to cut along
    const outside = dedupe(clipHalf(rest, a, b, -1));
    if (outside.length >= 3 && polygonArea(outside) > MIN_PIECE_AREA) pieces.push(outside);
    rest = dedupe(clipHalf(rest, a, b, 1));
  }
  return pieces;
}

/** Overlap area of two simple polygons (concave allowed): the sum over triangle pairs, exact. */
export function polygonIntersectionArea(a: readonly Vec2[], b: readonly Vec2[]): number {
  const tb = triangleList(b);
  let area = 0;
  for (const subject of triangleList(a)) for (const clip of tb) area += polygonArea(intersectConvex(subject, clip));
  return area;
}

export interface ZoneLike {
  id: string;
  polygon: readonly Vec2[];
}

/** A problem with the zones of one room: `index` is the zone's position in the list, `field` where to point. */
export interface ZoneProblem {
  index: number;
  field: 'polygon' | 'id';
  message: string;
}

const perimeter = (poly: readonly Vec2[]): number =>
  poly.reduce((s, p, i) => {
    const q = poly[(i + 1) % poly.length]!;
    return s + Math.hypot(q[0] - p[0], q[1] - p[1]);
  }, 0);

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Inside the polygon, or within `ZONE_TOLERANCE` of its boundary. */
function insideWithin(p: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (distanceToSegment(p, a, b) <= ZONE_TOLERANCE) return true;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Whether the zone outline (sampled every 2 cm) stays inside the room polygon, within the tolerance everywhere. */
function outlineInside(zone: readonly Vec2[], room: readonly Vec2[]): boolean {
  for (let i = 0; i < zone.length; i++) {
    const a = zone[i]!;
    const b = zone[(i + 1) % zone.length]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.02));
    for (let k = 0; k <= steps; k++) {
      if (!insideWithin([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps], room)) return false;
    }
  }
  return true;
}

/**
 * What is wrong with a room's zones: duplicate ids, degenerate or self-intersecting polygons, a zone not
 * inside the room (area outside it beyond a `ZONE_TOLERANCE` wide strip along its edges) or two zones overlapping.
 */
export function zoneProblems(roomPolygon: readonly Vec2[], zones: readonly ZoneLike[]): ZoneProblem[] {
  const problems: ZoneProblem[] = [];
  const seen = new Set<string>();
  const sound: number[] = [];
  zones.forEach((zone, index) => {
    if (seen.has(zone.id)) problems.push({ index, field: 'id', message: `duplicate floor zone id "${zone.id}" in this room` });
    seen.add(zone.id);
    const area = polygonArea(zone.polygon);
    if (area < 1e-6) problems.push({ index, field: 'polygon', message: `floor zone "${zone.id}" has zero area` });
    else if (!isSimplePolygon(zone.polygon as Vec2[])) problems.push({ index, field: 'polygon', message: `floor zone "${zone.id}" polygon intersects itself` });
    else {
      const outside = area - polygonIntersectionArea(zone.polygon, roomPolygon);
      if (!outlineInside(zone.polygon, roomPolygon) || outside > ZONE_TOLERANCE * perimeter(zone.polygon) + 1e-9) {
        problems.push({ index, field: 'polygon', message: `floor zone "${zone.id}" is not inside the room (it leaves the room polygon by more than ${ZONE_TOLERANCE * 100} cm)` });
      }
      sound.push(index);
    }
  });
  for (let i = 0; i < sound.length; i++) {
    for (let j = i + 1; j < sound.length; j++) {
      const a = zones[sound[i]!]!;
      const b = zones[sound[j]!]!;
      const overlap = polygonIntersectionArea(a.polygon, b.polygon);
      if (overlap > ZONE_OVERLAP_AREA) {
        problems.push({ index: sound[j]!, field: 'polygon', message: `floor zone "${b.id}" overlaps zone "${a.id}" (${overlap.toFixed(2)} m²)` });
      }
    }
  }
  return problems;
}

/** Area (m²) of the part of the floor that no zone covers. */
export function remainderArea(room: Pick<Room, 'polygon' | 'floorZones'>): number {
  const zones = room.floorZones ?? [];
  const covered = zones.reduce((s, z) => s + polygonIntersectionArea(z.polygon, room.polygon), 0);
  return Math.max(0, polygonArea(room.polygon) - covered);
}

export interface FloorPart {
  /** Zone id, or undefined for the part of the floor outside every zone. */
  zoneId?: string;
  materialId: string;
  /** Convex polygons that tile the part, counter-clockwise in math axes (plan x right, plan y up the page's inverse; only the winding matters). */
  pieces: Poly[];
}

/**
 * Splits a room floor into its zones and the remainder, each with its material. The zone parts come first
 * (in zone order), the remainder (if any area is left) last. A zone lying exactly inside the room keeps its own
 * polygon (triangulated); a zone poking out within the tolerance is clipped to the room, so the parts always tile
 * the room polygon exactly: zone areas plus the remainder area equal the room area.
 */
export function floorParts(scene: Pick<Scene, 'defaults'>, room: Room): FloorPart[] {
  const zones = room.floorZones ?? [];
  const roomTris = triangleList(room.polygon);
  if (zones.length === 0) return [{ materialId: floorMaterial(scene, room), pieces: roomTris }];

  const cuts: Poly[] = [];
  const parts: FloorPart[] = zones.map((zone) => {
    // A convex zone (a rectangle, usually) is one convex piece: it cuts the rest of the floor once, in few pieces.
    const base = isConvex(zone.polygon) ? [ccw(zone.polygon.slice())] : triangleList(zone.polygon);
    const inside = polygonArea(zone.polygon) - polygonIntersectionArea(zone.polygon, room.polygon) <= 1e-9;
    const pieces = inside ? base : base.flatMap((t) => roomTris.map((r) => intersectConvex(t, r))).filter((p) => p.length >= 3 && polygonArea(p) > MIN_PIECE_AREA);
    cuts.push(...pieces);
    return { zoneId: zone.id, materialId: zone.material, pieces };
  });

  let rest = roomTris;
  for (const cut of cuts) rest = rest.flatMap((p) => subtractConvex(p, cut));
  if (rest.length > 0) parts.push({ materialId: floorMaterial(scene, room), pieces: rest });
  return parts;
}
