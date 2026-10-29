import type { Cornice, Panelling, Room, Scene, Wall } from '../schema';
import { boxOfItem } from '../placement/footprint';
import type { WallSideSegment } from '../lighting/daylight';
import { MeshBuilder, type Vec3 } from './builder';
import { roomCeilingHeight } from './floors';
import type { Hole } from './openings';
import { ceilingMaterial, wallFaceMaterial } from './materials';
import { emitQuad, frameDir, framePoint, type WallFrame } from './walls';
import type { WallFootprint } from './junctions';
import type { WallFace } from './types';

/**
 * Wall mouldings (boiserie) and ceiling cornices as real low-poly geometry, appended to the wall mesh.
 *
 * - Frames are bevelled rectangular rings (3 bands per side, mitred by construction) laid out by `layoutFace`,
 *   a pure function: panels are spread over the free stretches of a wall face, never crossing a door, window,
 *   passage or locked fitting, and stretches too short for a panel are skipped.
 * - Mouldings use the material of the wall face they sit on (tone on tone) unless the panelling names a colour,
 *   so they add no draw call; a colour adds one shared `builtin:paint:#rrggbb` material.
 */

/** Defaults for the optional sizes of `Panelling` / `Cornice`. */
export const PANELLING_DEFAULTS = { depthMm: 18, dadoHeightMm: 900 } as const;

/** Layout constants, metres. */
export const PANEL_LAYOUT = {
  /** Frames start this high above the floor (skirting board). */
  skirting: 0.12,
  /** Gap between the top of the frames and the ceiling (cornice zone). */
  topGap: 0.22,
  /** Distance of the first/last frame from a corner or the end of a face. */
  edgeMargin: 0.06,
  /** Distance kept between a frame and a door, window or fitting. */
  clearance: 0.1,
  /** Gap between neighbouring frames of a row. */
  gap: 0.07,
  /** Preferred frame width. */
  targetWidth: 0.8,
  /** Narrowest frame worth drawing. */
  minWidth: 0.3,
  /** Shortest frame worth drawing. */
  minHeight: 0.35,
  /** Width of the moulding (outer edge to inner edge of the ring). */
  moulding: 0.045,
  /** Space between a dado rail and the frames above and below it. */
  railGap: 0.08,
  /** Height of the dado rail. */
  railHeight: 0.06,
  /** Shortest rail piece worth drawing. */
  minRail: 0.2,
} as const;

export const BUILTIN_PAINT_PREFIX = 'builtin:paint:';
/** Material id of a moulding painted with its own colour (`#rrggbb`); the viewer builds it on demand. */
export const paintMaterialId = (hex: string): string => `${BUILTIN_PAINT_PREFIX}${hex.toLowerCase()}`;

const EPS = 1e-6;
type Side = 'left' | 'right';

export interface FaceObstacle {
  /** Along the wall centreline. */
  from: number;
  to: number;
  /** Height range above the floor. */
  y0: number;
  y1: number;
}

/** Outer bounds of one frame, along the wall (`s0..s1`) and up (`y0..y1`). */
export interface PanelRect {
  s0: number;
  s1: number;
  y0: number;
  y1: number;
}

export interface RailSpan {
  s0: number;
  s1: number;
  /** Centre height of the rail. */
  y: number;
}

export interface FaceLayout {
  frames: PanelRect[];
  rails: RailSpan[];
}

export interface LayoutInput {
  /** Usable stretch of the face along the wall centreline. */
  from: number;
  to: number;
  /** Floor-to-ceiling height of the face. */
  height: number;
  style: Exclude<Panelling['style'], 'none'>;
  /** Rail centre height (m); only for `dado` styles. */
  railY: number;
  /** Extra clear space under the ceiling (m), e.g. for a cornice. */
  topGap?: number;
  obstacles: readonly FaceObstacle[];
}

/** Merged free stretches of `[from, to]` once the obstacles (grown by `pad`) are removed. */
function freeStretches(from: number, to: number, blocked: readonly [number, number][], pad: number): [number, number][] {
  const sorted = blocked.map(([a, b]) => [a - pad, b + pad] as [number, number]).sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let cursor = from;
  for (const [a, b] of sorted) {
    if (b <= cursor) continue;
    if (a > cursor) out.push([cursor, Math.min(a, to)]);
    cursor = Math.max(cursor, b);
    if (cursor >= to) break;
  }
  if (cursor < to) out.push([cursor, to]);
  return out.filter(([a, b]) => b - a > EPS);
}

