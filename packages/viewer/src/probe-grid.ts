import { DEFAULT_CEILING_HEIGHT, pointInPolygon, roomCeilingHeight, wallLength } from '@flat/scene';
import type { Scene } from '@flat/scene';

/**
 * Pure maths of the baked light-probe grid (the indirect-light default, see docs/photometry.md "Indirect light"):
 * where the probes are, which of them are unusable, the plan visibility that keeps a lit room from glowing through a
 * thin partition into the dark room next to it, and the keys that decide when a bake is stale. No GL in here.
 */

export interface ProbeSettings {
  /** Probe spacing in the plan, metres. */
  spacing: number;
  /** Face size of the cube map each probe renders (8 is plenty for L2 spherical harmonics, 16 is smoother). */
  cube: number;
  /** Extra light bounces after the direct pass (0 = the lamps/sun light surfaces once, 1 = those surfaces light each other). */
  bounces: number;
}

/** Probes this far outside the walls give the facade, balcony and ground something to sample. */
export const PROBE_MARGIN_M = 0.5;
/** Height of the lowest probe level above the floor, and how far the top level sits below the ceiling. */
export const LEVEL_LOW_M = 0.3;
export const LEVEL_TOP_INSET_M = 0.3;
/** Probe levels: near the floor, around eye height, near the ceiling. */
export const LEVELS = 3;
/** Edge (metres) of a visibility subcell the plan is cut into; the grid picks the whole number of subcells per cell nearest to it. */
export const VISIBILITY_CELL_M = 0.0625;
/** Fewest and most visibility subcells per probe cell edge. */
export const MIN_SUBDIV = 6;
export const MAX_SUBDIV = 16;
/** A probe this close (metres) to a furniture box or inside a wall is not used. */
const SOLID_EPS = 1e-4;

export interface ProbeLayout {
  /** World position of probe (0, 0, 0). */
  min: [number, number, number];
  /** Extent of the grid (the distance between the first and last probe on each axis). */
  size: [number, number, number];
  /** Probes per axis. */
  res: [number, number, number];
  /** Distance between neighbouring probes on each axis. */
  spacing: [number, number, number];
}

export const probeCount = (l: ProbeLayout): number => l.res[0] * l.res[1] * l.res[2];

/** Index of probe (ix, iy, iz) in the order the bake walks them: X fastest, then Z, then Y (horizontal layers, bottom to top). */
export const probeIndex = (l: ProbeLayout, ix: number, iy: number, iz: number): number => ix + iz * l.res[0] + iy * l.res[0] * l.res[2];

export function probePosition(l: ProbeLayout, ix: number, iy: number, iz: number): [number, number, number] {
  return [l.min[0] + ix * l.spacing[0], l.min[1] + iy * l.spacing[1], l.min[2] + iz * l.spacing[2]];
}

/** The grid over a flat: plan bounds of the walls and rooms plus a margin, three levels from floor to ceiling. Null for an empty scene. */
export function probeLayout(scene: Pick<Scene, 'walls' | 'rooms'>, settings: Pick<ProbeSettings, 'spacing'>): ProbeLayout | null {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  const take = (x: number, z: number) => {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  };
  for (const w of scene.walls) {
    take(w.start[0], w.start[1]);
    take(w.end[0], w.end[1]);
  }
  for (const r of scene.rooms) for (const p of r.polygon) take(p[0], p[1]);
  if (!(x1 > x0) || !(z1 > z0)) return null;
  x0 -= PROBE_MARGIN_M;
  z0 -= PROBE_MARGIN_M;
  x1 += PROBE_MARGIN_M;
  z1 += PROBE_MARGIN_M;
  let ceiling = 0;
  for (const r of scene.rooms) if (r.type !== 'balcony') ceiling = Math.max(ceiling, roomCeilingHeight(scene as Scene, r));
  if (!(ceiling > 0)) ceiling = DEFAULT_CEILING_HEIGHT;
  const y0 = Math.min(LEVEL_LOW_M, ceiling / 4);
  const y1 = Math.max(y0 + 0.5, ceiling - LEVEL_TOP_INSET_M);
  const spacing = Math.max(0.1, settings.spacing);
  const nx = Math.max(2, Math.ceil((x1 - x0) / spacing - 1e-9) + 1);
  const nz = Math.max(2, Math.ceil((z1 - z0) / spacing - 1e-9) + 1);
  const size: [number, number, number] = [x1 - x0, y1 - y0, z1 - z0];
  const res: [number, number, number] = [nx, LEVELS, nz];
  return { min: [x0, y0, z0], size, res, spacing: [size[0] / (nx - 1), size[1] / (LEVELS - 1), size[2] / (nz - 1)] };
}

