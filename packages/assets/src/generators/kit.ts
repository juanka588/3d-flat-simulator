import { z } from 'zod';
import { MeshBuilder } from '@flat/scene';
import type { GeneratorAnchor, MeshData } from '@flat/scene';
import { COLOUR_NAMES, ITEM_MATERIALS } from '../materials/item-materials';

type Vec3 = [number, number, number];

/**
 * Shared building blocks of the parametric generators. Everything is in the ITEM-LOCAL frame of
 * `builtin.ts` (origin at the footprint centre on the floor, +y up, front +z). Generators only use
 * axis-aligned boxes, so bounding boxes are exact by construction.
 */

/** Owner entity id of generated meshes; `buildItems` re-owns the triangles to the real item id. */
export const GENERATOR_OWNER_ID = 'item';
const OWNER = { kind: 'item' as const, entityId: GENERATOR_OWNER_ID };

/** Thickness of carcass panels. */
export const PANEL = 0.018;
/** Thickness of door and drawer fronts. */
export const FRONT = 0.018;
/** Handle protrusion in front of a front panel. */
export const HANDLE = 0.008;

/** Default edge chamfer per material, in metres (a real arris: 1.5-3 mm on panels, softer on upholstery; worktops stay sharp so neighbouring modules join into one top). */
const BEVEL: Readonly<Record<string, number>> = {
  [ITEM_MATERIALS.white]: 0.0025,
  [ITEM_MATERIALS.whiteMatte]: 0.0025,
  [ITEM_MATERIALS.wood]: 0.0025,
  [ITEM_MATERIALS.oak]: 0.0025,
  [ITEM_MATERIALS.walnut]: 0.0025,
  [ITEM_MATERIALS.dark]: 0.0025,
  [ITEM_MATERIALS.anthracite]: 0.0025,
  [ITEM_MATERIALS.concreteDark]: 0.0025,
  [ITEM_MATERIALS.oakLight]: 0.0025,
  [ITEM_MATERIALS.enamel]: 0.003,
  [ITEM_MATERIALS.metal]: 0.0015,
  [ITEM_MATERIALS.ceramic]: 0.008,
  [ITEM_MATERIALS.fabric]: 0.02,
  [ITEM_MATERIALS.bedding]: 0.025,
  [ITEM_MATERIALS.tvBody]: 0.002,
};
/** Above this many triangles the next boxes stay sharp, so a generator with many parts keeps inside its 3k budget. */
const BEVEL_TRIANGLE_CAP = 2200;
/** Smallest chamfer worth the extra triangles. */
const MIN_BEVEL = 0.0008;

type Axis = 0 | 1 | 2;

/** UV (metres) of a point for a face whose dominant axis is `m`: z faces use (x, y), x faces (z, y), y faces (x, z). */
function uvOf(m: Axis, p: Vec3): [number, number] {
  return m === 2 ? [p[0], p[1]] : m === 0 ? [p[2], p[1]] : [p[0], p[2]];
}

export class Kit {
  private readonly b = new MeshBuilder();

  /** Triangles added so far. */
  get triangles(): number {
    return this.b.triangleCount;
  }