/** Frames of one row: as many equal panels as fit in each free stretch, none narrower than `minWidth`. */
function rowFrames(stretches: readonly [number, number][], y0: number, y1: number): PanelRect[] {
  const L = PANEL_LAYOUT;
  const out: PanelRect[] = [];
  for (const [a, b] of stretches) {
    const len = b - a;
    let n = Math.max(1, Math.round((len + L.gap) / (L.targetWidth + L.gap)));
    while (n > 0 && (len - (n - 1) * L.gap) / n < L.minWidth) n--;
    if (n === 0) continue;
    const w = (len - (n - 1) * L.gap) / n;
    for (let i = 0; i < n; i++) out.push({ s0: a + i * (w + L.gap), s1: a + i * (w + L.gap) + w, y0, y1 });
  }
  return out;
}

/**
 * Lays frames and rail pieces out on one wall face. Pure. A frame never overlaps an obstacle (door, window,
 * passage, locked fitting) whose height range meets the frame's, with `PANEL_LAYOUT.clearance` to spare.
 */
export function layoutFace(input: LayoutInput): FaceLayout {
  const L = PANEL_LAYOUT;
  const top = input.height - (input.topGap ?? 0) - L.topGap;
  const rows: [number, number][] = [];
  const rail = input.style !== 'frames';
  if (input.style === 'frames') rows.push([L.skirting, top]);
  else {
    rows.push([L.skirting, input.railY - L.railHeight / 2 - L.railGap]);
    if (input.style === 'frames+dado') rows.push([input.railY + L.railHeight / 2 + L.railGap, top]);
  }
  const frames: PanelRect[] = [];
  for (const [y0, y1] of rows) {
    if (y1 - y0 < L.minHeight) continue;
    const blocked = input.obstacles.filter((o) => o.y0 < y1 + L.clearance && o.y1 > y0 - L.clearance).map((o) => [o.from, o.to] as [number, number]);
    const stretches = freeStretches(input.from + L.edgeMargin, input.to - L.edgeMargin, blocked, L.clearance);
    frames.push(...rowFrames(stretches, y0, y1));
  }
  const rails: RailSpan[] = [];
  if (rail && input.railY + L.railHeight < input.height) {
    const lo = input.railY - L.railHeight / 2;
    const hi = input.railY + L.railHeight / 2;
    const blocked = input.obstacles.filter((o) => o.y0 < hi && o.y1 > lo).map((o) => [o.from, o.to] as [number, number]);
    for (const [a, b] of freeStretches(input.from, input.to, blocked, 0)) if (b - a >= L.minRail) rails.push({ s0: a, s1: b, y: input.railY });
  }
  return { frames, rails };
}

/** Panelling that applies to a face (wall side first, else the room's), or undefined when none/`none`. */
export function wallFacePanelling(scene: Pick<Scene, 'rooms'>, wall: Pick<Wall, 'panelling'>, side: Side, roomId: string | undefined): Panelling | undefined {
  const own = wall.panelling?.[side];
  const p = own ?? (roomId === undefined ? undefined : scene.rooms.find((r) => r.id === roomId)?.panelling);
  return p && p.style !== 'none' ? p : undefined;
}

/** Locked, non-flat items standing against a face of the wall, as obstacles along it. */
export function fittingObstacles(scene: Pick<Scene, 'items'>, frame: WallFrame, side: Side): FaceObstacle[] {
  const sign = side === 'left' ? 1 : -1;
  const out: FaceObstacle[] = [];
  scene.items.forEach((item, index) => {
    if (item.locked !== true) return;
    const box = boxOfItem(item, index);
    if (box.flat) return;
    let s0 = Infinity;
    let s1 = -Infinity;
    let dMin = Infinity;
    let dMax = -Infinity;
    for (const p of box.footprint) {
      const x = p[0] - frame.origin[0];
      const y = p[1] - frame.origin[1];
      const s = x * frame.u[0] + y * frame.u[1];
      const d = (x * frame.n[0] + y * frame.n[1]) * sign;
      s0 = Math.min(s0, s);
      s1 = Math.max(s1, s);
      dMin = Math.min(dMin, d);
      dMax = Math.max(dMax, d);
    }
    // The item stands on this side of the wall and (nearly) touches the face.
    if (dMax < frame.half - 0.02 || dMin > frame.half + 0.15) return;
    if (s1 < 0 || s0 > frame.length) return;
    out.push({ from: s0, to: s1, y0: box.bottom, y1: box.top });
  });
  return out;
}

// ---- geometry ---------------------------------------------------------------------------------------

/** Cross-section point: `inset` towards the middle of the frame (m), `out` away from the wall (m). */
type ProfilePoint = readonly [inset: number, out: number];

function frameProfile(depth: number): ProfilePoint[] {
  const m = PANEL_LAYOUT.moulding;
  return [
    [0, 0],
    [0.01, depth],
    [0.03, depth],
    [m, depth * 0.3],
    [m, 0],
  ];
}

