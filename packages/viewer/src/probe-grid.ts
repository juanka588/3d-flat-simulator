import { DEFAULT_CEILING_HEIGHT, pointInPolygon, roomCeilingHeight, wallLength } from '@flat/scene';
import type { Scene, Vec2 } from '@flat/scene';

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
/** Walls this close (metres) to a probe cell are tested against its visibility: a subcell centre moved out of a wall may leave the cell by this much. */
const NEAR_PAD_M = 0.12;

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
 * The walls as solid rectangles in the plan. Doors and passages are cut out (light and the probes' reach go through them), except
 * in the `closed` walls (the party walls, see `wallExposure`); windows stay solid: glass passes the sky to the probes that look at it, but the probes outside are not the probes of the room.
 * Wall ends not at a cut are extended by half the thickness so two walls meeting at a corner leave no gap.
 */
export function wallSolids(scene: Pick<Scene, 'walls' | 'openings'>, closed: ReadonlySet<string> = new Set()): Solid[] {
  const out: Solid[] = [];
  for (const wall of scene.walls) {
    const len = wallLength(wall);
    if (len < 1e-6) continue;
    const ux = (wall.end[0] - wall.start[0]) / len;
    const uz = (wall.end[1] - wall.start[1]) / len;
    const ht = wall.thickness / 2;
    const cuts: [number, number][] = [];
    for (const o of scene.openings) {
      // A door in a party wall (the flat's front door) leads to the landing, not to open air: nothing passes through it for the probes.
      if (o.wallId !== wall.id || o.type === 'window' || closed.has(wall.id)) continue;
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

/** How far (metres) beyond a wall face a test point that stood inside the wall is put. */
const PUSH_OUT_M = 0.002;

/**
 * `(x, z)` moved out of the walls it stands in, by the shortest way out of all of them (through a face of one wall into the next
 * wall, and on out of that one, when that is the shortest: the corner where two walls meet leaves along the room side, not through
 * the walls to the other side). A visibility subcell whose centre lies inside a wall belongs, as far as any surface that reads it
 * goes, to the room at the face the subcell straddles: its centre must be tested from there, not from inside the wall, or the wall
 * does not hide the probes on its far side from the 3 cm band of surface beside it. A point that no way leads out of stays where it is.
 */
export function outOfWalls(solids: readonly Solid[], x: number, z: number): [number, number] {
  const inside = (px: number, pz: number) => solids.filter((s) => insideSolid(s, px, pz));
  let best: [number, number] | null = null;
  let bestD = Infinity;
  let frontier: [number, number, number][] = [[x, z, 0]];
  for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
    const next: [number, number, number][] = [];
    for (const [px, pz, d] of frontier) {
      if (d >= bestD) continue;
      const containing = inside(px, pz);
      if (containing.length === 0) {
        best = [px, pz];
        bestD = d;
        continue;
      }
      for (const s of containing) {
        const dx = px - s.cx;
        const dz = pz - s.cz;
        const p = dx * s.ux + dz * s.uz;
        const q = -dx * s.uz + dz * s.ux;
        for (const [axis, sign] of [['q', 1], ['q', -1], ['p', 1], ['p', -1]] as const) {
          const t = sign * ((axis === 'q' ? s.ht : s.hl) + PUSH_OUT_M) - (axis === 'q' ? q : p);
          next.push(axis === 'q' ? [px - s.uz * t, pz + s.ux * t, d + Math.abs(t)] : [px + s.ux * t, pz + s.uz * t, d + Math.abs(t)]);
        }
      }
    }
    frontier = next.filter((c) => c[2] < bestD).sort((a, b) => a[2] - b[2]).slice(0, 32);
  }
  return best ?? [x, z];
}

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
export function buildVisibility(l: ProbeLayout, solids: readonly Solid[], boxes: readonly PlanBox[], maxDepth = Infinity, rooms: readonly (readonly Vec2[])[] = []): Visibility {
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
  // Habitable rooms: a point in one is only ever lit by probes of the flat's own rooms (never by those outdoors), see "last resort" below.
  const indoorAt = (x: number, z: number): boolean => rooms.some((r) => pointInPolygon([x, z], r));
  const cornerIndoor = new Uint8Array(nx * nz);
  if (rooms.length > 0) {
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) cornerIndoor[ix + iz * nx] = indoorAt(l.min[0] + ix * l.spacing[0], l.min[2] + iz * l.spacing[2]) ? 1 : 0;
  }
  interface Sub {
    px: number;
    pz: number;
    /** Open corners (1/0) by the free-first, furniture-second rule; `any` when at least one is. */
    res: [number, number, number, number];
    any: boolean;
  }
  const near: Solid[] = [];
  const subs: Sub[] = [];
  const blockedBetween = (ax: number, az: number, bx: number, bz: number): boolean => {
    for (const s of near) {
      // Only a point that could not be moved out of the wall it stands in (a corner of overlapping walls) is not held back by it.
      if (insideSolid(s, ax, az)) continue;
      if (segmentHitsSolid(s, ax, az, bx, bz)) return true;
    }
    return false;
  };
  for (let cz = 0; cz < cellsZ; cz++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const x0 = l.min[0] + cx * l.spacing[0];
      const z0 = l.min[2] + cz * l.spacing[2];
      const x1 = x0 + l.spacing[0];
      const z1 = z0 + l.spacing[2];
      // Every segment from a point of the cell to its corners stays inside the cell (plus the few cm a point is moved out of a wall): only the walls touching it matter.
      near.length = 0;
      for (const s of solids) {
        const ex = Math.abs(s.ux) * s.hl + Math.abs(s.uz) * s.ht;
        const ez = Math.abs(s.uz) * s.hl + Math.abs(s.ux) * s.ht;
        if (s.cx + ex > x0 - NEAR_PAD_M && s.cx - ex < x1 + NEAR_PAD_M && s.cz + ez > z0 - NEAR_PAD_M && s.cz - ez < z1 + NEAR_PAD_M) near.push(s);
      }
      const corners = [
        [x0, z0, cornerValid[cx + cz * nx]!, cornerIndoor[cx + cz * nx]!],
        [x1, z0, cornerValid[cx + 1 + cz * nx]!, cornerIndoor[cx + 1 + cz * nx]!],
        [x0, z1, cornerValid[cx + (cz + 1) * nx]!, cornerIndoor[cx + (cz + 1) * nx]!],
        [x1, z1, cornerValid[cx + 1 + (cz + 1) * nx]!, cornerIndoor[cx + 1 + (cz + 1) * nx]!],
      ] as const;
      subs.length = 0;
      for (let sz = 0; sz < subdiv; sz++) {
        for (let sx = 0; sx < subdiv; sx++) {
          // A centre inside a wall is tested from the face it is nearest to (see `outOfWalls`).
          const [px, pz] = outOfWalls(near, x0 + ((sx + 0.5) / subdiv) * l.spacing[0], z0 + ((sz + 0.5) / subdiv) * l.spacing[2]);
          const open = [false, false, false, false];
          for (let c = 0; c < 4; c++) {
            const [qx, qz, ok] = corners[c]!;
            if (ok !== 0) open[c] = !blockedBetween(px, pz, qx, qz);
          }
          // Free corners first; furniture corners only when no free one is in view.
          const res: Sub['res'] = [0, 0, 0, 0];
          let any = false;
          for (const wanted of [2, 1]) {
            for (let c = 0; c < 4; c++) {
              if (open[c] && corners[c]![2] === wanted) {
                res[c] = 1;
                any = true;
              }
            }
            if (any) break;
          }
          subs.push({ px, pz, res, any });
        }
      }
      for (const sub of subs) {
        if (!sub.any) {
          // No corner in view: take what the nearest point of this cell that can be reached without crossing a wall sees (a 3 cm
          // band beside a wall corner must not read a probe the wall hides), else the nearest probe at all, but a point in a room
          // only from probes in rooms: the sky-lit probes outdoors (the landing, the neighbours) never light a room through its wall.
          let donor: Sub | null = null;
          let donorD = Infinity;
          for (const other of subs) {
            if (!other.any) continue;
            const d = (other.px - sub.px) ** 2 + (other.pz - sub.pz) ** 2;
            if (d < donorD && !blockedBetween(sub.px, sub.pz, other.px, other.pz)) {
              donor = other;
              donorD = d;
            }
          }
          if (donor) {
            sub.res = donor.res;
          } else {
            const insideRoom = rooms.length > 0 && indoorAt(sub.px, sub.pz);
            let nearest = -1;
            let nearestD = Infinity;
            for (let c = 0; c < 4; c++) {
              const [qx, qz, ok, indoor] = corners[c]!;
              if (ok === 0 || (insideRoom && indoor === 0)) continue;
              const d = (qx - sub.px) ** 2 + (qz - sub.pz) ** 2;
              if (d < nearestD) {
                nearestD = d;
                nearest = c;
              }
            }
            if (nearest >= 0) sub.res[nearest] = 1;
          }
        }
      }
      for (let k = 0; k < subs.length; k++) {
        const index = 1 + ((cz * cellsX + cx) * subdiv + Math.floor(k / subdiv)) * subdiv + (k % subdiv);
        data.set(subs[k]!.res, index * 4);
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