  /**
   * Adds an axis-aligned box `[x0,y0,z0]-[x1,y1,z1]` in `material`; degenerate boxes are skipped. Edges are chamfered
   * (`bevel` metres; default per material, 0 = sharp) with normals blended across the chamfer, so it reads as a rounded
   * edge and catches a highlight; the outer bounding box is exact. UVs are in metres of the item frame, so a texture
   * keeps its real-world scale and runs on across neighbouring parts.
   */
  box(material: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, bevel?: number): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    if (dx < 1e-9 || dy < 1e-9 || dz < 1e-9) return;
    let r = Math.min(bevel ?? BEVEL[material] ?? 0, Math.min(dx, dy, dz) / 4);
    if (r < MIN_BEVEL || this.b.triangleCount > BEVEL_TRIANGLE_CAP) r = 0;
    if (r === 0) {
      this.sharpBox(material, x0, y0, z0, x1, y1, z1);
      return;
    }
    const lo: Vec3 = [x0, y0, z0];
    const hi: Vec3 = [x1, y1, z1];
    // F(corner, axis): the vertex of the face on `axis` at a corner (signs -1/+1): on the outer plane, inset by r on the other axes.
    const F = (s: readonly [number, number, number], a: Axis): Vec3 => {
      const p: Vec3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) p[k] = k === a ? (s[k]! > 0 ? hi[k]! : lo[k]!) : s[k]! > 0 ? hi[k]! - r : lo[k]! + r;
      return p;
    };
    const N = (s: readonly [number, number, number], a: Axis): Vec3 => {
      const n: Vec3 = [0, 0, 0];
      n[a] = s[a]!;
      return n;
    };
    const emit = (verts: { p: Vec3; n: Vec3 }[], m: Axis) => {
      const ids = verts.map((v) => this.b.vertex(v.p, v.n, uvOf(m, v.p)));
      const tris = verts.length === 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]];
      for (const [a, c, d] of tris as [number, number, number][]) {
        const pa = verts[a]!.p;
        const pb = verts[c]!.p;
        const pc = verts[d]!.p;
        const u: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        const w: Vec3 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
        const g: Vec3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const an = verts[a]!.n;
        const bn = verts[c]!.n;
        const cn = verts[d]!.n;
        const sum: Vec3 = [an[0] + bn[0] + cn[0], an[1] + bn[1] + cn[1], an[2] + bn[2] + cn[2]];
        const outward = g[0] * sum[0] + g[1] * sum[1] + g[2] * sum[2] > 0;
        if (outward) this.b.triangle(ids[a]!, ids[c]!, ids[d]!, material, OWNER);
        else this.b.triangle(ids[a]!, ids[d]!, ids[c]!, material, OWNER);
      }
    };
    const signs = [-1, 1] as const;
    // Six faces.
    for (const a of [0, 1, 2] as Axis[]) {
      for (const sa of signs) {
        const b1 = ((a + 1) % 3) as Axis;
        const b2 = ((a + 2) % 3) as Axis;
        const quad: { p: Vec3; n: Vec3 }[] = [];
        for (const [s1, s2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          const s: [number, number, number] = [0, 0, 0];
          s[a] = sa;
          s[b1] = s1;
          s[b2] = s2;
          quad.push({ p: F(s, a), n: N(s, a) });
        }
        emit(quad, a);
      }
    }
    // Twelve edge chamfers: faces a and b (signs sa, sb) meet along axis c.
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as [Axis, Axis][]) {
      const c = (3 - a - b) as Axis;
      for (const sa of signs) {
        for (const sb of signs) {
          const end = (sc: number) => {
            const s: [number, number, number] = [0, 0, 0];
            s[a] = sa;
            s[b] = sb;
            s[c] = sc;
            return s;
          };
          const s0 = end(-1);
          const s1 = end(1);
          emit([{ p: F(s0, a), n: N(s0, a) }, { p: F(s0, b), n: N(s0, b) }, { p: F(s1, b), n: N(s1, b) }, { p: F(s1, a), n: N(s1, a) }], a);
        }
      }
    }
    // Eight corner triangles.
    for (const sx of signs) {
      for (const sy of signs) {
        for (const sz of signs) {
          const s = [sx, sy, sz] as const;
          emit([{ p: F(s, 0), n: N(s, 0) }, { p: F(s, 1), n: N(s, 1) }, { p: F(s, 2), n: N(s, 2) }], 1);
        }
      }
    }
  }

  /**
   * An upward-facing rectangle at height `y` with UV 0-1 over it (u along +x, v from the front `z1` towards the back
   * `z0`): a product photo laid on a rug, cushion or throw. The photo is already cropped by the viewer.
   */
  topFace(material: string, x0: number, z0: number, x1: number, z1: number, y: number): void {
    if (x1 - x0 < 1e-9 || z1 - z0 < 1e-9) return;
    this.b.quad([[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]], material, OWNER);
  }

  /** A rectangle facing +z (the front) at depth `z` with UV 0-1 over it: the picture of a frame. */
  frontFace(material: string, x0: number, y0: number, x1: number, y1: number, z: number): void {
    if (x1 - x0 < 1e-9 || y1 - y0 < 1e-9) return;
    this.b.quad([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], [0, 0, 1], [[0, 0], [1, 0], [1, 1], [0, 1]], material, OWNER);
  }

  /** A box with sharp edges (12 triangles). */
  private sharpBox(material: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const b = this.b;
    const faces: { n: Vec3; c: [Vec3, Vec3, Vec3, Vec3]; m: Axis }[] = [
      { n: [0, 0, 1], c: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], m: 2 },
      { n: [0, 0, -1], c: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], m: 2 },
      { n: [1, 0, 0], c: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], m: 0 },
      { n: [-1, 0, 0], c: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], m: 0 },
      { n: [0, 1, 0], c: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], m: 1 },
      { n: [0, -1, 0], c: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], m: 1 },
    ];
    for (const f of faces) {
      const uv = f.c.map((p) => uvOf(f.m, p)) as [[number, number], [number, number], [number, number], [number, number]];
      b.quad(f.c, f.n, uv, material, OWNER);
    }
  }

  /**
   * A bar handle standing off a front whose outer face is at `zFace`: a flat bar on two small posts (or a single block when
   * short). `x, y` is the bar centre, `len` its length along the vertical or horizontal axis, `protrude` how far the bar's
   * face lies in front of `zFace` (the outer bounding box grows by exactly this).
   */
  handle(material: string, x: number, y: number, len: number, vertical: boolean, zFace: number, protrude = HANDLE): void {
    const w = 0.012; // bar width
    const post = 0.006;
    const stand = Math.min(protrude * 0.45, 0.004);
    const bar = (a0: number, a1: number, z0: number, z1: number) =>
      vertical ? this.box(material, x - w / 2, y + a0, zFace + z0, x + w / 2, y + a1, zFace + z1) : this.box(material, x + a0, y - w / 2, zFace + z0, x + a1, y + w / 2, zFace + z1);
    if (len < 0.06 || protrude < 0.004) {
      bar(-len / 2, len / 2, 0, protrude);
      return;
    }
    bar(-len / 2, len / 2, stand, protrude);
    const p = (a0: number, a1: number) =>
      vertical
        ? this.box(material, x - post / 2, y + a0, zFace, x + post / 2, y + a1, zFace + stand, 0)
        : this.box(material, x + a0, y - post / 2, zFace, x + a1, y + post / 2, zFace + stand, 0);
    p(-len / 2 + 0.01, -len / 2 + 0.01 + post);
    p(len / 2 - 0.01 - post, len / 2 - 0.01);
  }

  /**
   * Adds an upright elliptic prism (centre `cx, cz`, radii `rx, rz`, from `y0` to `y1`) with smooth side normals and a
   * top cap; no bottom cap (it rests on something). `segments` must be a multiple of 4 so the extreme points lie exactly
   * on the axes and the bounding box is exact.
   */
  prism(material: string, cx: number, y0: number, cz: number, rx: number, rz: number, y1: number, segments = 16): void {
    if (rx < 1e-9 || rz < 1e-9 || y1 - y0 < 1e-9) return;
    const b = this.b;
    const n = segments;
    const ring = (i: number) => {
      const a = (2 * Math.PI * i) / n;
      return { c: Math.cos(a), s: Math.sin(a) };
    };
    for (let i = 0; i < n; i++) {
      const p = ring(i);
      const q = ring(i + 1);
      const normal = (r: { c: number; s: number }): Vec3 => {
        const nx = r.c / rx;
        const nz = r.s / rz;
        const l = Math.hypot(nx, nz);
        return [nx / l, 0, nz / l];
      };
      const at = (r: { c: number; s: number }, y: number): Vec3 => [cx + rx * r.c, y, cz + rz * r.s];
      // Around the side: arc length in metres, so a texture keeps its real-world scale.
      const girth = 2 * Math.PI * Math.sqrt((rx * rx + rz * rz) / 2);
      const u0 = (girth * i) / n;
      const u1 = (girth * (i + 1)) / n;
      const v0 = b.vertex(at(p, y0), normal(p), [u0, 0]);
      const v1 = b.vertex(at(p, y1), normal(p), [u0, y1 - y0]);
      const v2 = b.vertex(at(q, y1), normal(q), [u1, y1 - y0]);
      const v3 = b.vertex(at(q, y0), normal(q), [u1, 0]);
      b.triangle(v0, v1, v2, material, OWNER);
      b.triangle(v0, v2, v3, material, OWNER);
      const top: Vec3 = [0, 1, 0];
      const c0 = b.vertex([cx, y1, cz], top, [cx, cz]);
      const t1 = b.vertex(at(q, y1), top, [cx + rx * q.c, cz + rz * q.s]);
      const t0 = b.vertex(at(p, y1), top, [cx + rx * p.c, cz + rz * p.s]);
      b.triangle(c0, t1, t0, material, OWNER);
    }
  }

  /**
   * A surface of revolution about the vertical axis through `(cx, cz)`: `profile` is a path of `[f, y]` points (`f` the
   * radius as a share of `rx` / `rz`, 0 to 1; `y` metres). Travel the path so that the outside of the surface is on the
   * right (up the outer wall, then inward across a top, then down an inner wall) and the normals come out outward. The
   * sides are smooth around, hard between profile segments. `segments` must be a multiple of 4 so that the widest ring
   * reaches `cx +- rx` and `cz +- rz` exactly (exact bounding boxes). Used for bowls, tubs, globes and domes.
   */
  lathe(material: string, cx: number, cz: number, rx: number, rz: number, profile: readonly (readonly [number, number])[], segments = 24): void {
    if (rx < 1e-9 || rz < 1e-9 || profile.length < 2) return;
    const b = this.b;
    const n = segments;
    const R = (rx + rz) / 2;
    for (let k = 0; k + 1 < profile.length; k++) {
      const [f0, y0] = profile[k]!;
      const [f1, y1] = profile[k + 1]!;
      if (f0 < 1e-9 && f1 < 1e-9) continue;
      const dr = (f1 - f0) * R;
      const dy = y1 - y0;
      const len = Math.hypot(dr, dy);
      if (len < 1e-12) continue;
      const nr = dy / len;
      const ny = -dr / len;
      for (let i = 0; i < n; i++) {
        const a0 = (2 * Math.PI * i) / n;
        const a1 = (2 * Math.PI * (i + 1)) / n;
        const rim = (a: number): Vec3 => {
          const hx = Math.cos(a) / rx;
          const hz = Math.sin(a) / rz;
          const l = Math.hypot(hx, hz);
          return [(hx / l) * nr, ny, (hz / l) * nr];
        };
        const at = (f: number, y: number, a: number): Vec3 => [cx + rx * f * Math.cos(a), y, cz + rz * f * Math.sin(a)];
        const girth = 2 * Math.PI * Math.sqrt((rx * rx + rz * rz) / 2);
        const u0 = (girth * i) / n;
        const u1 = (girth * (i + 1)) / n;
        const c00 = { p: at(f0, y0, a0), nrm: rim(a0), uv: [u0, y0] as [number, number] };
        const c01 = { p: at(f1, y1, a0), nrm: rim(a0), uv: [u0, y1] as [number, number] };
        const c11 = { p: at(f1, y1, a1), nrm: rim(a1), uv: [u1, y1] as [number, number] };
        const c10 = { p: at(f0, y0, a1), nrm: rim(a1), uv: [u1, y0] as [number, number] };
        // an apex (radius 0) makes the quad a triangle
        const corners = f0 < 1e-9 ? [c00, c01, c11] : f1 < 1e-9 ? [c00, c01, c10] : [c00, c01, c11, c10];
        const ids = corners.map((c) => b.vertex(c.p, c.nrm, c.uv));
        const tris = corners.length === 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]];
        for (const [p, q, r] of tris as [number, number, number][]) {
          const pa = corners[p]!.p;
          const pb = corners[q]!.p;
          const pc = corners[r]!.p;
          const u: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
          const w: Vec3 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
          const g: Vec3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
          const sum = [0, 1, 2].map((m) => corners[p]!.nrm[m]! + corners[q]!.nrm[m]! + corners[r]!.nrm[m]!);
          const outward = g[0] * sum[0]! + g[1] * sum[1]! + g[2] * sum[2]! > 0;
          if (outward) b.triangle(ids[p]!, ids[q]!, ids[r]!, material, OWNER);
          else b.triangle(ids[p]!, ids[r]!, ids[q]!, material, OWNER);
        }
      }
    }
  }

  /**
   * An upright elliptic tube (an open bowl without a floor): outer radii `rx, rz`, wall thickness `t` (as a share of the
   * smaller radius, so the wall is thicker at the ends of a long oval), from `y0` to `y1`, with a rim on top.
   */
  ring(material: string, cx: number, cz: number, rx: number, rz: number, t: number, y0: number, y1: number, segments = 24): void {
    const inner = Math.max(0.05, 1 - t / Math.min(rx, rz));
    this.lathe(material, cx, cz, rx, rz, [[1, y0], [1, y1], [inner, y1], [inner, y0]], segments);
  }

  /**
   * A horizontal slab `[x0,x1] x [z0,z1]` from `y0` to `y1` with rectangular `holes` (each `[x0, z0, x1, z1]`, inside the
   * slab and not overlapping each other), built as a grid of boxes around the holes.
   */
  slab(material: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, holes: readonly (readonly [number, number, number, number])[] = []): void {
    const xs = [...new Set([x0, x1, ...holes.flatMap((h) => [h[0], h[2]])])].sort((a, b) => a - b);
    const zs = [...new Set([z0, z1, ...holes.flatMap((h) => [h[1], h[3]])])].sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i++) {
      for (let k = 0; k + 1 < zs.length; k++) {
        const cx = (xs[i]! + xs[i + 1]!) / 2;
        const cz = (zs[k]! + zs[k + 1]!) / 2;
        if (holes.some((h) => cx > h[0] && cx < h[2] && cz > h[1] && cz < h[3])) continue;
        this.box(material, xs[i]!, y0, zs[k]!, xs[i + 1]!, y1, zs[k + 1]!);
      }
    }
  }

  /**
   * A thin round tube from `a` to `b` (radius `r`, `sides` around, no end caps; the ends are hidden in a canopy or a ball).
   * For arms and rods that are not axis aligned. Smooth normals around.
   */
  tube(material: string, a: Vec3, b: Vec3, r: number, sides = 6): void {
    const dir: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (len < 1e-9 || r < 1e-9) return;
    const t: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
    // any unit vector not parallel to the axis seeds the frame
    const seed: Vec3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const cross = (u: Vec3, v: Vec3): Vec3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const e1 = cross(t, seed);
    const l1 = Math.hypot(e1[0], e1[1], e1[2]);
    const u1: Vec3 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
    const u2 = cross(t, u1);
    for (let i = 0; i < sides; i++) {
      const ang = (k: number) => (2 * Math.PI * k) / sides;
      const nrm = (k: number): Vec3 => [Math.cos(ang(k)) * u1[0] + Math.sin(ang(k)) * u2[0], Math.cos(ang(k)) * u1[1] + Math.sin(ang(k)) * u2[1], Math.cos(ang(k)) * u1[2] + Math.sin(ang(k)) * u2[2]];
      const at = (p: Vec3, n: Vec3): Vec3 => [p[0] + n[0] * r, p[1] + n[1] * r, p[2] + n[2] * r];
      const n0 = nrm(i);
      const n1 = nrm(i + 1);
      const u0 = (2 * Math.PI * r * i) / sides;
      const uu = (2 * Math.PI * r * (i + 1)) / sides;
      const v0 = this.b.vertex(at(a, n0), n0, [u0, 0]);
      const v1 = this.b.vertex(at(b, n0), n0, [u0, len]);
      const v2 = this.b.vertex(at(b, n1), n1, [uu, len]);
      const v3 = this.b.vertex(at(a, n1), n1, [uu, 0]);
      // (v0, v1, v2) has the normal len * r * t x (n1 - n0), which points inward for a right-handed turn about t
      const g = cross(t, [n1[0] - n0[0], n1[1] - n0[1], n1[2] - n0[2]]);
      const outward = g[0] * (n0[0] + n1[0]) + g[1] * (n0[1] + n1[1]) + g[2] * (n0[2] + n1[2]) > 0;
      if (outward) {
        this.b.triangle(v0, v1, v2, material, OWNER);
        this.b.triangle(v0, v2, v3, material, OWNER);
      } else {
        this.b.triangle(v0, v2, v1, material, OWNER);
        this.b.triangle(v0, v3, v2, material, OWNER);
      }
    }
  }

  build(): MeshData {
    return this.b.build();
  }
}

