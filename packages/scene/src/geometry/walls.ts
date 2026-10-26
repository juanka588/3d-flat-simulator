import type { Opening, Scene, Wall } from '../schema';
import { MeshBuilder, type Vec3 } from './builder';
import { clampedOpeningSpans } from './openings';
import { computeWallJunctions, type WallFootprint } from './junctions';
import { wallEdgeMaterial, wallSideMaterial } from './materials';
import type { MeshData, WallFace } from './types';

const EPS = 1e-6;
/** Triangles smaller than this (m²) are dropped. */
const MIN_AREA = 1e-9;

type Range = [number, number];
type Owner = { kind: 'wall' | 'opening'; entityId: string; face?: WallFace };

/**
 * A wall's local frame. `s` runs along the centreline from `start`, `d` across the wall
 * (positive towards the left side), `y` is up. World: X = plan x, Z = plan y.
 */
export interface WallFrame {
  origin: [number, number];
  u: [number, number];
  n: [number, number];
  length: number;
  half: number;
  height: number;
}

export { openingSpan } from './openings';

export function wallFrame(wall: Wall): WallFrame {
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  const length = Math.hypot(dx, dy);
  const u: [number, number] = [dx / length, dy / length];
  return {
    origin: [wall.start[0], wall.start[1]],
    u,
    n: [u[1], -u[0]],
    length,
    half: wall.thickness / 2,
    height: wall.height,
  };
}

export function framePoint(f: WallFrame, s: number, d: number, y: number): Vec3 {
  return [f.origin[0] + f.u[0] * s + f.n[0] * d, y, f.origin[1] + f.u[1] * s + f.n[1] * d];
}

/** World direction for a local (s, d) direction. */
export function frameDir(f: WallFrame, ds: number, dd: number, dy = 0): Vec3 {
  return [f.u[0] * ds + f.n[0] * dd, dy, f.u[1] * ds + f.n[1] * dd];
}

/**
 * Adds a planar quad whose winding is fixed up to match `normal`. Triangles with (almost) no
 * area are dropped, so degenerate quads (a corner collapsed onto another) are safe.
 */
