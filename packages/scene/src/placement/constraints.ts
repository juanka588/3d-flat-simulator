import { wallObstacles } from '../collision';
import { roomCeilingHeight } from '../geometry/floors';
import type { Dims, ItemMount } from '../primitives';
import { HEAVY_MOUNT_KG, type ProductCategory } from '../products';
import type { Room, Scene, Vec2, Wall } from '../schema';
import { wallLength } from '../schema';
import { structuralInfo } from '../structural';
import { distanceToSegment, pointInPolygon } from '../validate';
import {
  boundsOf,
  boundsTouch,
  boxOfItem,
  FLAT_MAX_H,
  footprintOf,
  frontOf,
  overlaps,
  segmentRect,
  type Bounds,
  type ItemBox,
} from './footprint';
import { openingZones, type Zone } from './swing';
import { VIOLATION_HINTS, type Violation, type ViolationCode } from './types';

/**
 * Hard constraints of D7 as pure checks over a `LayoutContext` (everything derived once per scene).
 * A check returns violations; none of them throws or mutates.
 */

/** Slack for "inside the room" and "flush with a wall" tests, in metres. */
export const ROOM_TOLERANCE = 0.003;
/** Items may stand under a window only when their top is at most this far below the sill. */
export const SILL_MARGIN = 0.02;
/** Vertical slack when comparing item heights, in metres. */
export const HEIGHT_TOLERANCE = 0.01;
/** A wall mount counts as mounted on the wall whose face is at most this far behind its back. */
const MOUNT_REACH = 0.12;
/** A wall mount further from every wall than `MOUNT_REACH` is still taken to hang on the nearest wall within this reach. */
const MOUNT_FAR_REACH = 1;
/** Wall-mounted categories that are typically heavier than `HEAVY_MOUNT_KG`: a missing weight deserves a warning. */
export const TYPICALLY_HEAVY_CATEGORIES: readonly ProductCategory[] = ['wall_cabinet', 'shelf', 'tv_unit', 'sideboard', 'kitchen'];

export interface RoomInfo {
  room: Room;
  bounds: Bounds;
  /** Ceiling height in metres; `Infinity` for open-air rooms (a balcony with no explicit ceiling). */
  ceiling: number;
}

export interface WallPiece {
  wallId: string;
  polygon: Vec2[];
  bounds: Bounds;
  height: number;
}

export interface LayoutContext {
  scene: Scene;
  rooms: Map<string, RoomInfo>;
  walls: WallPiece[];
  boxes: ItemBox[];
  zones: Zone[];
}

const cache = new WeakMap<Scene, LayoutContext>();

/** Derives (and caches per scene object) the geometry the rules need. Scenes are immutable by convention. */
export function layoutContext(scene: Scene): LayoutContext {
  const hit = cache.get(scene);
  if (hit) return hit;
  const heights = new Map(scene.walls.map((w) => [w.id, w.height]));
  const rooms = new Map<string, RoomInfo>();
  for (const room of scene.rooms) {
    rooms.set(room.id, {
      room,
      bounds: boundsOf(room.polygon),
      ceiling: room.type === 'balcony' && room.ceilingHeight === undefined ? Infinity : roomCeilingHeight(scene, room),
    });
  }
  const walls: WallPiece[] = wallObstacles(scene).map((o) => {
    const polygon = segmentRect(o.a, o.b, o.halfThickness);
    return { wallId: o.wallId, polygon, bounds: boundsOf(polygon), height: heights.get(o.wallId) ?? 0 };
  });
  const ctx: LayoutContext = {
    scene,
    rooms,
    walls,
    boxes: scene.items.map((it, i) => boxOfItem(it, i)),
    zones: openingZones(scene),
  };
  cache.set(scene, ctx);
  return ctx;
}

/** Room an item belongs to: its `roomId`, else the first room containing its position. */
export function roomOfBox(ctx: LayoutContext, box: ItemBox): RoomInfo | undefined {
  if (box.roomId !== undefined) return ctx.rooms.get(box.roomId);
  for (const info of ctx.rooms.values()) if (pointInPolygon(box.position, info.room.polygon, ROOM_TOLERANCE)) return info;
  return undefined;
}

/** What is being tested: a new item, or an existing one at a new pose. */
export interface Subject {
  /** Id of the item itself, so it is not an obstacle to itself. */
  id?: string;
  roomId: string;
  position: Vec2;
  rotation: number;
  elevation: number;
  dims: Dims;
  mount: ItemMount;
  weightKg?: number;
  /** Product category, used to warn when a typically heavy wall mount has no weight. */
  category?: ProductCategory;
  acknowledgeHeavyPartition?: boolean;
}