// ---------------------------------------------------------------------------------------------
// Parameter schema helpers (every field is described: the descriptions reach the LLM)
// ---------------------------------------------------------------------------------------------

export const metres = (description: string, def: number, min: number, max: number) =>
  z.number().min(min).max(max).default(def).describe(`${description} In metres, ${min}-${max}. Defaults to ${def}.`);

export const count = (description: string, def: number, min: number, max: number) =>
  z.number().int().min(min).max(max).default(def).describe(`${description} Whole number, ${min}-${max}. Defaults to ${def}.`);

export const FINISHES = ['white', 'wood', 'dark', 'oak', 'white-matte', 'anthracite', 'walnut', 'concrete', 'light-oak'] as const;
export type Finish = (typeof FINISHES)[number];
export const finish = (def: Finish = 'white') =>
  z
    .enum(FINISHES)
    .default(def)
    .describe(
      `Panel finish: "white" (satin lacquer), "white-matte", "wood" (warm oak veneer), "oak" (natural oak veneer), "walnut", "dark" (gloss anthracite lacquer), "anthracite" (matt anthracite paint), "concrete" (dark grey concrete effect; its handles are black bars) or "light-oak" (light oak effect). Defaults to "${def}".`,
    );

const FINISH_MATERIAL: Readonly<Record<Finish, string>> = {
  white: ITEM_MATERIALS.white,
  'white-matte': ITEM_MATERIALS.whiteMatte,
  wood: ITEM_MATERIALS.wood,
  oak: ITEM_MATERIALS.oak,
  walnut: ITEM_MATERIALS.walnut,
  dark: ITEM_MATERIALS.dark,
  anthracite: ITEM_MATERIALS.anthracite,
  concrete: ITEM_MATERIALS.concreteDark,
  'light-oak': ITEM_MATERIALS.oakLight,
};

