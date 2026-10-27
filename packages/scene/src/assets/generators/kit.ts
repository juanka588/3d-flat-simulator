import { z } from 'zod';
import { MeshBuilder } from '../../geometry/builder';
import type { Vec3 } from '../../geometry/builder';
import type { MeshData } from '../../geometry/types';
import { ITEM_MATERIALS } from '../item-materials';
import type { GeneratorAnchor } from '../catalog';

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

export class Kit {
  private readonly b = new MeshBuilder();

  /** Adds an axis-aligned box `[x0,y0,z0]-[x1,y1,z1]` in `material`; degenerate boxes are skipped. */
  box(material: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    if (x1 - x0 < 1e-9 || y1 - y0 < 1e-9 || z1 - z0 < 1e-9) return;
    const b = this.b;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const faces: { n: Vec3; c: [Vec3, Vec3, Vec3, Vec3]; uv: [[number, number], [number, number], [number, number], [number, number]] }[] = [
      { n: [0, 0, 1], c: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], uv: [[0, 0], [dx, 0], [dx, dy], [0, dy]] },
      { n: [0, 0, -1], c: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], uv: [[0, 0], [dx, 0], [dx, dy], [0, dy]] },
      { n: [1, 0, 0], c: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], uv: [[0, 0], [dz, 0], [dz, dy], [0, dy]] },
      { n: [-1, 0, 0], c: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], uv: [[0, 0], [dz, 0], [dz, dy], [0, dy]] },
      { n: [0, 1, 0], c: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], uv: [[0, 0], [dx, 0], [dx, dz], [0, dz]] },
      { n: [0, -1, 0], c: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], uv: [[0, 0], [dx, 0], [dx, dz], [0, dz]] },
    ];
    for (const f of faces) b.quad(f.c, f.n, f.uv, material, OWNER);
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
      const u0 = i / n;
      const u1 = (i + 1) / n;
      const v0 = b.vertex(at(p, y0), normal(p), [u0, 0]);
      const v1 = b.vertex(at(p, y1), normal(p), [u0, y1 - y0]);
      const v2 = b.vertex(at(q, y1), normal(q), [u1, y1 - y0]);
      const v3 = b.vertex(at(q, y0), normal(q), [u1, 0]);
      b.triangle(v0, v1, v2, material, OWNER);
      b.triangle(v0, v2, v3, material, OWNER);
      const top: Vec3 = [0, 1, 0];
      const c0 = b.vertex([cx, y1, cz], top, [0.5, 0.5]);
      const t1 = b.vertex(at(q, y1), top, [0.5 + 0.5 * q.c, 0.5 + 0.5 * q.s]);
      const t0 = b.vertex(at(p, y1), top, [0.5 + 0.5 * p.c, 0.5 + 0.5 * p.s]);
      b.triangle(c0, t1, t0, material, OWNER);
    }
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

export const FINISHES = ['white', 'wood', 'dark'] as const;
export const finish = (def: (typeof FINISHES)[number] = 'white') =>
  z.enum(FINISHES).default(def).describe(`Panel finish: "white" (painted), "wood" (oak) or "dark" (anthracite). Defaults to "${def}".`);

export function finishMaterial(f: (typeof FINISHES)[number]): string {
  return f === 'wood' ? ITEM_MATERIALS.wood : f === 'dark' ? ITEM_MATERIALS.dark : ITEM_MATERIALS.white;
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

const GAP = 0.003;

/** Door columns side by side (handle on the inner edge of each pair) and drawers stacked above them. */
export function addFronts(kit: Kit, s: FrontsSpec): void {
  const H = s.y1 - s.y0;
  const W = s.x1 - s.x0;
  if (H <= 0.02 || W <= 0.02) return;
  const both = s.doors > 0 && s.drawers > 0;
  const drawerH = s.drawers > 0 ? (both ? H * (s.drawerShare ?? 0.3) : H) : 0;
  const doorTop = s.y1 - drawerH;
  const zBack = s.zFace - FRONT;

  if (s.drawers > 0) {
    const each = drawerH / s.drawers;
    for (let i = 0; i < s.drawers; i++) {
      const yb = doorTop + i * each;
      kit.box(s.frontMaterial, s.x0 + GAP / 2, yb + GAP / 2, zBack, s.x1 - GAP / 2, yb + each - GAP / 2, s.zFace);
      const hw = Math.min(0.3, W * 0.5);
      const ym = yb + each / 2;
      kit.box(ITEM_MATERIALS.metal, (s.x0 + s.x1) / 2 - hw / 2, ym - 0.006, s.zFace, (s.x0 + s.x1) / 2 + hw / 2, ym + 0.006, s.zFace + HANDLE);
    }
  }
  if (s.doors > 0) {
    const each = W / s.doors;
    const dh = doorTop - s.y0;
    for (let i = 0; i < s.doors; i++) {
      const xa = s.x0 + i * each;
      kit.box(s.frontMaterial, xa + GAP / 2, s.y0 + GAP / 2, zBack, xa + each - GAP / 2, doorTop - GAP / 2, s.zFace);
      // Handles meet in pairs: even doors on their right edge, odd doors on their left edge.
      const hx = s.doors === 1 || i % 2 === 0 ? xa + each - 0.04 : xa + 0.04;
      const hh = Math.min(0.3, dh * 0.4);
      const ym = s.y0 + dh / 2;
      kit.box(ITEM_MATERIALS.metal, hx - 0.006, ym - hh / 2, s.zFace, hx + 0.006, ym + hh / 2, s.zFace + HANDLE);
    }
  }
}
