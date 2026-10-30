import type { BatchCommand, LeafCommand } from './commands/schema';
import { isSimplePolygon, polygonArea } from './measure';
import { footprintOf } from './placement/footprint';
import { findForeignRecesses } from './plan-recess';
import type { Room, Scene, Vec2, Wall } from './schema';
import { isStructural } from './structural';
import type { ValidationWarning } from './validate';

/**
 * Plan-coherence lint: wall endpoints that stop short of another wall, joints without overlap (light leaks),
 * overlapping or degenerate walls, room outlines that float off their walls, and room outlines that swallow a
 * recess opening onto a neighbour. Pure and deterministic. Every finding that has an obvious repair carries it as
 * a `PlanFix`: a batch of existing typed commands (`wall.setEnds`, `room.setPolygon`), applied as one undo step.
 * Nothing is applied here, and a structural wall only ever gets an endpoint snap of a few centimetres.
 */

/** `advisory`: worth fixing (a light-leak risk) but common in drawn plans, so it is not part of `validateScene`'s warnings. */
export type PlanSeverity = 'warning' | 'advisory';
export interface PlanFinding extends ValidationWarning {
  severity: PlanSeverity;
}

export interface PlanFix {
  /** What the fix does, for a button. */
  label: string;
  /** True when it is a small, unambiguous snap that is fine to apply without looking (all fixes can be applied by hand). */
  safe: boolean;
  /** One undoable batch. */
  command: BatchCommand;
}

/** A wall end this close to another wall (face or end), without touching it, is a gap. */
export const WALL_GAP_MAX = 0.3;
/** Walls closer than this to touching count as touching, in metres. */
const TOUCH = 1e-3;
/** A joint whose end reaches less than this far into the other wall is a butt (a light-leak risk), in metres. */
export const BUTT_DEPTH = 0.002;
/** Structural walls may only be snapped by this much when a fix is proposed (the reducer refuses more than 20 cm). */
const STRUCTURAL_SNAP = 0.15;
/** A fix is "safe" when no end moves further than this (structural walls: `STRUCTURAL_SAFE`). */
const SAFE_MOVE = 0.2;
const STRUCTURAL_SAFE = 0.05;
/** Room edges within this of a wall face and parallel to it are snapped onto the face, in metres. */
export const POLYGON_SNAP_MAX = 0.2;
/** A room edge off its wall face by more than this is reported, in metres. */
export const POLYGON_SNAP_MIN = 0.01;
/** Smaller walls are degenerate. */
export const WALL_MIN_LENGTH = 0.005;
const PARALLEL = 0.1;
/** A gap is only a gap between walls about as tall as each other (a balcony rail does not seal a facade), in metres. */
const HEIGHT_MATCH = 0.5;
/** sin of the largest angle for walls/edges to be treated as parallel when comparing room edges. */
const EDGE_PARALLEL = 0.035;

type V = readonly [number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1];
const cross = (a: V, b: V) => a[0] * b[1] - a[1] * b[0];
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const cm = (m: number) => `${(m * 100).toFixed(1)} cm`;

interface Seg {
  wall: Wall;
  index: number;
  a: V;
  b: V;
  len: number;
  /** Unit direction start to end. */
  u: V;
  /** Unit normal. */
  n: V;
  half: number;
}

function segOf(wall: Wall, index: number): Seg | undefined {
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  const len = Math.hypot(dx, dy);
  if (len < WALL_MIN_LENGTH) return undefined;
  const u: V = [dx / len, dy / len];
  return { wall, index, a: wall.start, b: wall.end, len, u, n: [-u[1], u[0]], half: wall.thickness / 2 };
}

/** Where `p` is relative to a wall rectangle: `s` along it, `d` across it, `dist` to the rectangle (0 inside), `depth` inside the face. */
function locate(p: V, o: Seg) {
  const r = sub(p, o.a);
  const s = dot(r, o.u);
  const d = dot(r, o.n);
  const dist = Math.hypot(Math.max(0, -s, s - o.len), Math.max(0, Math.abs(d) - o.half));
  return { s, d, dist, depth: o.half - Math.abs(d) };
}

interface EndRef {
  seg: Seg;
  end: 'start' | 'end';
  p: V;
  /** Unit direction pointing out of the wall at this end. */
  out: V;
}

