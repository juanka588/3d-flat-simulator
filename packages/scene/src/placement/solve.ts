import type { Dims } from '../primitives';
import type { Room, Scene, Vec2 } from '../schema';
import { GENERATOR_DIMS_TOLERANCE } from '../items/mesh-source';
import { checkSubject, layoutContext, subjectBox, violation, type LayoutContext, type RoomInfo, type Subject } from './constraints';
import { round4 } from './footprint';
import { edgeOnWall, poseAgainst, resolveRelation, roomWallEdges, type Resolved, type WallEdge } from './relations';
import { walkwayVerdict } from './walkways';
import { fitOn } from './support';
import { itemDims } from './footprint';
import { PlacementRequest, type Placement, type PlacementRequestInput, type PlacementResult, type Relation, type Violation } from './types';

/**
 * The placement solver (D7). Pure and deterministic: no clock, no randomness, no mutation of `scene`.
 *
 * 1. the request's relation is turned into ONE concrete pose (`relations.ts`);
 * 2. the hard constraints are checked on it (`constraints.ts`, then the walkway raster);
 * 3. if it holds the pose is returned with a rationale; otherwise the violations are returned together with up
 *    to `maxCandidates` ALTERNATIVE poses, found by sampling the freedom the relation leaves (sliding along the
 *    wall, the other walls or corners of the room, or a 5 cm grid around the requested spot) in order of distance
 *    from the requested pose. At most `MAX_SAMPLES` samples are looked at; ties break by generation order, so
 *    equal inputs give equal outputs.
 *
 * Soft preferences (clearance wanted around the item) only order alternatives: they never reject a pose.
 */

export const SAMPLE_STEP_M = 0.05;
export const MAX_SAMPLES = 2000;
/** Alternatives closer than this to each other are the same idea; keep the first. */
const MIN_CANDIDATE_SPACING_M = 0.25;
/**
 * Deterministic work budget of the search for alternatives: poses examined (cheap checks) per solve at most.
 * No clock is involved, so equal inputs give equal outputs on any machine under any load.
 */
export const SOLVE_MAX_EVALUATIONS = MAX_SAMPLES;
/** Walkway rasters computed per solve at most (each is a few ms). */
const MAX_WALKWAY_CHECKS = 24;
/** After a pose failed the walkway test, poses this close to it are not tried (they would fail the same way). */
const WALKWAY_FAIL_RADIUS_M = 0.3;
/** Default height of the bottom of a wall mount when the request gives none. */
export const DEFAULT_WALL_MOUNT_ELEVATION_M = 1.2;
/** Open-air rooms have no ceiling: hang ceiling mounts as under a 2.5 m one. */
const OPEN_AIR_CEILING_M = 2.5;

interface Pose {
  position: Vec2;
  rotation: number;
  relation: Relation;
}

const normRot = (deg: number): number => round4(((deg % 360) + 360) % 360);

function mountElevation(req: PlacementRequest, info: RoomInfo, atElevation: number | undefined): number {
  if (req.mount === 'floor') return req.relation.kind === 'on' && atElevation !== undefined ? round4(atElevation) : 0;
  if (req.elevation !== undefined) return round4(req.elevation);
  if (req.mount === 'wall') return round4(atElevation !== undefined && atElevation > 0 ? atElevation : DEFAULT_WALL_MOUNT_ELEVATION_M);
  const ceiling = Number.isFinite(info.ceiling) ? info.ceiling : OPEN_AIR_CEILING_M;
  return round4(Math.max(0, ceiling - req.dims.h));
}

/** An `at` relation stores the real height of the item bottom, not the 0 default of a request that only gave `elevation`. */
const withElevation = (rel: Relation, elevation: number): Relation => (rel.kind === 'at' ? { ...rel, elevation } : rel);

interface Verdict {
  violations: Violation[];
  warnings: Violation[];
}