export const violation = (code: ViolationCode, message: string, entityIds: string[], hint: string = VIOLATION_HINTS[code]): Violation => ({ code, message, entityIds, hint });

const label = (s: Subject) => (s.id ? `"${s.id}"` : 'the item');
const f2 = (n: number) => (Math.round(n * 100) / 100).toString();

// ---- inside the room ---------------------------------------------------------------------------------

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  const eps = 1e-9;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

/** Whole footprint inside the room polygon (concave rooms included). */
export function footprintInsideRoom(footprint: readonly Vec2[], polygon: readonly Vec2[], tolerance = ROOM_TOLERANCE): boolean {
  for (const c of footprint) if (!pointInPolygon(c, polygon, tolerance)) return false;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const p = polygon[i]!;
    const q = polygon[(i + 1) % n]!;
    for (let k = 0; k < 4; k++) {
      if (segmentsCross(p, q, footprint[k]!, footprint[(k + 1) % 4]!)) {
        // a crossing that is only a graze of a corner within the tolerance is not an escape
        const near = Math.min(distanceToSegment(footprint[k]!, p, q), distanceToSegment(footprint[(k + 1) % 4]!, p, q));
        if (near > tolerance) return false;
      }
    }
  }
  // a room corner poking into the footprint (reflex vertex)
  const o = footprint[0]!;
  const ex: Vec2 = [footprint[1]![0] - o[0], footprint[1]![1] - o[1]];
  const ez: Vec2 = [footprint[3]![0] - o[0], footprint[3]![1] - o[1]];
  const lx = Math.hypot(ex[0], ex[1]);
  const lz = Math.hypot(ez[0], ez[1]);
  for (const v of polygon) {
    const dx = v[0] - o[0];
    const dy = v[1] - o[1];
    const u = (dx * ex[0] + dy * ex[1]) / lx;
    const w = (dx * ez[0] + dy * ez[1]) / lz;
    if (u > tolerance && u < lx - tolerance && w > tolerance && w < lz - tolerance) return false;
  }
  return true;
}

export function checkInside(ctx: LayoutContext, s: Subject, footprint: Vec2[]): Violation[] {
  const info = ctx.rooms.get(s.roomId);
  if (!info) return [violation('outside_room', `unknown room "${s.roomId}"`, [s.roomId])];
  const out: Violation[] = [];
  if (!footprintInsideRoom(footprint, info.room.polygon)) {
    out.push(
      violation('outside_room', `${label(s)} (${f2(s.dims.w)} x ${f2(s.dims.d)} m) does not fit inside "${info.room.name}"`, [info.room.id], 'Keep the whole footprint inside the room; pick another wall, a smaller product or call get_placement_options.'),
    );
  }
  if (s.elevation + s.dims.h > info.ceiling + HEIGHT_TOLERANCE) {
    out.push(
      violation(
        'outside_room',
        `${label(s)} reaches ${f2(s.elevation + s.dims.h)} m but the ceiling of "${info.room.name}" is ${f2(info.ceiling)} m`,
        [info.room.id],
        'The item is taller than the room allows; pick a lower product or lower the mount height.',
      ),
    );
  }
  return out;
}

// ---- overlap ---------------------------------------------------------------------------------------

export function wallsOverlapping(ctx: LayoutContext, footprint: readonly Vec2[], bounds: Bounds, bottom: number): string[] {
  const ids: string[] = [];
  for (const w of ctx.walls) {
    if (bottom >= w.height - HEIGHT_TOLERANCE) continue;
    if (!boundsTouch(bounds, w.bounds)) continue;
    if (overlaps(footprint, w.polygon) && !ids.includes(w.wallId)) ids.push(w.wallId);
  }
  return ids;
}

/** Two boxes collide when their footprints overlap and their height ranges overlap; floor coverings (rugs) never collide with furniture. */
export function boxesCollide(a: Pick<ItemBox, 'footprint' | 'bounds' | 'bottom' | 'top' | 'flat'>, b: ItemBox): boolean {
  if (a.flat !== b.flat) return false;
  if (!(a.bottom < b.top - HEIGHT_TOLERANCE && b.bottom < a.top - HEIGHT_TOLERANCE)) return false;
  if (!boundsTouch(a.bounds, b.bounds)) return false;
  return overlaps(a.footprint, b.footprint);
}