interface Face {
  b: MeshBuilder;
  f: WallFrame;
  side: Side;
  material: string;
  wallId: string;
}

const faceOwner = (c: Face) => ({ kind: 'wall' as const, entityId: c.wallId, face: c.side as WallFace });
const faceNormal = (c: Face): Vec3 => frameDir(c.f, 0, c.side === 'left' ? 1 : -1);

/** Face-plane point at wall coordinate `s`, height `y`, `out` metres in front of the face. */
function facePoint(c: Face, s: number, y: number, out: number): Vec3 {
  const d = (c.side === 'left' ? 1 : -1) * (c.f.half + out);
  return framePoint(c.f, s, d, y);
}

/** UV of a point on the face, matching the plain face (mirrored on the left side). */
function faceUv(c: Face, s: number, y: number): [number, number] {
  return [c.side === 'left' ? c.f.length - s : s, y];
}

/** One quad of a moulding band; the normal is given in (along-face direction, up, out) components. */
function bandQuad(c: Face, corners: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]], normal: [number, number, number]): void {
  const pts = corners.map(([s, y, out]) => facePoint(c, s, y, out)) as [Vec3, Vec3, Vec3, Vec3];
  const out = faceNormal(c);
  const along = frameDir(c.f, 1, 0);
  const n: Vec3 = [
    along[0] * normal[0] + out[0] * normal[2],
    normal[1] + out[1] * normal[2],
    along[2] * normal[0] + out[2] * normal[2],
  ];
  emitQuad(c.b, pts, n, corners.map(([s, y]) => faceUv(c, s, y)), c.material, faceOwner(c));
}

/** A bevelled rectangular ring (picture frame) with the outer bounds `r`. */
function emitFrame(c: Face, r: PanelRect, depth: number): void {
  const prof = frameProfile(depth);
  for (let k = 0; k + 1 < prof.length; k++) {
    const [i0, o0] = prof[k]!;
    const [i1, o1] = prof[k + 1]!;
    const di = i1 - i0;
    const dout = o1 - o0;
    if (Math.abs(di) < EPS && Math.abs(dout) < EPS) continue;
    // Outward-facing normal of this band in (inward, out); inward is towards the middle of the frame.
    const ni = -dout;
    const no = di;
    const corner = (i: number, o: number): [[number, number, number], [number, number, number], [number, number, number], [number, number, number]] => [
      [r.s0 + i, r.y0 + i, o],
      [r.s1 - i, r.y0 + i, o],
      [r.s1 - i, r.y1 - i, o],
      [r.s0 + i, r.y1 - i, o],
    ];
    const a = corner(i0, o0);
    const b = corner(i1, o1);
    // Bottom (inward = up), right (inward = -s), top (inward = down), left (inward = +s).
    bandQuad(c, [a[0], a[1], b[1], b[0]], [0, ni, no]);
    bandQuad(c, [a[1], a[2], b[2], b[1]], [-ni, 0, no]);
    bandQuad(c, [a[2], a[3], b[3], b[2]], [0, -ni, no]);
    bandQuad(c, [a[3], a[0], b[0], b[3]], [ni, 0, no]);
  }
}

/** A dado rail piece: a trapezoid bar along the face, with end caps. */
function emitRail(c: Face, span: RailSpan, depth: number): void {
  const hw = PANEL_LAYOUT.railHeight / 2;
  const prof: ProfilePoint[] = [
    [-hw, 0],
    [-hw + 0.012, depth],
    [hw - 0.012, depth],
    [hw, 0],
  ];
  for (let k = 0; k + 1 < prof.length; k++) {
    const [v0, o0] = prof[k]!;
    const [v1, o1] = prof[k + 1]!;
    // Surface from (v0, o0) to (v1, o1) in (up, out); normal = (-dout, dv) in (up, out).
    bandQuad(c, [[span.s0, span.y + v0, o0], [span.s1, span.y + v0, o0], [span.s1, span.y + v1, o1], [span.s0, span.y + v1, o1]], [0, -(o1 - o0), v1 - v0]);
  }
  const cap = (s: number, sign: 1 | -1) => {
    const pts: [number, number, number][] = prof.map(([v, o]) => [s, span.y + v, o]);
    // Two triangles of the trapezoid, as two quads sharing the middle edge.
    bandQuad(c, [pts[0]!, pts[1]!, pts[2]!, pts[3]!], [sign, 0, 0]);
  };
  cap(span.s0, -1);
  cap(span.s1, 1);
}

/** Cornice cross-section: (down from the ceiling, out from the wall). */
function corniceProfile(height: number, projection: number): ProfilePoint[] {
  return [
    [height, 0],
    [height, projection * 0.15],
    [height * 0.55, projection * 0.38],
    [height * 0.2, projection * 0.7],
    [0, projection],
  ];
}

