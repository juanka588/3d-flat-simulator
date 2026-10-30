import type { Opening, Room, Scene, Vec2, Wall } from '../schema';
import { wallLeftNormal, wallLength } from '../schema';
import { isPassable } from '../collision';
import { pointInPolygon } from '../validate';

/**
 * Clearance zones of openings, as convex plan polygons (D7):
 *  - a DOOR swings a quarter disc: centre at the hinge on the wall face, radius the opening width, from the
 *    closed leaf (along the wall, towards the other jamb) to the open leaf (perpendicular, on the `swing`
 *    side). `hinge` is `start` (the jamb with the smaller offset, default) or `end`; `swing` is `left` or
 *    `right` of `wallLeftNormal` (default `left`), exactly as `buildFittings` draws the leaf;
 *  - the ENTRY door (a door with a room on one side only) also keeps a 0.9 m deep landing, door wide, on its room side;
 *  - a door also keeps a door-wide, 0.6 m deep `approach` rectangle on the side it does NOT swing to (non-entry doors;
 *    the entry landing already covers both sides), and every passable opening has a thin `span` slab on both faces that
 *    wall mounts (pictures, shelves) must stay out of;
 *  - a PASSAGE keeps a rectangle (its width, 0.6 m deep) on every room side;
 *  - a WINDOW (and any glazed opening) has a 0.3 m deep strip in front, used for the sill / glazing rules.
 */

export const LANDING_DEPTH_M = 0.9;
export const PASSAGE_DEPTH_M = 0.6;
export const GLAZING_STRIP_M = 0.3;
/** Depth of the keep-out rectangle on the non-swing side of a door (door wide). */
export const APPROACH_DEPTH_M = 0.6;
/** The approach is a comfort margin, not a leaf sweep: a footprint may brush it by this much (a 0.7 m toilet in a 1.28 m WC). */
const APPROACH_TOLERANCE_M = 0.03;
/** Depth of the doorway slab (wall thickness plus this on each face) wall mounts must stay out of. */
const SPAN_MARGIN_M = 0.08;
/** Segments of the quarter-circle arc. */
const ARC_STEPS = 12;

export type ZoneKind = 'swing' | 'landing' | 'passage' | 'approach' | 'span' | 'window' | 'glass' | 'heater';

export interface Zone {
  kind: ZoneKind;
  openingId: string;
  wallId: string;
  /** Convex polygon in plan. */
  polygon: Vec2[];
  /** Height range the zone occupies: items entirely above `hi` or below `lo` are clear of it. */
  lo: number;
  hi: number;
  /** `heater` zones: `openingId` is the id of the radiator item. */
  /** `window` zones: sill height (items must stay under `sill - 0.02`). */
  sill?: number;
  /** Penetration (m) below which a footprint only brushes the zone; default `TOUCH_TOLERANCE`. */
  tolerance?: number;
}

export interface OpeningFrame {
  wall: Wall;
  centre: Vec2;
  /** Unit vector along the wall (start -> end). */
  dir: Vec2;
  /** Unit normal to the wall's left. */
  left: Vec2;
  leftRoom?: Room;
  rightRoom?: Room;
}

export function openingFrame(scene: Pick<Scene, 'walls' | 'rooms'>, opening: Opening): OpeningFrame | undefined {
  const wall = scene.walls.find((w) => w.id === opening.wallId);
  if (!wall) return undefined;
  const len = wallLength(wall);
  if (len < 1e-9) return undefined;
  const dir: Vec2 = [(wall.end[0] - wall.start[0]) / len, (wall.end[1] - wall.start[1]) / len];
  const left = wallLeftNormal(wall);
  const centre: Vec2 = [wall.start[0] + dir[0] * opening.offset, wall.start[1] + dir[1] * opening.offset];
  const d = wall.thickness / 2 + 0.05;
  const find = (sign: number) => {
    const p: Vec2 = [centre[0] + sign * left[0] * d, centre[1] + sign * left[1] * d];
    return scene.rooms.find((r) => pointInPolygon(p, r.polygon, 1e-6));
  };
  const leftRoom = find(1);
  const rightRoom = find(-1);
  return { wall, centre, dir, left, ...(leftRoom ? { leftRoom } : {}), ...(rightRoom ? { rightRoom } : {}) };
}

