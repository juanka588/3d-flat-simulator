import { polygonCentroid } from '../measure';
import type { Dims } from '../primitives';
import type { Room, Scene, Vec2, Wall } from '../schema';
import { wallLeftNormal, wallLength } from '../schema';
import { pointInPolygon } from '../validate';
import { itemDims } from './footprint';
import { localToPlan, rotationFacing, round4 } from './footprint';
import { openingFrame } from './swing';
import { defaultOffset, spotOn, standsOnHint, supportTop, whyNotOn } from './support';
import { violation } from './constraints';
import type { Relation, Violation } from './types';

/**
 * Turns a `Relation` into a concrete pose (position and rotation). Pure; the result still has to pass the
 * hard constraints. A relation that cannot hold (unknown ids, a corner that is not a wall corner, ...) is an
 * `invalid_relation` violation, never an exception.
 */

/** Side of a room edge to wall stretches: tolerance of the "edge lies on the wall" test, metres. */
const EDGE_TOLERANCE = 0.03;
const MIN_EDGE_OVERLAP = 0.1;

/** A stretch of a wall that borders a room: the room polygon edge that runs along it. */
export interface WallEdge {
  wall: Wall;
  /** Along-wall coordinates (metres from `wall.start`) of the stretch, `lo < hi`. */
  lo: number;
  hi: number;
  /** Unit vector along the wall (start -> end). */
  dir: Vec2;
  /** Point of the room-edge line at along-coordinate 0. */
  origin: Vec2;
  /** Unit normal pointing from the wall into the room. */
  inward: Vec2;
}

export const pointAt = (e: WallEdge, s: number): Vec2 => [e.origin[0] + e.dir[0] * s, e.origin[1] + e.dir[1] * s];

/** Every stretch of every wall that borders `room`, longest first within a wall; deterministic order (polygon edge order). */
export function roomWallEdges(scene: Pick<Scene, 'walls'>, room: Room): WallEdge[] {
  const out: WallEdge[] = [];
  const poly = room.polygon;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    for (const wall of scene.walls) {
      const len = wallLength(wall);
      if (len < 1e-9) continue;
      const n = wallLeftNormal(wall);
      const dir: Vec2 = [(wall.end[0] - wall.start[0]) / len, (wall.end[1] - wall.start[1]) / len];
      const band = wall.thickness / 2 + EDGE_TOLERANCE;
      const off = (p: Vec2) => (p[0] - wall.start[0]) * n[0] + (p[1] - wall.start[1]) * n[1];
      const along = (p: Vec2) => (p[0] - wall.start[0]) * dir[0] + (p[1] - wall.start[1]) * dir[1];
      const da = off(a);
      const db = off(b);
      if (Math.abs(da) > band || Math.abs(db) > band) continue;
      const lo = Math.max(0, Math.min(along(a), along(b)));
      const hi = Math.min(len, Math.max(along(a), along(b)));
      if (hi - lo < MIN_EDGE_OVERLAP) continue;
      const offset = (da + db) / 2;
      const origin: Vec2 = [wall.start[0] + n[0] * offset, wall.start[1] + n[1] * offset];
      const mid: Vec2 = [origin[0] + dir[0] * ((lo + hi) / 2), origin[1] + dir[1] * ((lo + hi) / 2)];
      let inward: Vec2 | undefined;
      if (pointInPolygon([mid[0] + n[0] * 0.04, mid[1] + n[1] * 0.04], poly, 0)) inward = n;
      else if (pointInPolygon([mid[0] - n[0] * 0.04, mid[1] - n[1] * 0.04], poly, 0)) inward = [-n[0], -n[1]];
      if (!inward) continue;
      out.push({ wall, lo, hi, dir, origin, inward });
    }
  }
  return out;
}

/** The longest stretch of `wallId` bordering the room (ties: first in polygon order). */
export function edgeOnWall(edges: readonly WallEdge[], wallId: string): WallEdge | undefined {
  let best: WallEdge | undefined;
  for (const e of edges) if (e.wall.id === wallId && (!best || e.hi - e.lo > best.hi - best.lo + 1e-9)) best = e;
  return best;
}

export type Align = 'start' | 'center' | 'end';

/** Along-wall centre of an item of width `w` aligned in `[lo, hi]`; `offset` is ignored for `center`. */
export function alongCentre(lo: number, hi: number, w: number, align: Align, offset: number): number {
  if (align === 'start') return lo + offset + w / 2;
  if (align === 'end') return hi - offset - w / 2;
  return (lo + hi) / 2;
}