function emitCornice(c: Face, s0: number, s1: number, ceilingY: number, height: number, projection: number): void {
  const prof = corniceProfile(height, projection);
  for (let k = 0; k + 1 < prof.length; k++) {
    const [d0, o0] = prof[k]!;
    const [d1, o1] = prof[k + 1]!;
    // Surface from (down d0, out o0) to (d1, o1); normal in (up, out): the cove faces down and out.
    const dy = -(d1 - d0); // change in height
    const dout = o1 - o0;
    bandQuad(c, [[s0, ceilingY - d0, o0], [s1, ceilingY - d0, o0], [s1, ceilingY - d1, o1], [s0, ceilingY - d1, o1]], [0, -dout, dy]);
  }
}

// ---- scene-level assembly -----------------------------------------------------------------------------

interface Run {
  side: Side;
  from: number;
  to: number;
  roomId: string | undefined;
}

/** Consecutive stretches of a face seen from the same room (or none), merged. */
function faceRuns(segments: readonly WallSideSegment[], side: Side): Run[] {
  const runs: Run[] = [];
  for (const seg of segments) {
    const roomId = seg[side];
    const last = runs[runs.length - 1];
    if (last && last.roomId === roomId && seg.from <= last.to + EPS) last.to = seg.to;
    else runs.push({ side, from: seg.from, to: seg.to, roomId });
  }
  return runs;
}

function holeObstacles(holes: readonly Hole[]): FaceObstacle[] {
  return holes.map((h) => ({ from: h.from, to: h.to, y0: h.sill, y1: h.top }));
}

/**
 * Appends the mouldings and cornices of one wall to the wall mesh `b`. Called by `buildWalls` with the same
 * junction footprint, openings holes and per-room face stretches it used for the plain faces.
 */
export function buildWallMouldings(
  b: MeshBuilder,
  scene: Scene,
  wall: Wall,
  f: WallFrame,
  fp: WallFootprint,
  holes: readonly Hole[],
  roomSegments: readonly WallSideSegment[],
): void {
  for (const side of ['left', 'right'] as const) {
    const faceFrom = side === 'left' ? fp.startLeft : fp.startRight;
    const faceTo = side === 'left' ? fp.endLeft : fp.endRight;
    let fittings: FaceObstacle[] | undefined;
    for (const run of faceRuns(roomSegments, side)) {
      const room: Room | undefined = run.roomId === undefined ? undefined : scene.rooms.find((r) => r.id === run.roomId);
      const panelling = wallFacePanelling(scene, wall, side, run.roomId);
      const cornice: Cornice | undefined = room?.cornice;
      if (!panelling && !cornice) continue;
      const from = Math.max(run.from, faceFrom);
      const to = Math.min(run.to, faceTo);
      if (to - from < EPS) continue;
      const height = room ? Math.min(wall.height, roomCeilingHeight(scene, room)) : wall.height;
      const face = (material: string): Face => ({ b, f, side, material, wallId: wall.id });
      if (panelling) {
        fittings ??= fittingObstacles(scene, f, side);
        const depth = (panelling.depthMm ?? PANELLING_DEFAULTS.depthMm) / 1000;
        const layout = layoutFace({
          from,
          to,
          height,
          style: panelling.style as LayoutInput['style'],
          railY: (panelling.dadoHeightMm ?? PANELLING_DEFAULTS.dadoHeightMm) / 1000,
          topGap: cornice ? cornice.heightMm / 1000 : 0,
          obstacles: [...holeObstacles(holes), ...fittings],
        });
        const material = (mid: number) => (panelling.colour ? paintMaterialId(panelling.colour) : wallFaceMaterial(scene, wall, side, roomAt(roomSegments, side, mid)));
        for (const r of layout.frames) emitFrame(face(material((r.s0 + r.s1) / 2)), r, depth);
        for (const r of layout.rails) emitRail(face(material((r.s0 + r.s1) / 2)), r, depth);
      }
      if (cornice && room) {
        const h = cornice.heightMm / 1000;
        const p = (cornice.projectionMm ?? cornice.heightMm) / 1000;
        const material = cornice.colour ? paintMaterialId(cornice.colour) : ceilingMaterial(scene, room);
        const blocked = holes.filter((hole) => hole.top > height - h).map((hole) => [hole.from, hole.to] as [number, number]);
        for (const [a, z] of freeStretches(from, to, blocked, 0)) if (z - a > EPS) emitCornice(face(material), a, z, height, h, p);
      }
    }
  }
}

function roomAt(segments: readonly WallSideSegment[], side: Side, s: number): string | undefined {
  return segments.find((seg) => s >= seg.from - EPS && s <= seg.to + EPS)?.[side];
}