function endsOf(seg: Seg): EndRef[] {
  return [
    { seg, end: 'start', p: seg.a, out: [-seg.u[0], -seg.u[1]] },
    { seg, end: 'end', p: seg.b, out: seg.u },
  ];
}

interface LockedRect {
  id: string;
  polygon: Vec2[];
}

function lockedFittings(scene: Scene): LockedRect[] {
  const out: LockedRect[] = [];
  for (const item of scene.items) {
    if (item.locked !== true) continue;
    const dims = item.dims ?? item.product?.dims;
    if (!dims) continue;
    const hw = dims.w / 2 + 0.02;
    const hd = dims.d / 2 + 0.02;
    out.push({ id: item.id, polygon: footprintOf(item.position, item.rotation ?? 0, { w: hw * 2, d: hd * 2 }) });
  }
  return out;
}

function inPolygon(p: V, polygon: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** The point of wall rectangle `o` nearest to `p`. */
function nearestOn(p: V, o: Seg): V {
  const { s, d } = locate(p, o);
  const cs = Math.max(0, Math.min(o.len, s));
  const cd = Math.max(-o.half, Math.min(o.half, d));
  return [o.a[0] + o.u[0] * cs + o.n[0] * cd, o.a[1] + o.u[1] * cs + o.n[1] * cd];
}

/** Five points along the end face of a wall (the line across its thickness at this end). */
function endFace(r: EndRef): V[] {
  return [-1, -0.5, 0, 0.5, 1].map((k) => [r.p[0] + r.seg.n[0] * r.seg.half * k, r.p[1] + r.seg.n[1] * r.seg.half * k] as V);
}

const key = (r: EndRef) => `${r.seg.wall.id}.${r.end}`;

interface GapRecord {
  from: EndRef;
  to: Seg;
  dist: number;
}

function setEnd(r: EndRef, to: V): LeafCommand {
  return { type: 'wall.setEnds', wallId: r.seg.wall.id, [r.end]: [r6(to[0]), r6(to[1])] } as LeafCommand;
}

function batch(label: string, commands: LeafCommand[]): BatchCommand {
  return { type: 'batch', label, commands };
}

export function planWarnings(scene: Scene): PlanFinding[] {
  const warnings: PlanFinding[] = [];
  const segs: Seg[] = [];
  scene.walls.forEach((w, i) => {
    const s = segOf(w, i);
    if (s) segs.push(s);
    else {
      warnings.push({
        code: 'wall-zero-length',
        severity: 'warning',
        id: `wall-zero-length:${w.id}`,
        message: `wall "${w.id}" is shorter than ${cm(WALL_MIN_LENGTH)} (zero-length)`,
        entityIds: [w.id],
        path: `walls[${i}]`,
      });
    }
  });
  const structural = new Map(segs.map((s) => [s.wall.id, isStructural(scene, s.wall)]));
  const fittings = lockedFittings(scene);

  warnings.push(...overlappingWalls(segs));
  warnings.push(...jointWarnings(segs, structural, fittings));

  for (const r of findForeignRecesses(scene)) {
    const idx = scene.rooms.findIndex((x) => x.id === r.roomId);
    const fixable = r.carved && r.grown;
    warnings.push({
      code: 'room-includes-foreign-recess',
      severity: 'warning',
      id: `room-includes-foreign-recess:${r.roomId}:${r.ontoRoomId}`,
      message: `room "${r.roomId}" includes a ${r.area.toFixed(2)} m² recess enclosed by walls that opens only onto room "${r.ontoRoomId}"`,
      entityIds: [r.roomId, r.ontoRoomId],
      path: `rooms[${idx}].polygon`,
      ...(fixable
        ? {
            fix: {
              label: `Move the recess from ${r.roomId} to ${r.ontoRoomId}`,
              safe: false,
              command: batch(`Move a ${r.area.toFixed(2)} m² recess from ${r.roomId} to ${r.ontoRoomId}`, [
                { type: 'room.setPolygon', roomId: r.roomId, polygon: r.carved! },
                { type: 'room.setPolygon', roomId: r.ontoRoomId, polygon: r.grown! },
              ]),
            },
          }
        : {}),
    });
  }
  return warnings;
}

function overlappingWalls(segs: readonly Seg[]): PlanFinding[] {
  const out: PlanFinding[] = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i]!;
      const b = segs[j]!;
      if (Math.abs(cross(a.u, b.u)) > 0.02 || dot(a.u, b.u) === 0) continue;
      const lateral = Math.abs(dot(sub(b.a, a.a), a.n));
      if (lateral > (a.half + b.half) * 0.9) continue; // side by side, not on top of each other
      const sb0 = dot(sub(b.a, a.a), a.u);
      const sb1 = dot(sub(b.b, a.a), a.u);
      const overlap = Math.min(a.len, Math.max(sb0, sb1)) - Math.max(0, Math.min(sb0, sb1));
      if (overlap < 0.02) continue;
      const same = lateral < 1e-3 && overlap > Math.min(a.len, b.len) - 1e-3;
      out.push({
        code: 'walls-overlap',
        severity: 'warning',
        id: `walls-overlap:${a.wall.id}:${b.wall.id}`,
        message: same
          ? `walls "${a.wall.id}" and "${b.wall.id}" are duplicates (same place); remove one`
          : `walls "${a.wall.id}" and "${b.wall.id}" overlap along ${cm(overlap)}; merge or shorten one`,
        entityIds: [a.wall.id, b.wall.id],
        path: `walls[${b.index}]`,
      });
    }
  }
  return out;
}