/** Pose of an item flush against a wall stretch: back on the room edge (plus `gap`), facing into the room. */
export function poseAgainst(e: WallEdge, dims: Dims, s: number, gap: number): { position: Vec2; rotation: number } {
  const c = pointAt(e, s);
  const k = dims.d / 2 + gap;
  return { position: [round4(c[0] + e.inward[0] * k), round4(c[1] + e.inward[1] * k)], rotation: rotationFacing(e.inward) };
}

const COMPASS_WORD = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;

/** Word for a plan direction given `site.northAngle` (clockwise from plan up to north). */
export function compassWord(dir: Vec2, northAngle: number): (typeof COMPASS_WORD)[number] {
  const heading = (Math.atan2(dir[0], -dir[1]) * 180) / Math.PI;
  const bearing = (((heading - northAngle) % 360) + 360) % 360;
  return COMPASS_WORD[Math.round(bearing / 45) % 8]!;
}

export interface Resolved {
  position: Vec2;
  rotation: number;
  /** Set when the relation fixes the height (`at`). */
  elevation?: number;
  /** The relation with every default filled in. */
  relation: Relation;
  rationale: string[];
}

export type Resolution = { ok: true; target: Resolved } | { ok: false; violation: Violation };

const bad = (message: string, ids: string[], hint?: string): Resolution => ({ ok: false, violation: violation('invalid_relation', message, ids, hint) });

export interface ResolveInput {
  scene: Scene;
  room: Room;
  dims: Dims;
  /** The item being moved, when there is one (its pose is the base of `facing`, `centered_in` on one axis). */
  itemId?: string;
  /** Product category of the item, for the rules of "on" (what may stand on what). */
  category?: string;
  /** How the item is fixed; only floor items stand on other items. */
  mount?: string;
  relation: Relation;
}

const wallsHint = (scene: Scene, room: Room): string =>
  `walls bordering "${room.id}": ${
    [...new Set(roomWallEdges(scene, room).map((e) => e.wall.id))].join(', ') || 'none'
  }`;