/** An oriented rectangle on the plan: a stretch of wall (without the openings cut out of it). */
export interface Solid {
  cx: number;
  cz: number;
  /** Unit vector along the stretch. */
  ux: number;
  uz: number;
  hl: number;
  ht: number;
}

/** An axis-aligned box on the plan that a probe cannot sit in (furniture). */
export interface PlanBox {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/**
 * The walls as solid rectangles in the plan. Doors and passages are cut out (light and the probes' reach go through them);
 * windows stay solid: glass passes the sky to the probes that look at it, but the probes outside are not the probes of the room.
 * Wall ends not at a cut are extended by half the thickness so two walls meeting at a corner leave no gap.
 */
export function wallSolids(scene: Pick<Scene, 'walls' | 'openings'>): Solid[] {
  const out: Solid[] = [];
  for (const wall of scene.walls) {
    const len = wallLength(wall);
    if (len < 1e-6) continue;
    const ux = (wall.end[0] - wall.start[0]) / len;
    const uz = (wall.end[1] - wall.start[1]) / len;
    const ht = wall.thickness / 2;
    const cuts: [number, number][] = [];
    for (const o of scene.openings) {
      if (o.wallId !== wall.id || o.type === 'window') continue;
      cuts.push([Math.max(0, o.offset - o.width / 2), Math.min(len, o.offset + o.width / 2)]);
    }
    cuts.sort((a, b) => a[0] - b[0]);
    // Stretches [from, to] of solid wall between the cuts; `capFrom` / `capTo` tell whether the end is a real wall end.
    const stretches: { from: number; to: number; capFrom: boolean; capTo: boolean }[] = [];
    let at = 0;
    let capFrom = true;
    for (const [a, b] of cuts) {
      if (a > at + 1e-6) stretches.push({ from: at, to: a, capFrom, capTo: false });
      at = Math.max(at, b);
      capFrom = false;
    }
    if (len > at + 1e-6) stretches.push({ from: at, to: len, capFrom, capTo: true });
    for (const s of stretches) {
      const from = s.from - (s.capFrom ? ht : 0);
      const to = s.to + (s.capTo ? ht : 0);
      const mid = (from + to) / 2;
      out.push({ cx: wall.start[0] + ux * mid, cz: wall.start[1] + uz * mid, ux, uz, hl: (to - from) / 2, ht });
    }
  }
  return out;
}

const insideSolid = (s: Solid, x: number, z: number, grow = 0): boolean => {
  const dx = x - s.cx;
  const dz = z - s.cz;
  return Math.abs(dx * s.ux + dz * s.uz) < s.hl + grow - SOLID_EPS && Math.abs(-dx * s.uz + dz * s.ux) < s.ht + grow - SOLID_EPS;
};

/** True when the segment (ax, az)-(bx, bz) passes through the solid (slab test in the solid's own frame). */
export function segmentHitsSolid(s: Solid, ax: number, az: number, bx: number, bz: number): boolean {
  const pa = (ax - s.cx) * s.ux + (az - s.cz) * s.uz;
  const qa = -(ax - s.cx) * s.uz + (az - s.cz) * s.ux;
  const pb = (bx - s.cx) * s.ux + (bz - s.cz) * s.uz;
  const qb = -(bx - s.cx) * s.uz + (bz - s.cz) * s.ux;
  let t0 = 0;
  let t1 = 1;
  for (const [a, b, h] of [[pa, pb, s.hl], [qa, qb, s.ht]] as const) {
    const d = b - a;
    if (Math.abs(d) < 1e-12) {
      if (Math.abs(a) >= h - SOLID_EPS) return false;
    } else {
      let ta = (-h - a) / d;
      let tb = (h - a) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** Plan boxes of the furniture drawn from the generated shell (axis-aligned bounds of each item's triangles; a rotated item gets a looser box). */
export function itemBoxes(mesh: { positions: Float32Array; indices: Uint32Array | number[]; owners: readonly { kind: string; entityId: string; start: number; count: number }[] }): PlanBox[] {
  const out: PlanBox[] = [];
  for (const owner of mesh.owners) {
    if (owner.kind !== 'item') continue;
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    let top = -Infinity;
    for (let t = owner.start; t < owner.start + owner.count; t++) {
      for (let k = 0; k < 3; k++) {
        const v = mesh.indices[t * 3 + k]! * 3;
        x0 = Math.min(x0, mesh.positions[v]!);
        x1 = Math.max(x1, mesh.positions[v]!);
        z0 = Math.min(z0, mesh.positions[v + 2]!);
        z1 = Math.max(z1, mesh.positions[v + 2]!);
        top = Math.max(top, mesh.positions[v + 1]!);
      }
    }
    // Only furniture that fills the probe levels (above knee height); a rug or a low stool does not block a probe.
    if (x1 > x0 && z1 > z0 && top > LEVEL_LOW_M + 0.1) out.push({ x0, z0, x1, z1 });
  }
  return out;
}

/** True when a plan point is inside a wall: a probe there is skipped by the bake and never read. */
export function planPointInWall(x: number, z: number, solids: readonly Solid[]): boolean {
  for (const s of solids) if (insideSolid(s, x, z)) return true;
  return false;
}

/** True when a plan point is inside a furniture box: the probe is still baked (it sees the room through the box's back faces) but is read only when no free probe can serve a point. */
export function planPointInFurniture(x: number, z: number, boxes: readonly PlanBox[]): boolean {
  for (const b of boxes) if (x > b.x0 + 0.02 && x < b.x1 - 0.02 && z > b.z0 + 0.02 && z < b.z1 - 0.02) return true;
  return false;
}

/** 1 for probes in a habitable room (not the balcony, not outdoors): they see the sky only through windows. */
export function probeIndoor(l: ProbeLayout, scene: Pick<Scene, 'rooms'>): Uint8Array {
  const [nx, ny, nz] = l.res;
  const out = new Uint8Array(probeCount(l));
  const rooms = scene.rooms.filter((r) => r.type !== 'balcony');
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const p: [number, number] = [l.min[0] + ix * l.spacing[0], l.min[2] + iz * l.spacing[2]];
      const inside = rooms.some((r) => pointInPolygon(p, r.polygon)) ? 1 : 0;
      for (let iy = 0; iy < ny; iy++) out[probeIndex(l, ix, iy, iz)] = inside;
    }
  }
  return out;
}

/** 1 for every probe the bake renders, 0 for those inside a wall. */
export function probeValidity(l: ProbeLayout, solids: readonly Solid[]): Uint8Array {
  const [nx, ny, nz] = l.res;
  const out = new Uint8Array(probeCount(l));
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const ok = planPointInWall(l.min[0] + ix * l.spacing[0], l.min[2] + iz * l.spacing[2], solids) ? 0 : 1;
      for (let iy = 0; iy < ny; iy++) out[probeIndex(l, ix, iy, iz)] = ok;
    }
  }
  return out;
}

/** Runs `[start, count]` of consecutive valid probes of one group, each at most `maxRun` long. Probe 0 is always in the first run (the bounce pass needs it). */
export function bakeRuns(valid: Uint8Array, maxRun = Infinity, group?: Uint8Array): [number, number][] {
  const runs: [number, number][] = [];
  let i = 0;
  while (i < valid.length) {
    if (valid[i] === 0 && i !== 0) {
      i++;
      continue;
    }
    const start = i;
    // A run ends at an invalid probe, at `maxRun`, and where `group` (e.g. indoor / outdoor) changes.
    while (i < valid.length && (valid[i] === 1 || i === start) && i - start < maxRun && (!group || group[i] === group[start])) i++;
    runs.push([start, i - start]);
  }
  return runs;
}

/** The per-subcell visibility of the four plan corners of every probe cell, laid out for the shader (see probe-shader.ts). */
export interface Visibility {
  /** Subcells per cell edge. */
  subdiv: number;
  /** Texel size of the block in the atlas: width x height per slice (the probe grid's X and Y counts), `slices` slices. */
  width: number;
  height: number;
  slices: number;
  /** RGBA float texels; texel 0 is the header `(subdiv, 0, 0, 0)`, then one texel per subcell: `(v00, v10, v01, v11)` for the corners (x, z), (x+1, z), (x, z+1), (x+1, z+1). */
  data: Float32Array;
}

/** Whole number of visibility subcells per probe cell edge for a grid, and the atlas slices it needs. */
export function visibilitySize(l: ProbeLayout, maxDepth = Infinity): { subdiv: number; slices: number } {
  let subdiv = Math.min(MAX_SUBDIV, Math.max(MIN_SUBDIV, Math.round(Math.min(l.spacing[0], l.spacing[2]) / VISIBILITY_CELL_M)));
  const per = l.res[0] * l.res[1];
  const slicesFor = (s: number) => Math.ceil((1 + (l.res[0] - 1) * (l.res[2] - 1) * s * s) / per);
  while (subdiv > MIN_SUBDIV && slicesFor(subdiv) > maxDepth) subdiv--;
  return { subdiv, slices: slicesFor(subdiv) };
}

/**
 * Plan visibility inside every cell of the probe grid. For each subcell (a point of the plan) and each of the four probes
 * at the corners of its cell: 1 when the probe may light that point (the probe is valid and no wall stands between them),
 * else 0. The shader weights the four corner probes by `bilinear weight x visibility`, so a point beside a thin partition
 * never reads a probe on the far side of it. Where no corner qualifies, the nearest valid corner is used regardless of walls
 * (a closet is lit by something rather than black); where none is valid at all it stays 0.
 */
export function buildVisibility(l: ProbeLayout, solids: readonly Solid[], boxes: readonly PlanBox[], maxDepth = Infinity): Visibility {
  const [nx, ny, nz] = l.res;
  const { subdiv, slices } = visibilitySize(l, maxDepth);
  const cellsX = nx - 1;
  const cellsZ = nz - 1;
  const texels = slices * nx * ny;
  const data = new Float32Array(texels * 4);
  data[0] = subdiv;
  // 0: inside a wall, 1: inside furniture (last resort), 2: free.
  const cornerValid = new Uint8Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = l.min[0] + ix * l.spacing[0];
      const z = l.min[2] + iz * l.spacing[2];
      cornerValid[ix + iz * nx] = planPointInWall(x, z, solids) ? 0 : planPointInFurniture(x, z, boxes) ? 1 : 2;
    }
  }
  const near: Solid[] = [];
  for (let cz = 0; cz < cellsZ; cz++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const x0 = l.min[0] + cx * l.spacing[0];
      const z0 = l.min[2] + cz * l.spacing[2];
      const x1 = x0 + l.spacing[0];
      const z1 = z0 + l.spacing[2];
      // Every segment from a point of the cell to its corners stays inside the cell: only the walls touching it matter.
      near.length = 0;
      for (const s of solids) {
        const ex = Math.abs(s.ux) * s.hl + Math.abs(s.uz) * s.ht;
        const ez = Math.abs(s.uz) * s.hl + Math.abs(s.ux) * s.ht;
        if (s.cx + ex > x0 && s.cx - ex < x1 && s.cz + ez > z0 && s.cz - ez < z1) near.push(s);
      }
      const corners = [
        [x0, z0, cornerValid[cx + cz * nx]!],
        [x1, z0, cornerValid[cx + 1 + cz * nx]!],
        [x0, z1, cornerValid[cx + (cz + 1) * nx]!],
        [x1, z1, cornerValid[cx + 1 + (cz + 1) * nx]!],
      ] as const;
      for (let sz = 0; sz < subdiv; sz++) {
        for (let sx = 0; sx < subdiv; sx++) {
          const px = x0 + ((sx + 0.5) / subdiv) * l.spacing[0];
          const pz = z0 + ((sz + 0.5) / subdiv) * l.spacing[2];
          const index = 1 + ((cz * cellsX + cx) * subdiv + sz) * subdiv + sx;
          const at = index * 4;
          let nearest = -1;
          let nearestD = Infinity;
          const open = [false, false, false, false];
          for (let c = 0; c < 4; c++) {
            const [qx, qz, ok] = corners[c]!;
            if (ok === 0) continue;
            const d = (qx - px) ** 2 + (qz - pz) ** 2;
            if (d < nearestD) {
              nearestD = d;
              nearest = c;
            }
            let blocked = false;
            for (const s of near) {
              // A point inside a wall (the 3 cm band of a subcell centre) is not held back by the wall it stands in.
              if (insideSolid(s, px, pz, 0.005)) continue;
              if (segmentHitsSolid(s, px, pz, qx, qz)) {
                blocked = true;
                break;
              }
            }
            open[c] = !blocked;
          }
          // Free corners first; furniture corners only when no free one is in view; else the nearest corner whatever stands between.
          let any = false;
          for (const wanted of [2, 1]) {
            for (let c = 0; c < 4; c++) {
              if (open[c] && corners[c]![2] === wanted) {
                data[at + c] = 1;
                any = true;
              }
            }
            if (any) break;
          }
          if (!any && nearest >= 0) data[at + nearest] = 1;
        }
      }
    }
  }
  return { subdiv, width: nx, height: ny, slices, data };
}

/** FNV-1a (32 bit) of a string, hex: short stable keys. */
export function hashString(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Rounds every number in a JSON-like value to `digits` significant digits, so float noise does not change a key. */
export function stable(value: unknown, digits = 4): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toPrecision(digits)) : null;
  if (Array.isArray(value)) return value.map((v) => stable(v, digits));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stable(v, digits)]));
  return value;
}

export const keyOf = (value: unknown): string => hashString(JSON.stringify(stable(value)));