export function itemsOverlapping(ctx: LayoutContext, subject: Pick<ItemBox, 'footprint' | 'bounds' | 'bottom' | 'top' | 'flat'>, ignoreId: string | undefined, accept: (b: ItemBox) => boolean = () => true): string[] {
  const ids: string[] = [];
  for (const b of ctx.boxes) {
    if (b.id === ignoreId || !accept(b)) continue;
    if (boxesCollide(subject, b)) ids.push(b.id);
  }
  return ids;
}

export function checkOverlap(ctx: LayoutContext, s: Subject, box: Pick<ItemBox, 'footprint' | 'bounds' | 'bottom' | 'top' | 'flat'>): Violation[] {
  const walls = wallsOverlapping(ctx, box.footprint, box.bounds, box.bottom);
  const items = itemsOverlapping(ctx, box, s.id);
  if (walls.length === 0 && items.length === 0) return [];
  const parts = [...walls.map((w) => `wall "${w}"`), ...items.map((i) => `item "${i}"`)];
  return [violation('overlap', `${label(s)} overlaps ${parts.join(', ')}`, [...walls, ...items])];
}

// ---- openings ----------------------------------------------------------------------------------------

export function checkZones(ctx: LayoutContext, s: Subject, box: Pick<ItemBox, 'footprint' | 'bounds' | 'bottom' | 'top' | 'flat'>, only: 'all' | 'swing' = 'all'): Violation[] {
  const swing: string[] = [];
  const windows: string[] = [];
  const glazing: string[] = [];
  const wallMount = s.mount === 'wall';
  // ceiling lights hang far above any sill: the window rules are for things standing or hanging on walls
  const ceilingMount = s.mount === 'ceiling';
  for (const z of ctx.zones) {
    const clear = z.kind === 'swing' || z.kind === 'landing' || z.kind === 'passage' || z.kind === 'approach' || z.kind === 'span';
    if (only === 'swing' && !clear) continue;
    if (clear) {
      if (z.kind === 'span' && !wallMount) continue;
      if (box.flat || box.bottom >= z.hi - HEIGHT_TOLERANCE) continue;
      if (zoneHit(box, z) && !swing.includes(z.openingId)) swing.push(z.openingId);
    } else if (z.kind === 'window') {
      if (wallMount) {
        if (box.bottom < z.hi - HEIGHT_TOLERANCE && box.top > z.lo + HEIGHT_TOLERANCE && zoneHit(box, z) && !glazing.includes(z.openingId)) glazing.push(z.openingId);
      } else if (!ceilingMount && !box.flat && box.top > z.lo - SILL_MARGIN + 1e-9 && box.bottom < z.hi - HEIGHT_TOLERANCE && zoneHit(box, z) && !windows.includes(z.openingId)) {
        windows.push(z.openingId);
      }
    } else if (wallMount && box.bottom < z.hi - HEIGHT_TOLERANCE && box.top > z.lo + HEIGHT_TOLERANCE && zoneHit(box, z) && !glazing.includes(z.openingId)) {
      glazing.push(z.openingId);
    }
  }
  const out: Violation[] = [];
  if (swing.length) {
    out.push(violation('door_swing_blocked', `${label(s)} blocks the swing, landing or doorway of ${swing.map((x) => `"${x}"`).join(', ')}`, swing));
  }
  if (windows.length) {
    out.push(
      violation(
        'window_blocked',
        `${label(s)} is ${f2(s.elevation + s.dims.h)} m high, above the sill of ${windows.map((x) => `"${x}"`).join(', ')}`,
        windows,
        'Only items lower than the window sill can stand under a window; use a lower product or another wall.',
      ),
    );
  }
  if (glazing.length) {
    out.push(violation('glazing_blocked', `${label(s)} would hang over the glazing of ${glazing.map((x) => `"${x}"`).join(', ')}`, glazing));
  }
  return out;
}

function zoneHit(box: Pick<ItemBox, 'footprint'>, z: Zone): boolean {
  return overlaps(box.footprint, z.polygon, z.tolerance);
}

// ---- heavy wall mounts -------------------------------------------------------------------------------