/** All hard constraints on one pose, walkways last (only worth computing when the cheap ones hold). */
function fullCheck(ctx: LayoutContext, info: RoomInfo, subject: Subject, ignoreId: string | undefined): Verdict {
  const r = checkSubject(ctx, subject);
  if (r.violations.length > 0) return r;
  const box = subjectBox(subject);
  const verdict = walkwayVerdict(ctx, info, {
    candidate: box,
    skip: (b) => b.id === ignoreId,
    baselineSkip: (b) => b.id === ignoreId,
  });
  return verdict.violation ? { violations: [verdict.violation], warnings: r.warnings } : r;
}

function clearancePenalty(ctx: LayoutContext, subject: Subject, clearance: PlacementRequest['clearance']): number {
  if (!clearance) return 0;
  let penalty = 0;
  const probe = (zoneDims: Dims, ox: number, oz: number): void => {
    // zone box next to the item, in the item frame
    const r = (subject.rotation * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const centre: Vec2 = [subject.position[0] + ox * c + oz * s, subject.position[1] - ox * s + oz * c];
    if (checkSubject(ctx, { ...subject, position: centre, dims: zoneDims }, ['overlap']).violations.length > 0) penalty += 1;
  };
  const { w, d, h } = subject.dims;
  if (clearance.front) probe({ w, d: clearance.front, h }, 0, d / 2 + clearance.front / 2);
  if (clearance.back) probe({ w, d: clearance.back, h }, 0, -(d / 2 + clearance.back / 2));
  if (clearance.right) probe({ w: clearance.right, d, h }, w / 2 + clearance.right / 2, 0);
  if (clearance.left) probe({ w: clearance.left, d, h }, -(w / 2 + clearance.left / 2), 0);
  return penalty;
}

/** Alternative poses to try, best first (nearest the requested pose). Capped at `MAX_SAMPLES`. */
function sample(scene: Scene, room: Room, req: PlacementRequest, target: Resolved, rotation: number): Pose[] {
  const dims = req.dims;
  const gapOf = (rel: Relation): number => ('gap' in rel && typeof rel.gap === 'number' ? rel.gap : 0);
  const poses: Pose[] = [];
  const rel = target.relation;
  const wallFamily = req.mount === 'wall' || rel.kind === 'against_wall' || rel.kind === 'under_window';
  if (rel.kind === 'facing' || rel.kind === 'on') return poses;
  if (wallFamily) {
    const edges = roomWallEdges(scene, room);
    const first = rel.kind === 'against_wall' ? edgeOnWall(edges, rel.wallId) : undefined;
    const ordered: WallEdge[] = first ? [first, ...edges.filter((e) => e !== first)] : edges;
    const gap = gapOf(rel);
    for (const e of ordered) {
      if (rel.kind === 'under_window' && e !== first && edgeOnWall(edges, e.wall.id) !== e) continue;
      const lo = e.lo + dims.w / 2;
      const hi = e.hi - dims.w / 2;
      if (hi < lo - 1e-9) continue;
      for (let s = lo; s <= hi + 1e-9; s += SAMPLE_STEP_M) {
        const along = Math.min(s, hi);
        const pose = poseAgainst(e, dims, along, gap);
        poses.push({
          ...pose,
          relation: { kind: 'against_wall', wallId: e.wall.id, roomId: room.id, align: 'start', offset: round4(Math.max(0, along - dims.w / 2 - e.lo)), gap },
        });
        if (poses.length >= MAX_SAMPLES * 4) break;
      }
    }
  } else if (rel.kind === 'in_corner') {
    for (let k = 0; k < room.polygon.length; k++) {
      if (k === rel.corner) continue;
      const r = resolveRelation({ scene, room, dims, relation: { ...rel, corner: k } });
      if (r.ok) poses.push({ position: r.target.position, rotation: r.target.rotation, relation: { ...rel, corner: k } });
    }
  } else {
    const xs = room.polygon.map((p) => p[0]);
    const ys = room.polygon.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    for (let x = minX + dims.w / 2; x <= maxX - dims.w / 2 + 1e-9; x += SAMPLE_STEP_M) {
      for (let y = minY + dims.d / 2; y <= maxY - dims.d / 2 + 1e-9; y += SAMPLE_STEP_M) {
        poses.push({ position: [round4(x), round4(y)], rotation, relation: { kind: 'at', position: [round4(x), round4(y)], rotation, elevation: 0 } });
      }
    }
  }
  const from = target.position;
  const keyed = poses.map((p, i) => ({ p, i, d: Math.hypot(p.position[0] - from[0], p.position[1] - from[1]) }));
  keyed.sort((a, b) => a.d - b.d || a.i - b.i);
  return keyed.slice(0, MAX_SAMPLES).map((k) => k.p);
}

function dimsMismatch(scene: Scene, req: PlacementRequest): Violation | undefined {
  if (req.itemId === undefined) return undefined;
  const item = scene.items.find((i) => i.id === req.itemId);
  const known = item?.product?.dims ?? item?.dims;
  if (!item || !known) return undefined;
  const ok = (a: number, b: number) => Math.abs(a - b) <= Math.max(GENERATOR_DIMS_TOLERANCE * b, 0.001);
  if (ok(req.dims.w, known.w) && ok(req.dims.d, known.d) && ok(req.dims.h, known.h)) return undefined;
  return violation('dims_mismatch', `requested dims ${req.dims.w} x ${req.dims.d} x ${req.dims.h} m differ by more than 2% from item "${item.id}" (${known.w} x ${known.d} x ${known.h} m)`, [item.id]);
}

/** Optional out-parameter that reports the (deterministic) work a solve did; for tests and tuning. */
export interface SolveStats {
  poses: number;
  walkwayChecks: number;
}

const fail = (v: Violation[], candidates: Placement[] = []): PlacementResult => ({ ok: false, violations: v, candidates });

/**
 * Resolves a placement request against the scene. See the file header. Never throws for bad input: an
 * unparseable request, an unknown room or an impossible relation come back as `invalid_relation`.
 */
export function solvePlacement(scene: Scene, request: PlacementRequestInput, stats?: SolveStats): PlacementResult {
  const parsed = PlacementRequest.safeParse(request);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return fail([violation('invalid_relation', `invalid placement request: ${issue.path.join('/') || 'request'}: ${issue.message}`, [], 'Fix the request fields; see the PlacementRequest schema.')]);
  }
  const req = parsed.data;
  const ctx = layoutContext(scene);
  const info = ctx.rooms.get(req.roomId);
  if (!info) return fail([violation('invalid_relation', `unknown room "${req.roomId}"`, [req.roomId], 'Use a room id from list_rooms.')]);
  const room = info.room;

  if (req.itemId !== undefined) {
    const existing = scene.items.find((i) => i.id === req.itemId);
    if (!existing) return fail([violation('invalid_relation', `unknown item "${req.itemId}" to move`, [req.itemId], 'Use an item id from describe_room, or omit itemId for a new item.')]);
    if (existing.locked === true) return fail([violation('locked_item', `item "${existing.id}" is locked (existing furniture) and cannot be moved`, [existing.id])]);
  }
  const mismatch = dimsMismatch(scene, req);
  if (mismatch) return fail([mismatch]);

  const resolved = resolveRelation({
    scene,
    room,
    dims: req.dims,
    mount: req.mount,
    ...(req.category !== undefined ? { category: req.category } : {}),
    ...(req.itemId !== undefined ? { itemId: req.itemId } : {}),
    relation: req.relation,
  });
  if (!resolved.ok) return fail([resolved.violation]);
  const target = resolved.target;
  const rotation = normRot(target.rotation + (req.rotation ?? 0));
  if (target.relation.kind === 'on') {
    const support = scene.items.find((i) => i.id === (target.relation as { itemId: string }).itemId)!;
    const misfit = fitOn(req.category, support, target.position, rotation, req.dims);
    if (misfit) return fail([violation('invalid_relation', misfit, [support.id], `Support top is ${itemDims(support).w} x ${itemDims(support).d} m; pick a smaller product, or set offset to move it on the top.`)]);
  }
  const elevation = mountElevation(req, info, target.elevation);
  const category = req.category ?? scene.items.find((i) => i.id === req.itemId)?.product?.category;
  const subjectAt = (position: Vec2, rot: number): Subject => ({
    ...(req.itemId !== undefined ? { id: req.itemId } : {}),
    roomId: room.id,
    position,
    rotation: rot,
    elevation,
    dims: req.dims,
    mount: req.mount,
    ...(req.weightKg !== undefined ? { weightKg: req.weightKg } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(target.relation.kind === 'on' ? { supportId: target.relation.itemId } : {}),
    acknowledgeHeavyPartition: req.acknowledgeHeavyPartition,
  });

  const main = fullCheck(ctx, info, subjectAt(target.position, rotation), req.itemId);
  if (main.violations.length === 0) {
    const rationale = [...target.rationale, `inside ${room.name}, clear of walls and other items`];
    if (req.mount !== 'floor') rationale.push(`${req.mount}-mounted at ${elevation} m`);
    if (req.rotation) rationale.push(`turned a further ${round4(req.rotation)} degrees`);
    for (const w of main.warnings) rationale.push(`warning: ${w.message}`);
    return {
      ok: true,
      placement: { roomId: room.id, position: target.position, rotation, elevation, relation: withElevation(target.relation, elevation) },
      rationale,
      warnings: main.warnings,
    };
  }

  // alternatives
  const candidates: Placement[] = [];
  const kept: Vec2[] = [];
  let walkwayChecks = 0;
  const failedWalkway: Vec2[] = [];
  const scored: { placement: Placement; penalty: number }[] = [];
  const wanted = req.maxCandidates;
  if (wanted > 0) {
    const poses = sample(scene, room, req, target, rotation);
    let looked = 0;
    for (const pose of poses) {
      if (scored.length >= wanted * 3) break;
      // poses come nearest first, so stopping early keeps the best ones and the order stays stable
      if (looked >= SOLVE_MAX_EVALUATIONS) break;
      looked++;
      if (kept.some((k) => Math.hypot(k[0] - pose.position[0], k[1] - pose.position[1]) < MIN_CANDIDATE_SPACING_M)) continue;
      const subject = subjectAt(pose.position, pose.rotation);
      const cheap = checkSubject(ctx, subject);
      if (cheap.violations.length > 0) continue;
      if (walkwayChecks >= MAX_WALKWAY_CHECKS) break;
      if (failedWalkway.some((f) => Math.hypot(f[0] - pose.position[0], f[1] - pose.position[1]) < WALKWAY_FAIL_RADIUS_M)) continue;
      walkwayChecks++;
      const v = fullCheck(ctx, info, subject, req.itemId);
      if (v.violations.length > 0) {
        failedWalkway.push(pose.position);
        continue;
      }
      kept.push(pose.position);
      scored.push({
        placement: { roomId: room.id, position: pose.position, rotation: pose.rotation, elevation, relation: withElevation(pose.relation, elevation) },
        penalty: clearancePenalty(ctx, subject, req.clearance),
      });
    }
    if (stats) {
      stats.poses = looked;
      stats.walkwayChecks = walkwayChecks;
    }
    // soft preference: pick the alternatives with the most free space around them; stable on the distance order
    const ranked = scored.map((s, i) => ({ s, i })).sort((a, b) => a.s.penalty - b.s.penalty || a.i - b.i);
    for (const r of ranked.slice(0, wanted)) candidates.push(r.s.placement);
  }
  return fail(main.violations, candidates);
}