function jointWarnings(segs: readonly Seg[], structural: ReadonlyMap<string, boolean>, fittings: readonly LockedRect[]): PlanFinding[] {
  const out: PlanFinding[] = [];
  const gaps = new Map<string, GapRecord>();
  const order: string[] = [];

  for (const w of segs) {
    for (const ref of endsOf(w)) {
      // A pillar (short and thick) has a free end by design.
      const pillar = w.len <= 3 * w.wall.thickness;
      let touching = false;
      let covered = false;
      let nearest: GapRecord | undefined;
      let butt: { o: Seg } | undefined;
      for (const o of segs) {
        if (o === w) continue;
        const face = endFace(ref).map((q) => locate(q, o).dist);
        const near = Math.min(...face);
        if (near <= TOUCH) {
          touching = true;
          const at = locate(ref.p, o);
          if (at.dist <= TOUCH && at.depth > BUTT_DEPTH) covered = true;
          else if (at.dist <= TOUCH && Math.abs(dot(w.u, o.u)) <= 0.5 && at.s >= TOUCH && at.s <= o.len - TOUCH) {
            // Exactly at the face: does the wall body lie on this side?
            const other = ref.end === 'start' ? w.b : w.a;
            const sideOther = Math.sign(dot(sub(other, o.a), o.n));
            if (sideOther === Math.sign(at.d) && Math.abs(dot(sub(other, o.a), o.n)) > o.half) butt ??= { o };
          }
        } else if (!pillar && Math.abs(w.wall.height - o.wall.height) <= HEIGHT_MATCH && near <= WALL_GAP_MAX && (!nearest || near < nearest.dist)) {
          nearest = { from: ref, to: o, dist: near };
        }
      }
      if (touching) {
        if (butt && !covered) {
          const ext = structural.get(w.wall.id) ? Math.min(butt.o.half, STRUCTURAL_SNAP) : butt.o.half;
          const to: V = [ref.p[0] + ref.out[0] * ext, ref.p[1] + ref.out[1] * ext];
          out.push({
            code: 'wall-joint-no-overlap',
            severity: 'advisory',
            id: `wall-joint-no-overlap:${key(ref)}:${butt.o.wall.id}`,
            message: `wall "${w.wall.id}" ${ref.end} meets wall "${butt.o.wall.id}" exactly at its face with no overlap (light can leak through the joint)`,
            entityIds: [w.wall.id, butt.o.wall.id],
            path: `walls[${w.index}]`,
            fix: {
              label: `Extend ${w.wall.id} ${ref.end} by ${cm(ext)} into ${butt.o.wall.id}`,
              safe: true,
              command: batch(`Overlap ${w.wall.id} with ${butt.o.wall.id}`, [setEnd(ref, to)]),
            },
          });
        }
        continue;
      }
      if (nearest) {
        gaps.set(key(ref), nearest);
        order.push(key(ref));
      }
    }
  }

  const consumed = new Set<string>();
  for (const k of order) {
    if (consumed.has(k)) continue;
    const g = gaps.get(k)!;
    const w = g.from.seg;
    const o = g.to;
    // The nearest end of `o` is itself a gap towards `w`: one slot between two ends, reported once.
    const mate = endsOf(o)
      .map((r) => ({ r, rec: gaps.get(key(r)) }))
      .find((m) => m.rec && m.rec.to === w && !consumed.has(key(m.r)));
    const sample = endFace(g.from).sort((x, y) => locate(x, o).dist - locate(y, o).dist)[0]!;
    const closer = nearestOn(sample, o);
    if (fittings.some((f) => [sample, closer, [(sample[0] + closer[0]) / 2, (sample[1] + closer[1]) / 2] as V].every((p) => inPolygon(p, f.polygon)))) {
      consumed.add(k);
      if (mate) consumed.add(key(mate.r));
      continue;
    }
    consumed.add(k);
    if (mate) consumed.add(key(mate.r));
    out.push(gapWarning(g, mate?.r, structural));
  }
  return out;
}