export function emitQuad(
  b: MeshBuilder,
  corners: [Vec3, Vec3, Vec3, Vec3],
  normal: Vec3,
  uvs: [number, number][],
  materialId: string,
  owner: Owner,
): void {
  const len = Math.hypot(...normal);
  const nrm: Vec3 = [normal[0] / len, normal[1] / len, normal[2] / len];
  let c = corners;
  let t = uvs;
  // Newell normal of the quad.
  let gx = 0;
  let gy = 0;
  let gz = 0;
  for (let i = 0; i < 4; i++) {
    const p = c[i]!;
    const q = c[(i + 1) % 4]!;
    gx += (p[1] - q[1]) * (p[2] + q[2]);
    gy += (p[2] - q[2]) * (p[0] + q[0]);
    gz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  if (gx * nrm[0] + gy * nrm[1] + gz * nrm[2] < 0) {
    c = [c[0], c[3], c[2], c[1]];
    t = [t[0]!, t[3]!, t[2]!, t[1]!];
  }
  const area = (a: Vec3, bb: Vec3, cc: Vec3) => {
    const ux = bb[0] - a[0];
    const uy = bb[1] - a[1];
    const uz = bb[2] - a[2];
    const vx = cc[0] - a[0];
    const vy = cc[1] - a[1];
    const vz = cc[2] - a[2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };
  const first = area(c[0], c[1], c[2]) >= MIN_AREA;
  const second = area(c[0], c[2], c[3]) >= MIN_AREA;
  if (!first && !second) return;
  const idx = c.map((p, k) => b.vertex(p, nrm, t[k] as [number, number])) as [number, number, number, number];
  if (first) b.triangle(idx[0], idx[1], idx[2], materialId, owner);
  if (second) b.triangle(idx[0], idx[2], idx[3], materialId, owner);
}

/** Parts of `a` not covered by `b`; both are sorted lists of disjoint ranges. */
function subtract(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  for (const [lo, hi] of a) {
    let cur = lo;
    for (const [blo, bhi] of b) {
      if (bhi <= cur || blo >= hi) continue;
      if (blo > cur) out.push([cur, blo]);
      cur = Math.max(cur, bhi);
    }
    if (cur < hi) out.push([cur, hi]);
  }
  return out.filter(([lo, hi]) => hi - lo > EPS);
}

interface Segment {
  aL: number;
  bL: number;
  aR: number;
  bR: number;
  /** Solid y-ranges in this stretch of the wall. */
  solid: Range[];
}

/** Wall solids with openings cut out and junctions resolved. Boxes around holes, no CSG. */
export function buildWalls(scene: Scene): MeshData {
  const b = new MeshBuilder();
  const footprints = computeWallJunctions(scene.walls);
  const edgeMat = wallEdgeMaterial(scene);
  const openingsByWall = new Map<string, Opening[]>();
  for (const o of scene.openings) {
    const list = openingsByWall.get(o.wallId) ?? [];
    list.push(o);
    openingsByWall.set(o.wallId, list);
  }

  for (const wall of scene.walls) {
    const frame = wallFrame(wall);
    if (!(frame.length > EPS)) continue;
    const fp = footprints.get(wall.id) ?? {
      startLeft: 0,
      startRight: 0,
      endLeft: frame.length,
      endRight: frame.length,
    };
    buildWall(b, scene, wall, frame, fp, openingsByWall.get(wall.id) ?? [], edgeMat);
  }
  return b.build();
}

function buildWall(
  b: MeshBuilder,
  scene: Scene,
  wall: Wall,
  f: WallFrame,
  fp: WallFootprint,
  openings: Opening[],
  edgeMat: string,
): void {
  const H = f.height;
  const h = f.half;
  const own = (face: WallFace): Owner => ({ kind: 'wall', entityId: wall.id, face });
  const pt = (s: number, d: number, y: number) => framePoint(f, s, d, y);

  const holes = clampedOpeningSpans(openings, fp, H);

  // Segments along the wall: solid stretches and holes.
  const segs: Segment[] = [];
  const solidSeg = (from: number | null, to: number | null) => {
    const aL = from ?? fp.startLeft;
    const aR = from ?? fp.startRight;
    const bL = to ?? fp.endLeft;
    const bR = to ?? fp.endRight;
    const empty = bL - aL <= EPS && bR - aR <= EPS;
    segs.push({ aL, bL: Math.max(aL, bL), aR, bR: Math.max(aR, bR), solid: empty ? [] : [[0, H]] });
  };
  let prevTo: number | null = null;
  for (const hole of holes) {
    solidSeg(prevTo, hole.from);
    const solid: Range[] = [];
    if (hole.sill > EPS) solid.push([0, hole.sill]);
    if (H - hole.top > EPS) solid.push([hole.top, H]);
    segs.push({ aL: hole.from, bL: hole.to, aR: hole.from, bR: hole.to, solid });
    prevTo = hole.to;
  }
  solidSeg(prevTo, null);

  const leftMat = wallSideMaterial(scene, wall, 'left');
  const rightMat = wallSideMaterial(scene, wall, 'right');
  const nL = frameDir(f, 0, 1);
  const nR = frameDir(f, 0, -1);

  for (const seg of segs) {
    for (const [y0, y1] of seg.solid) {
      emitQuad(
        b,
        [pt(seg.aL, h, y0), pt(seg.bL, h, y0), pt(seg.bL, h, y1), pt(seg.aL, h, y1)],
        nL,
        // Mirrored (u = length - s) so u grows to the viewer's right when facing the left face.
        [[f.length - seg.aL, y0], [f.length - seg.bL, y0], [f.length - seg.bL, y1], [f.length - seg.aL, y1]],
        leftMat,
        own('left'),
      );
      emitQuad(
        b,
        [pt(seg.aR, -h, y0), pt(seg.bR, -h, y0), pt(seg.bR, -h, y1), pt(seg.aR, -h, y1)],
        nR,
        [[seg.aR, y0], [seg.bR, y0], [seg.bR, y1], [seg.aR, y1]],
        rightMat,
        own('right'),
      );
      const horizontal = (y: number, up: boolean, face: WallFace) =>
        emitQuad(
          b,
          [pt(seg.aL, h, y), pt(seg.bL, h, y), pt(seg.bR, -h, y), pt(seg.aR, -h, y)],
          [0, up ? 1 : -1, 0],
          [[seg.aL, 2 * h], [seg.bL, 2 * h], [seg.bR, 0], [seg.aR, 0]],
          edgeMat,
          own(face),
        );
      horizontal(y1, true, y1 >= H - EPS ? 'top' : 'jamb');
      if (y0 > EPS) horizontal(y0, false, 'jamb');
    }
  }

  // Vertical faces between neighbouring segments, and the two end caps.
  const vertical = (
    pL: [number, number],
    pR: [number, number],
    ranges: Range[],
    normal: Vec3,
    face: WallFace,
  ) => {
    for (const [y0, y1] of ranges) {
      emitQuad(
        b,
        [pt(pL[0], pL[1], y0), pt(pR[0], pR[1], y0), pt(pR[0], pR[1], y1), pt(pL[0], pL[1], y1)],
        normal,
        [[pL[1] + h, y0], [pR[1] + h, y0], [pR[1] + h, y1], [pL[1] + h, y1]],
        edgeMat,
        own(face),
      );
    }
  };
  const first = segs[0]!;
  const last = segs[segs.length - 1]!;
  // Cap normal: perpendicular to the (s, d) segment between the left and right corners.
  const startNormal = frameDir(f, -2 * h, -(first.aR - first.aL));
  vertical([first.aL, h], [first.aR, -h], first.solid, startNormal, 'end');
  const endNormal = frameDir(f, 2 * h, last.bR - last.bL);
  vertical([last.bL, h], [last.bR, -h], last.solid, endNormal, 'end');
  for (let i = 1; i < segs.length; i++) {
    const before = segs[i - 1]!.solid;
    const after = segs[i]!.solid;
    const s = segs[i]!.aL;
    vertical([s, h], [s, -h], subtract(before, after), frameDir(f, 1, 0), 'jamb');
    vertical([s, h], [s, -h], subtract(after, before), frameDir(f, -1, 0), 'jamb');
  }
}