export function finishMaterial(f: Finish): string {
  return FINISH_MATERIAL[f];
}

/** The standard anchors of a footprint box: back/front centre at mid height and the top centre. */
export function boxAnchors(w: number, d: number, h: number): GeneratorAnchor[] {
  return [
    { name: 'back-centre', position: [0, h / 2, -d / 2] },
    { name: 'front-centre', position: [0, h / 2, d / 2] },
    { name: 'top', position: [0, h, 0] },
    { name: 'left-centre', position: [-w / 2, h / 2, 0] },
    { name: 'right-centre', position: [w / 2, h / 2, 0] },
  ];
}

// ---------------------------------------------------------------------------------------------
// Fronts (doors and drawers) shared by the cabinet generators
// ---------------------------------------------------------------------------------------------

export interface FrontsSpec {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** z of the outer face of the front panels; handles protrude `HANDLE` beyond it. */
  zFace: number;
  doors: number;
  drawers: number;
  frontMaterial: string;
  /** Share of the height given to the drawers when both are present. */
  drawerShare?: number;
}

/** Gap between neighbouring fronts. */
const GAP = 0.003;
/** Handle material for a front: dark concrete-effect fronts carry black bars, everything else brushed steel. */
const handleFor = (front: string): string => (front === ITEM_MATERIALS.concreteDark ? ITEM_MATERIALS.dark : ITEM_MATERIALS.metal);
/** Depth of the dark reveal behind the fronts: it shows in the gaps as a shadow line. */
const REVEAL = 0.003;