/** Where the axis of `r` (going out of its wall) meets the centreline of `o`, with the distance travelled; undefined when it cannot. */
function reach(r: EndRef, o: Seg, anySpan = false): { x: V; t: number } | undefined {
  const denom = cross(r.out, o.u);
  if (Math.abs(denom) <= PARALLEL) return undefined;
  const t = cross(sub(o.a, r.p), o.u) / denom;
  const x: V = [r.p[0] + r.out[0] * t, r.p[1] + r.out[1] * t];
  const s = dot(sub(x, o.a), o.u);
  const slack = r.seg.half + 1e-3;
  if (t < -1e-3 || (!anySpan && (s < -slack || s > o.len + slack))) return undefined;
  return { x, t };
}

function gapWarning(g: GapRecord, mate: EndRef | undefined, structural: ReadonlyMap<string, boolean>): PlanFinding {
  const w = g.from.seg;
  const o = g.to;
  const ids = [w.wall.id, o.wall.id];
  const base = {
    code: 'wall-gap',
    severity: 'warning' as const,
    id: `wall-gap:${key(g.from)}:${o.wall.id}`,
    message: mate
      ? `wall "${w.wall.id}" ${g.from.end} stops ${cm(g.dist)} short of wall "${o.wall.id}" (${mate.end === 'start' ? 'start' : 'end'} of "${o.wall.id}" is open too): a slot in the plan`
      : `wall "${w.wall.id}" ${g.from.end} stops ${cm(g.dist)} short of wall "${o.wall.id}" (no contact)`,
    entityIds: ids,
    path: `walls[${w.index}]`,
  };
  // The repair: both ends go to the meeting point of the centrelines (L corner), or just this end onto the other wall (T).
  let moves: { ref: EndRef; to: V }[] | undefined;
  const mine = reach(g.from, o);
  // The other end moves too, so the line it meets only has to reach where this wall will be.
  const theirs = mate ? reach(mate, w, true) : undefined;
  if (mine && mate && theirs && mine.t <= WALL_GAP_MAX + o.half + 0.02 && Math.hypot(theirs.x[0] - mine.x[0], theirs.x[1] - mine.x[1]) < 1e-6) {
    moves = [
      { ref: g.from, to: mine.x },
      { ref: mate, to: mine.x },
    ];
  } else if (mine && mine.t <= WALL_GAP_MAX + o.half + 0.02) {
    moves = [{ ref: g.from, to: mine.x }];
  } else if (Math.abs(cross(g.from.out, o.u)) <= PARALLEL) {
    // Collinear walls with a hole between them: run this one on to the other's near end.
    const lateral = Math.abs(dot(sub(g.from.p, o.a), o.n));
    const q = endsOf(o).map((e) => e.p).sort((p, p2) => Math.hypot(...sub(p, g.from.p)) - Math.hypot(...sub(p2, g.from.p)))[0]!;
    const t = dot(sub(q, g.from.p), g.from.out);
    if (lateral <= w.half + o.half + 0.01 && t > 0 && t <= WALL_GAP_MAX) {
      moves = [{ ref: g.from, to: [g.from.p[0] + g.from.out[0] * t, g.from.p[1] + g.from.out[1] * t] }];
    }
  }
  if (!moves) return base;
  // A structural wall only gets small snaps.
  const tooFar = moves.some((m) => structural.get(m.ref.seg.wall.id) && Math.hypot(...sub(m.to, m.ref.p)) > STRUCTURAL_SNAP);
  if (tooFar) return { ...base, message: `${base.message}; it is structural, so adjust it by hand` };
  const safe = moves.every((m) => Math.hypot(...sub(m.to, m.ref.p)) <= (structural.get(m.ref.seg.wall.id) ? STRUCTURAL_SAFE : SAFE_MOVE));
  const label =
    moves.length === 2
      ? `Join ${w.wall.id} and ${o.wall.id} at (${r6(moves[0]!.to[0])}, ${r6(moves[0]!.to[1])})`
      : `Extend ${w.wall.id} ${g.from.end} by ${cm(Math.hypot(...sub(moves[0]!.to, g.from.p)))} to meet ${o.wall.id}`;
  return { ...base, fix: { label, safe, command: batch(label, moves.map((m) => setEnd(m.ref, m.to))) } };
}