/** Quarter-disc polygon swept by a door leaf (convex: hinge, then points along the arc). */
export function doorSwingPolygon(f: OpeningFrame, opening: Opening): Vec2[] {
  const half = opening.width / 2;
  const hingeStart = (opening.hinge ?? 'start') === 'start';
  const sign = hingeStart ? -1 : 1;
  const u: Vec2 = hingeStart ? f.dir : [-f.dir[0], -f.dir[1]];
  const swingLeft = (opening.swing ?? 'left') === 'left';
  const v: Vec2 = swingLeft ? f.left : [-f.left[0], -f.left[1]];
  const t = f.wall.thickness / 2;
  const hx = f.centre[0] + sign * f.dir[0] * half + v[0] * t;
  const hy = f.centre[1] + sign * f.dir[1] * half + v[1] * t;
  const r = opening.width;
  const out: Vec2[] = [[hx, hy]];
  for (let i = 0; i <= ARC_STEPS; i++) {
    const phi = (i / ARC_STEPS) * (Math.PI / 2);
    const c = Math.cos(phi) * r;
    const s = Math.sin(phi) * r;
    out.push([hx + c * u[0] + s * v[0], hy + c * u[1] + s * v[1]]);
  }
  return out;
}

/** Rectangle `width` wide, from the wall centreline out to `t/2 + depth` on the side of `normal`. */
function sideRect(f: OpeningFrame, width: number, depth: number, normal: Vec2): Vec2[] {
  const half = width / 2;
  const far = f.wall.thickness / 2 + depth;
  const c = f.centre;
  const d = f.dir;
  return [
    [c[0] - d[0] * half, c[1] - d[1] * half],
    [c[0] + d[0] * half, c[1] + d[1] * half],
    [c[0] + d[0] * half + normal[0] * far, c[1] + d[1] * half + normal[1] * far],
    [c[0] - d[0] * half + normal[0] * far, c[1] - d[1] * half + normal[1] * far],
  ];
}

/** True for a door that leads out of the flat: a room on one side only. */
export function isEntryDoor(opening: Opening, f: OpeningFrame): boolean {
  return opening.type === 'door' && (f.leftRoom === undefined) !== (f.rightRoom === undefined);
}

/** Every clearance zone of the scene's openings, in opening order. */
export function openingZones(scene: Pick<Scene, 'walls' | 'rooms' | 'openings'>): Zone[] {
  const zones: Zone[] = [];
  const neg = (n: Vec2): Vec2 => [-n[0], -n[1]];
  for (const o of scene.openings) {
    const f = openingFrame(scene, o);
    if (!f) continue;
    const sides: { normal: Vec2; room: Room | undefined }[] = [
      { normal: f.left, room: f.leftRoom },
      { normal: neg(f.left), room: f.rightRoom },
    ];
    const base = { openingId: o.id, wallId: o.wallId };
    if (o.type === 'door') {
      const top = o.sill + o.height;
      zones.push({ ...base, kind: 'swing', polygon: doorSwingPolygon(f, o), lo: 0, hi: top });
      if (isEntryDoor(o, f)) {
        for (const s of sides) if (s.room) zones.push({ ...base, kind: 'landing', polygon: sideRect(f, o.width, LANDING_DEPTH_M, s.normal), lo: 0, hi: top });
      } else {
        const swingNormal = (o.swing ?? 'left') === 'left' ? f.left : neg(f.left);
        for (const s of sides) {
          if (!s.room || (s.normal[0] === swingNormal[0] && s.normal[1] === swingNormal[1])) continue;
          zones.push({ ...base, kind: 'approach', polygon: sideRect(f, o.width, APPROACH_DEPTH_M, s.normal), lo: 0, hi: top, tolerance: APPROACH_TOLERANCE_M });
        }
      }
    } else if (o.type === 'passage') {
      for (const s of sides) if (s.room) zones.push({ ...base, kind: 'passage', polygon: sideRect(f, o.width, PASSAGE_DEPTH_M, s.normal), lo: 0, hi: o.sill + o.height });
    }
    if (isPassable(o)) {
      for (const s of sides) zones.push({ ...base, kind: 'span', polygon: sideRect(f, o.width, SPAN_MARGIN_M, s.normal), lo: 0, hi: o.sill + o.height });
    }
    const glazed = o.glazed ?? o.type === 'window';
    if (o.type === 'window') {
      for (const s of sides) {
        if (s.room) zones.push({ ...base, kind: 'window', polygon: sideRect(f, o.width, GLAZING_STRIP_M, s.normal), lo: o.sill, hi: o.sill + o.height, sill: o.sill });
      }
    } else if (glazed) {
      for (const s of sides) {
        if (s.room) zones.push({ ...base, kind: 'glass', polygon: sideRect(f, o.width, GLAZING_STRIP_M, s.normal), lo: o.sill, hi: o.sill + o.height, sill: o.sill });
      }
    }
  }
  return zones;
}