/** Door columns side by side (handle on the inner edge of each pair) and drawers stacked above them. */
export function addFronts(kit: Kit, s: FrontsSpec): void {
  const H = s.y1 - s.y0;
  const W = s.x1 - s.x0;
  if (H <= 0.02 || W <= 0.02) return;
  const both = s.doors > 0 && s.drawers > 0;
  const drawerH = s.drawers > 0 ? (both ? H * (s.drawerShare ?? 0.3) : H) : 0;
  const doorTop = s.y1 - drawerH;
  const zBack = s.zFace - FRONT;
  // The fronts are 3 mm thinner than FRONT and the dark reveal fills the rest: the gaps between them read as shadow lines.
  const zDoor = zBack + REVEAL;
  kit.box(ITEM_MATERIALS.dark, s.x0 + 0.002, s.y0 + 0.002, zBack, s.x1 - 0.002, s.y1 - 0.002, zDoor, 0);

  if (s.drawers > 0) {
    const each = drawerH / s.drawers;
    for (let i = 0; i < s.drawers; i++) {
      const yb = doorTop + i * each;
      kit.box(s.frontMaterial, s.x0 + GAP / 2, yb + GAP / 2, zDoor, s.x1 - GAP / 2, yb + each - GAP / 2, s.zFace);
      const hw = Math.min(0.3, W * 0.5);
      kit.handle(handleFor(s.frontMaterial), (s.x0 + s.x1) / 2, yb + each / 2, hw, false, s.zFace);
    }
  }
  if (s.doors > 0) {
    const each = W / s.doors;
    const dh = doorTop - s.y0;
    for (let i = 0; i < s.doors; i++) {
      const xa = s.x0 + i * each;
      kit.box(s.frontMaterial, xa + GAP / 2, s.y0 + GAP / 2, zDoor, xa + each - GAP / 2, doorTop - GAP / 2, s.zFace);
      // Handles meet in pairs: even doors on their right edge, odd doors on their left edge.
      const hx = s.doors === 1 || i % 2 === 0 ? xa + each - 0.04 : xa + 0.04;
      const hh = Math.min(0.3, dh * 0.4);
      kit.handle(handleFor(s.frontMaterial), hx, s.y0 + dh / 2, hh, true, s.zFace);
    }
  }
}

/** An optional named colour of the descriptor-driven finishes (CG4). Absent: the generator keeps its built-in material. */
export const colourParam = (what: string) =>
  z
    .enum(COLOUR_NAMES)
    .optional()
    .describe(`Colour of ${what}: ${COLOUR_NAMES.join(', ')}. Omitted: the standard finish.`);