/**
 * For a room edge with no wall behind it: the outline with that edge moved onto the face of a parallel wall
 * within `POLYGON_SNAP_MAX`, when there is one. `offset` is how far the edge is from the face.
 */
export function edgeSnap(scene: Scene, room: Room, k: number): { wallId: string; offset: number; fix: PlanFix } | undefined {
  const n = room.polygon.length;
  const a = room.polygon[k]!;
  const b = room.polygon[(k + 1) % n]!;
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 0.05) return undefined;
  const ue: V = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  const ccw = room.polygon.reduce((s, p, i) => s + (p[0] * room.polygon[(i + 1) % n]![1] - room.polygon[(i + 1) % n]![0] * p[1]), 0) > 0;
  const inward: V = ccw ? [-ue[1], ue[0]] : [ue[1], -ue[0]];
  let best: { seg: Seg; offset: number; da: number; db: number; target: number } | undefined;
  scene.walls.forEach((wall, wi) => {
    const w = segOf(wall, wi);
    if (!w || Math.abs(cross(ue, w.u)) > EDGE_PARALLEL) return;
    const da = dot(sub(a, w.a), w.n);
    const db = dot(sub(b, w.a), w.n);
    if (Math.abs(da - db) > 0.02) return;
    const sa = dot(sub(a, w.a), w.u);
    const sb = dot(sub(b, w.a), w.u);
    const overlap = Math.min(w.len + w.half, Math.max(sa, sb)) - Math.max(-w.half, Math.min(sa, sb));
    if (overlap < length / 2) return;
    // The face the room sees: the wall lies on the side opposite to the inward normal of the room edge.
    const target = (dot(inward, w.n) >= 0 ? 1 : -1) * w.half;
    const offset = (da + db) / 2 - target;
    if (Math.abs(offset) <= POLYGON_SNAP_MIN || Math.abs(offset) > POLYGON_SNAP_MAX) return;
    if (!best || Math.abs(offset) < Math.abs(best.offset)) best = { seg: w, offset, da, db, target };
  });
  if (!best) return undefined;
  const { seg, da, db, target } = best;
  const moved = room.polygon.map((p) => [...p] as Vec2);
  moved[k] = [r6(a[0] + seg.n[0] * (target - da)), r6(a[1] + seg.n[1] * (target - da))];
  moved[(k + 1) % n] = [r6(b[0] + seg.n[0] * (target - db)), r6(b[1] + seg.n[1] * (target - db))];
  if (!isSimplePolygon(moved)) return undefined;
  const before = polygonArea(room.polygon);
  if (Math.abs(polygonArea(moved) - before) > 0.25 * before) return undefined;
  const label = `Snap edge ${k} of ${room.id} onto the face of ${seg.wall.id} (${cm(Math.abs(best.offset))})`;
  return {
    wallId: seg.wall.id,
    offset: Math.abs(best.offset),
    fix: { label, safe: Math.abs(best.offset) <= 0.05, command: batch(label, [{ type: 'room.setPolygon', roomId: room.id, polygon: moved }]) },
  };
}