export function resolveRelation(input: ResolveInput): Resolution {
  const { scene, room, dims, relation } = input;
  const north = scene.site.northAngle;
  switch (relation.kind) {
    case 'against_wall': {
      if (relation.roomId !== undefined && relation.roomId !== room.id) {
        return bad(`relation names room "${relation.roomId}" but the item goes in "${room.id}"`, [relation.roomId, room.id], 'Use the same room in the request and in against_wall.roomId.');
      }
      const edge = edgeOnWall(roomWallEdges(scene, room), relation.wallId);
      if (!edge) {
        const known = scene.walls.some((w) => w.id === relation.wallId);
        return bad(
          known ? `wall "${relation.wallId}" does not border room "${room.id}"` : `unknown wall "${relation.wallId}"`,
          [relation.wallId, room.id],
          wallsHint(scene, room),
        );
      }
      const align = relation.align;
      const s = alongCentre(edge.lo, edge.hi, dims.w, align, relation.offset);
      const pose = poseAgainst(edge, dims, s, relation.gap);
      const side = compassWord(edge.inward.map((v) => -v) as Vec2, north);
      const rationale = [`against the ${side} wall (${edge.wall.id}), facing into the room`];
      if (align === 'center') rationale.push('centred on that stretch of wall');
      else rationale.push(`${align === 'start' ? 'from the start' : 'from the end'} of the wall${relation.offset > 0 ? `, ${round4(relation.offset)} m in` : ''}`);
      return { ok: true, target: { ...pose, relation, rationale } };
    }
    case 'in_corner': {
      if (relation.roomId !== room.id) {
        return bad(`relation names room "${relation.roomId}" but the item goes in "${room.id}"`, [relation.roomId, room.id], 'Use the same room in the request and in in_corner.roomId.');
      }
      const poly = room.polygon;
      const n = poly.length;
      if (relation.corner >= n) return bad(`room "${room.id}" has ${n} corners (0-${n - 1}); corner ${relation.corner} does not exist`, [room.id], `corner is an index into rooms[].polygon (0-${n - 1})`);
      const v = poly[relation.corner]!;
      const prev = poly[(relation.corner + n - 1) % n]!;
      const next = poly[(relation.corner + 1) % n]!;
      const edges = roomWallEdges(scene, room);
      const onEdge = (p: Vec2, q: Vec2) =>
        edges.find((e) => {
          const off = (x: Vec2) => (x[0] - e.origin[0]) * e.inward[0] + (x[1] - e.origin[1]) * e.inward[1];
          return Math.abs(off(p)) < 0.02 && Math.abs(off(q)) < 0.02;
        });
      const eIn = onEdge(prev, v);
      const eOut = onEdge(v, next);
      if (!eIn || !eOut) {
        return bad(`corner ${relation.corner} of "${room.id}" is not formed by two walls (an edge has no wall behind it)`, [room.id], 'Pick a corner where two walls meet.');
      }
      const dIn: Vec2 = [v[0] - prev[0], v[1] - prev[1]];
      const dOut: Vec2 = [next[0] - v[0], next[1] - v[1]];
      const lIn = Math.hypot(dIn[0], dIn[1]);
      const lOut = Math.hypot(dOut[0], dOut[1]);
      const cos = (dIn[0] * dOut[0] + dIn[1] * dOut[1]) / (lIn * lOut);
      // inward normals of both walls must be perpendicular and point at each other's side: a convex 90 degree corner
      const perpendicular = Math.abs(eIn.inward[0] * eOut.inward[0] + eIn.inward[1] * eOut.inward[1]) < 0.05;
      let area2 = 0;
      for (let k = 0; k < n; k++) area2 += poly[k]![0] * poly[(k + 1) % n]![1] - poly[(k + 1) % n]![0] * poly[k]![1];
      const convex = (dIn[0] * dOut[1] - dIn[1] * dOut[0]) * area2 > 0;
      if (Math.abs(cos) > 0.05 || !perpendicular || !convex) {
        return bad(
          `corner ${relation.corner} of "${room.id}" is not a 90 degree inside corner between ${eIn.wall.id} and ${eOut.wall.id}`,
          [room.id, eIn.wall.id, eOut.wall.id],
          'in_corner needs two adjacent walls meeting at a convex right angle; check the corner index or use against_wall.',
        );
      }
      // back to the longer wall (the item's width runs along it), side flush with the shorter wall
      const longIn = lIn >= lOut;
      const back = longIn ? eIn : eOut;
      const side = longIn ? eOut : eIn;
      const k = relation.gap;
      const pos: Vec2 = [
        v[0] + back.inward[0] * (dims.d / 2 + k) + side.inward[0] * (dims.w / 2 + k),
        v[1] + back.inward[1] * (dims.d / 2 + k) + side.inward[1] * (dims.w / 2 + k),
      ];
      const sideWord = compassWord([-back.inward[0], -back.inward[1]], north);
      return {
        ok: true,
        target: {
          position: [round4(pos[0]), round4(pos[1])],
          rotation: rotationFacing(back.inward),
          relation,
          rationale: [`in the corner of ${eIn.wall.id} and ${eOut.wall.id}`, `back to the ${sideWord} wall (${back.wall.id}), the longer one`],
        },
      };
    }
    case 'centered_in': {
      if (relation.roomId !== room.id) {
        return bad(`relation names room "${relation.roomId}" but the item goes in "${room.id}"`, [relation.roomId, room.id], 'Use the same room in the request and in centered_in.roomId.');
      }
      const c = polygonCentroid(room.polygon);
      const base = input.itemId ? scene.items.find((i) => i.id === input.itemId) : undefined;
      const x = relation.axis === 'y' && base ? base.position[0] : c[0];
      const y = relation.axis === 'x' && base ? base.position[1] : c[1];
      return {
        ok: true,
        target: {
          position: [round4(x), round4(y)],
          rotation: base?.rotation ?? 0,
          relation,
          rationale: [relation.axis === 'both' ? `centred in ${room.name}` : `centred on the ${relation.axis} axis of ${room.name}`],
        },
      };
    }
    case 'facing': {
      const base = input.itemId ? scene.items.find((i) => i.id === input.itemId) : undefined;
      if (!base) {
        return bad('"facing" turns an existing item; there is none to turn', [relation.targetId], 'Place the item first (against_wall, at, ...), then call again with itemId and facing; or give the rotation in "at".');
      }
      const goal = entityCentre(scene, relation.targetId);
      if (!goal) return bad(`unknown target "${relation.targetId}" (not an item, opening, wall or room)`, [relation.targetId], 'Use an id from describe_room: items, openings, walls or rooms.');
      const dx = goal[0] - base.position[0];
      const dy = goal[1] - base.position[1];
      if (Math.hypot(dx, dy) < 1e-6) return bad('the item stands on the centre of its target; it cannot face it', [relation.targetId]);
      return {
        ok: true,
        target: { position: base.position, rotation: rotationFacing([dx, dy]), relation, rationale: [`turned to face "${relation.targetId}"`] },
      };
    }
    case 'next_to': {
      const other = scene.items.find((i) => i.id === relation.itemId);
      if (!other) return bad(`unknown item "${relation.itemId}" to stand next to`, [relation.itemId], 'Use an item id from describe_room.');
      if (other.id === input.itemId) return bad('an item cannot stand next to itself', [other.id]);
      const od = itemDims(other);
      const gap = relation.gap;
      // offset in the other item's frame: x = its right (seen from the front), z = its front
      let x = 0;
      let z = 0;
      const alignSign = relation.align === 'start' ? -1 : relation.align === 'end' ? 1 : 0;
      switch (relation.side) {
        case 'right':
          x = od.w / 2 + gap + dims.w / 2;
          z = alignSign * (od.d / 2 - dims.d / 2);
          break;
        case 'left':
          x = -(od.w / 2 + gap + dims.w / 2);
          z = alignSign * (od.d / 2 - dims.d / 2);
          break;
        case 'front':
          z = od.d / 2 + gap + dims.d / 2;
          x = alignSign * (od.w / 2 - dims.w / 2);
          break;
        case 'back':
          z = -(od.d / 2 + gap + dims.d / 2);
          x = alignSign * (od.w / 2 - dims.w / 2);
          break;
      }
      const o = localToPlan(other.rotation, x, z);
      return {
        ok: true,
        target: {
          position: [round4(other.position[0] + o[0]), round4(other.position[1] + o[1])],
          rotation: other.rotation,
          relation,
          rationale: [`${relation.side} of "${other.id}" (seen from its front), ${round4(gap)} m apart`, 'same facing as that item'],
        },
      };
    }
    case 'under_window': {
      const opening = scene.openings.find((o) => o.id === relation.openingId);
      if (!opening) return bad(`unknown opening "${relation.openingId}"`, [relation.openingId], 'Use an opening id from describe_room.');
      if (opening.type !== 'window') return bad(`"${opening.id}" is a ${opening.type}, not a window`, [opening.id], 'under_window needs a window; use against_wall for other stretches of wall.');
      const edge = edgeOnWall(roomWallEdges(scene, room), opening.wallId);
      const f = openingFrame(scene, opening);
      if (!edge || !f) return bad(`window "${opening.id}" is not on a wall of room "${room.id}"`, [opening.id, room.id], wallsHint(scene, room));
      const half = dims.w / 2;
      const centre = Math.min(Math.max(opening.offset, edge.lo + half), Math.max(edge.hi - half, edge.lo + half));
      const pose = poseAgainst(edge, dims, centre, relation.gap);
      return {
        ok: true,
        target: { ...pose, relation, rationale: [`under window "${opening.id}", against ${edge.wall.id}`, `window sill at ${round4(opening.sill)} m`] },
      };
    }
    case 'on': {
      const support = scene.items.find((i) => i.id === relation.itemId);
      if (!support) return bad(`unknown item "${relation.itemId}" to stand on`, [relation.itemId], 'Use an item id from describe_room.');
      if (support.id === input.itemId) return bad('an item cannot stand on itself', [support.id]);
      if (input.mount !== undefined && input.mount !== 'floor') return bad(`a ${input.mount}-mounted item cannot stand on another item`, [support.id], 'Use mount floor (the default) with "on", or a wall relation.');
      if (support.roomId !== undefined && support.roomId !== room.id) return bad(`"${support.id}" is in room "${support.roomId}", not in "${room.id}"`, [support.id, room.id], 'Place it in the room of the item it stands on.');
      const why = whyNotOn(input.category, dims, support);
      if (why) return bad(`cannot stand on "${support.id}": ${why}`, [support.id], standsOnHint(input.category));
      const offset = relation.offset ?? defaultOffset(support);
      const top = supportTop(support);
      return {
        ok: true,
        target: {
          position: spotOn(support, offset),
          rotation: support.rotation,
          elevation: top,
          relation: { ...relation, offset },
          rationale: [`on top of "${support.id}", ${round4(top)} m above the floor`],
        },
      };
    }
    case 'at':
      return {
        ok: true,
        target: { position: [round4(relation.position[0]), round4(relation.position[1])], rotation: relation.rotation, elevation: relation.elevation, relation, rationale: ['at the requested position'] },
      };
  }
}

/** Centre of an item, opening, wall (midpoint) or room (centroid), looked up by id in that order. */
export function entityCentre(scene: Scene, id: string): Vec2 | undefined {
  const item = scene.items.find((i) => i.id === id);
  if (item) return item.position;
  const opening = scene.openings.find((o) => o.id === id);
  if (opening) return openingFrame(scene, opening)?.centre;
  const wall = scene.walls.find((w) => w.id === id);
  if (wall) return [(wall.start[0] + wall.end[0]) / 2, (wall.start[1] + wall.end[1]) / 2];
  const room = scene.rooms.find((r) => r.id === id);
  return room ? polygonCentroid(room.polygon) : undefined;
}