/** The wall a wall-mounted item hangs on: the one whose face is closest behind its back (within `MOUNT_REACH`). */
export function mountWall(scene: Scene, s: Pick<Subject, 'position' | 'rotation' | 'dims'>, reach: number = MOUNT_REACH): Wall | undefined {
  const n = frontOf(s.rotation);
  const p: Vec2 = [s.position[0] - n[0] * (s.dims.d / 2 + 0.01), s.position[1] - n[1] * (s.dims.d / 2 + 0.01)];
  let best: Wall | undefined;
  let bestD = reach;
  for (const w of scene.walls) {
    if (wallLength(w) < 1e-9) continue;
    const d = distanceToSegment(p, w.start, w.end) - w.thickness / 2;
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

export function checkHeavy(ctx: LayoutContext, s: Subject): { violations: Violation[]; warnings: Violation[] } {
  if (s.mount !== 'wall') return { violations: [], warnings: [] };
  if (s.weightKg === undefined) {
    if (s.category === undefined || !TYPICALLY_HEAVY_CATEGORIES.includes(s.category)) return { violations: [], warnings: [] };
    const near = mountWall(ctx.scene, s, MOUNT_FAR_REACH);
    return {
      violations: [],
      warnings: [
        violation(
          'weight_unknown',
          `${label(s)} is a wall-mounted ${s.category.replace('_', ' ')} with no weight: ${near ? `check that wall "${near.id}" can carry it` : 'check that its wall can carry it'} (items over ${HEAVY_MOUNT_KG} kg need a structural wall)`,
          near ? [near.id] : [],
        ),
      ],
    };
  }
  if (s.weightKg <= HEAVY_MOUNT_KG) return { violations: [], warnings: [] };
  // a wall mount far from every wall (stand-off brackets, a mis-set depth) still hangs on the nearest one
  const wall = mountWall(ctx.scene, s) ?? mountWall(ctx.scene, s, MOUNT_FAR_REACH);
  if (!wall) return { violations: [], warnings: [] };
  const info = structuralInfo(ctx.scene, wall);
  if (info.structural) return { violations: [], warnings: [] };
  const v = violation(
    'heavy_mount_partition',
    `${label(s)} weighs ${f2(s.weightKg)} kg (over ${HEAVY_MOUNT_KG} kg) and would hang on wall "${wall.id}", a ${f2(wall.thickness * 100)} cm partition`,
    [wall.id],
  );
  return s.acknowledgeHeavyPartition ? { violations: [], warnings: [v] } : { violations: [v], warnings: [] };
}

// ---- everything cheap ---------------------------------------------------------------------------------

export interface CheckResult {
  violations: Violation[];
  warnings: Violation[];
}

/** Which rule families `checkSubject` runs. */
export type Rule = 'inside' | 'overlap' | 'swing' | 'openings' | 'heavy';
export const ALL_RULES: readonly Rule[] = ['inside', 'overlap', 'openings', 'heavy'];
/** The rules the command reducer enforces: inside the room, no overlap, door swings (no window / glazing / weight rules; no walkway raster). */
export const CHEAP_RULES: readonly Rule[] = ['inside', 'overlap', 'swing'];

export function subjectBox(s: Subject): ItemBox {
  const b = {
    id: s.id ?? '',
    index: -1,
    roomId: s.roomId,
    position: s.position,
    rotation: s.rotation,
    elevation: s.elevation,
    dims: s.dims,
    mount: s.mount,
    locked: false,
    flat: s.mount === 'floor' && s.dims.h <= FLAT_MAX_H,
    footprint: footprintOf(s.position, s.rotation, s.dims),
    bottom: s.elevation,
    top: s.elevation + s.dims.h,
  };
  return { ...b, bounds: boundsOf(b.footprint) };
}

/** Runs the rule families (default all) in a fixed order: inside, overlap, openings, heavy. */
export function checkSubject(ctx: LayoutContext, s: Subject, rules: readonly Rule[] = ALL_RULES): CheckResult {
  const box = subjectBox(s);
  const violations: Violation[] = [];
  const warnings: Violation[] = [];
  if (rules.includes('inside')) violations.push(...checkInside(ctx, s, box.footprint));
  if (rules.includes('overlap')) violations.push(...checkOverlap(ctx, s, box));
  if (rules.includes('openings')) violations.push(...checkZones(ctx, s, box));
  else if (rules.includes('swing')) violations.push(...checkZones(ctx, s, box, 'swing'));
  if (rules.includes('heavy')) {
    const h = checkHeavy(ctx, s);
    violations.push(...h.violations);
    warnings.push(...h.warnings);
  }
  return { violations, warnings };
}

