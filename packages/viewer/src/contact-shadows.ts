import type { Item, MeshData, Scene } from '@flat/scene';

/**
 * Soft contact shadows: a cheap stand-in for screen-space ambient occlusion. Every furniture item standing on the floor
 * darkens the floor around its footprint (a tight dark line at the foot and a wide faint halo), which is the strongest
 * depth cue after cast shadows: without it objects float. The darkening is one translucent plane over the floors (one draw
 * call, one 2D texture drawn once per scene on the CPU), so it costs nothing per frame and is simply left out on the low
 * profile. It is multiplicative black, so it is exposure- and light-independent.
 */

/** An item's footprint on the floor in the plan: an oriented rectangle. */
export interface ContactRect {
  id: string;
  /** Centre on the plan (x, z). */
  centre: [number, number];
  /** Half extents along the item's own x and z axes. */
  half: [number, number];
  /** Item rotation, degrees (three.js rotation.y convention, as `Item.rotation`). */
  rotation: number;
  /** 1 for a solid block on the floor, less for an item that stands on legs. */
  strength: number;
}

/** Items higher than this above the floor, or thinner than `MIN_HEIGHT`, cast no floor contact shadow. */
export const MAX_ELEVATION = 0.3;
export const MIN_HEIGHT = 0.05;
/** Vertices lower than this above the item's base form the footprint (legs, plinth, body bottom). */
const FOOT_SLICE = 0.12;

/** Plan point of an item-local (x, z), the transform of `buildItems`: x' = x cos + z sin, z' = -x sin + z cos. */
function toPlan(item: Pick<Item, 'position' | 'rotation'>, x: number, z: number): [number, number] {
  const r = (item.rotation * Math.PI) / 180;
  return [item.position[0] + x * Math.cos(r) + z * Math.sin(r), item.position[1] - x * Math.sin(r) + z * Math.cos(r)];
}

/**
 * Footprints of the items drawn from the shell's item mesh (generator output): the bounding rectangle of each item's
 * bottom slice. `strength` is the share of that rectangle covered by downward-facing surface in the slice, so a cabinet
 * on a plinth is ~1 and a table on four legs is weak.
 */
export function meshContactRects(items: readonly Item[], mesh: MeshData): ContactRect[] {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const out: ContactRect[] = [];
  for (const owner of mesh.owners) {
    if (owner.kind !== 'item') continue;
    const item = byId.get(owner.entityId);
    if (!item || item.elevation > MAX_ELEVATION) continue;
    const r = (item.rotation * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    // Item-local coordinates (the inverse of the item rotation), height above the item's base.
    const local = (v: number): [number, number, number] => {
      const wx = mesh.positions[v * 3]! - item.position[0];
      const wz = mesh.positions[v * 3 + 2]! - item.position[1];
      return [wx * cos - wz * sin, mesh.positions[v * 3 + 1]! - item.elevation, wx * sin + wz * cos];
    };
    let top = -Infinity;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    let down = 0;
    for (let t = owner.start; t < owner.start + owner.count; t++) {
      const [a, b, c] = [local(mesh.indices[t * 3]!), local(mesh.indices[t * 3 + 1]!), local(mesh.indices[t * 3 + 2]!)];
      for (const p of [a, b, c]) {
        top = Math.max(top, p[1]);
        if (p[1] < FOOT_SLICE) {
          x0 = Math.min(x0, p[0]);
          x1 = Math.max(x1, p[0]);
          z0 = Math.min(z0, p[2]);
          z1 = Math.max(z1, p[2]);
        }
      }
      // A downward-facing triangle in the slice (the underside of a plinth, a leg's foot) is surface standing on the floor.
      if (a[1] < FOOT_SLICE && b[1] < FOOT_SLICE && c[1] < FOOT_SLICE && mesh.normals[mesh.indices[t * 3]! * 3 + 1]! < -0.5) {
        down += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
      }
    }
    if (top < MIN_HEIGHT || !(x1 > x0) || !(z1 > z0)) continue;
    const area = (x1 - x0) * (z1 - z0);
    out.push({
      id: item.id,
      centre: toPlan(item, (x0 + x1) / 2, (z0 + z1) / 2),
      half: [(x1 - x0) / 2, (z1 - z0) / 2],
      rotation: item.rotation,
      strength: Math.min(1, Math.max(0.35, down / area)),
    });
  }
  return out;
}

/** Footprint of an item drawn from a model, from its box (`dims`) and placement. */
export function boxContactRect(item: Item, dims: { w: number; d: number; h: number }): ContactRect | undefined {
  if (item.elevation > MAX_ELEVATION || dims.h < MIN_HEIGHT) return undefined;
  return { id: item.id, centre: item.position, half: [dims.w / 2, dims.d / 2], rotation: item.rotation, strength: 0.8 };
}

/** The four plan corners of a rect. */
export function rectCorners(rect: ContactRect, grow = 0): [number, number][] {
  const [hx, hz] = [rect.half[0] + grow, rect.half[1] + grow];
  return ([[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]] as const).map(([x, z]) => toPlan({ position: rect.centre, rotation: rect.rotation }, x, z));
}

/** Plan bounds (with a margin) the shadow plane covers: the walls and rooms of the flat. */
export function planBounds(scene: Pick<Scene, 'walls' | 'rooms'>, margin = 0.3): { x0: number; z0: number; x1: number; z1: number } | undefined {
  const xs: number[] = [];
  const zs: number[] = [];
  for (const w of scene.walls) {
    xs.push(w.start[0], w.end[0]);
    zs.push(w.start[1], w.end[1]);
  }
  for (const r of scene.rooms) for (const p of r.polygon) {
    xs.push(p[0]);
    zs.push(p[1]);
  }
  if (xs.length === 0) return undefined;
  return { x0: Math.min(...xs) - margin, z0: Math.min(...zs) - margin, x1: Math.max(...xs) + margin, z1: Math.max(...zs) + margin };
}

// ---------------------------------------------------------------------------------------------
// Rasterising: footprints -> blurred alpha image
// ---------------------------------------------------------------------------------------------

export interface Bounds {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Layers of the shadow: a wide faint halo, and a tight dark line at the foot (sigma in metres, alpha at full strength). */
export const HALO = { sigma: 0.08, alpha: 0.4 };
export const CONTACT = { sigma: 0.014, alpha: 0.35 };
/** Floor-wall creases: a softer, wider darkening along the walls. */
export const CREASE = { sigma: 0.09, alpha: 0.4 };

/** Fills the oriented rects into a `width x height` grid (row 0 = the largest z; `ppm` cells per metre), keeping the strongest value per cell. */
export function fillRects(grid: Float32Array, width: number, height: number, bounds: Bounds, ppm: number, rects: readonly ContactRect[], grow: number): void {
  for (const rect of rects) {
    const r = (rect.rotation * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const corners = rectCorners(rect, grow);
    const xs = corners.map((c) => c[0]);
    const zs = corners.map((c) => c[1]);
    const cx0 = Math.max(0, Math.floor((Math.min(...xs) - bounds.x0) * ppm));
    const cx1 = Math.min(width - 1, Math.ceil((Math.max(...xs) - bounds.x0) * ppm));
    const rz0 = Math.max(0, Math.floor((bounds.z1 - Math.max(...zs)) * ppm));
    const rz1 = Math.min(height - 1, Math.ceil((bounds.z1 - Math.min(...zs)) * ppm));
    const hx = rect.half[0] + grow;
    const hz = rect.half[1] + grow;
    for (let row = rz0; row <= rz1; row++) {
      const z = bounds.z1 - (row + 0.5) / ppm - rect.centre[1];
      for (let col = cx0; col <= cx1; col++) {
        const x = bounds.x0 + (col + 0.5) / ppm - rect.centre[0];
        // inverse of the item rotation (see `toPlan`)
        const lx = x * cos - z * sin;
        const lz = x * sin + z * cos;
        if (Math.abs(lx) <= hx && Math.abs(lz) <= hz) {
          const i = row * width + col;
          if (grid[i]! < rect.strength) grid[i] = rect.strength;
        }
      }
    }
  }
}

/** Three box-blur passes per axis (approximating a gaussian of `sigmaPx`), in place. */
export function blur(grid: Float32Array, width: number, height: number, sigmaPx: number): void {
  const half = Math.floor(Math.round(Math.sqrt(4 * sigmaPx * sigmaPx + 1)) / 2);
  const size = 2 * half + 1;
  if (half < 1) return;
  const tmp = new Float32Array(Math.max(width, height));
  const pass = (get: (i: number) => number, set: (i: number, v: number) => void, n: number) => {
    let sum = 0;
    for (let i = -half; i <= half; i++) sum += i >= 0 && i < n ? get(i) : 0;
    for (let i = 0; i < n; i++) {
      tmp[i] = sum / size;
      const add = i + half + 1;
      const drop = i - half;
      sum += (add < n ? get(add) : 0) - (drop >= 0 ? get(drop) : 0);
    }
    for (let i = 0; i < n; i++) set(i, tmp[i]!);
  };
  for (let p = 0; p < 3; p++) {
    for (let row = 0; row < height; row++) pass((i) => grid[row * width + i]!, (i, v) => (grid[row * width + i] = v), width);
    for (let col = 0; col < width; col++) pass((i) => grid[i * width + col]!, (i, v) => (grid[i * width + col] = v), height);
  }
}

/** A wall as a rect along its length, minus floor-level openings (doors, passages), as footprints for the crease shadow. */
export function wallRects(scene: Pick<Scene, 'walls' | 'openings'>): ContactRect[] {
  const out: ContactRect[] = [];
  for (const wall of scene.walls) {
    const dx = wall.end[0] - wall.start[0];
    const dz = wall.end[1] - wall.start[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const ux = dx / len;
    const uz = dz / len;
    const rotation = (Math.atan2(-uz, ux) * 180) / Math.PI;
    // Spans [from, to] along the wall that are solid at floor level.
    const gaps = scene.openings
      .filter((o) => o.wallId === wall.id && o.sill < 0.05)
      .map((o) => [o.offset - o.width / 2, o.offset + o.width / 2] as const)
      .sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    const solid: [number, number][] = [];
    for (const [a, b] of gaps) {
      if (a > cursor) solid.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < len) solid.push([cursor, len]);
    for (const [a, b] of solid) {
      if (b - a < 0.05) continue;
      const m = (a + b) / 2;
      out.push({ id: wall.id, centre: [wall.start[0] + ux * m, wall.start[1] + uz * m], half: [(b - a) / 2, wall.thickness / 2], rotation, strength: 1 });
    }
  }
  return out;
}

/** The RGBA image (black, alpha = darkening) of the contact shadows of `rects` and the wall creases, covering `bounds`. */
export function rasterContactShadows(bounds: Bounds, ppm: number, rects: readonly ContactRect[], walls: readonly ContactRect[]): { width: number; height: number; data: Uint8Array } {
  const width = Math.max(8, Math.ceil((bounds.x1 - bounds.x0) * ppm));
  const height = Math.max(8, Math.ceil((bounds.z1 - bounds.z0) * ppm));
  const layer = (shapes: readonly ContactRect[], grow: number, sigma: number): Float32Array => {
    const g = new Float32Array(width * height);
    fillRects(g, width, height, bounds, ppm, shapes, grow);
    blur(g, width, height, sigma * ppm);
    return g;
  };
  const halo = layer(rects, 0.01, HALO.sigma);
  const contact = layer(rects.map((r) => ({ ...r, strength: r.strength * r.strength })), 0.004, CONTACT.sigma);
  const crease = layer(walls, 0, CREASE.sigma);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    // Independent layers combine like stacked translucent blacks.
    const clear = (1 - halo[i]! * HALO.alpha) * (1 - contact[i]! * CONTACT.alpha) * (1 - crease[i]! * CREASE.alpha);
    data[i * 4 + 3] = Math.round((1 - clear) * 255);
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------------------------
// Wall creases: soft dark gradients where a wall meets the floor, the ceiling and a neighbouring wall
// ---------------------------------------------------------------------------------------------

/** Strength (alpha at the crease) and reach (metres) of the gradients. */
export const WALL_AO = { floor: 0.3, ceiling: 0.26, corner: 0.28, floorReach: 0.32, ceilingReach: 0.28, cornerReach: 0.35 };

/** Triangle mesh of black translucent quads (alpha in the colour attribute), on the inner faces of the rooms. */
export interface CreaseMesh {
  positions: Float32Array;
  /** RGBA, black with the darkening in alpha. */
  colors: Float32Array;
  indices: Uint32Array;
}

type P2 = readonly [number, number];

function insidePolygon(p: P2, poly: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Crease gradients for every room: along each edge of the room polygon (the wall's inner face), minus the floor-level
 * openings, a gradient up from the floor and down from the ceiling, and at convex room corners a vertical one. Cheap
 * (a few hundred triangles, one draw call) and what gives walls their sense of enclosure.
 */
export function creaseMesh(scene: Pick<Scene, 'rooms' | 'walls' | 'openings'>, ceilingOf: (room: Scene['rooms'][number]) => number): CreaseMesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const wallById = new Map(scene.walls.map((w) => [w.id, w] as const));
  const alphaAt = (a: number, b: number) => 1 - (1 - a) * (1 - b);
  for (const room of scene.rooms) {
    const poly = room.polygon as readonly P2[];
    const n = poly.length;
    if (n < 3) continue;
    const H = Math.min(3.5, Math.max(1.5, ceilingOf(room)));
    // Shoelace sign: > 0 for one winding, < 0 for the other.
    const orientation = Math.sign(poly.reduce((sum, p, k) => sum + p[0] * poly[(k + 1) % n]![1] - poly[(k + 1) % n]![0] * p[1], 0));
    for (let i = 0; i < n; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % n]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.2) continue;
      const d: P2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      let nrm: P2 = [-d[1], d[0]];
      const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!insidePolygon([mid[0] + nrm[0] * 0.05, mid[1] + nrm[1] * 0.05], poly)) nrm = [-nrm[0], -nrm[1]];
      // Is the room corner at the start / end of this edge convex (interior angle under 180 degrees)?
      const convexAt = (v: P2, e0: P2, e1: P2): boolean => ((v[0] - e0[0]) * (e1[1] - v[1]) - (v[1] - e0[1]) * (e1[0] - v[0])) * orientation > 1e-9;
      const startConvex = convexAt(a, poly[(i + n - 1) % n]!, b);
      const endConvex = convexAt(b, a, poly[(i + 2) % n]!);
      // Floor-level openings on this edge.
      const gaps: [number, number][] = [];
      for (const o of scene.openings) {
        if (o.sill >= 0.05) continue;
        const wall = wallById.get(o.wallId);
        if (!wall) continue;
        const wl = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
        if (wl < 1e-6) continue;
        const cx = wall.start[0] + ((wall.end[0] - wall.start[0]) / wl) * o.offset;
        const cz = wall.start[1] + ((wall.end[1] - wall.start[1]) / wl) * o.offset;
        const t = (cx - a[0]) * d[0] + (cz - a[1]) * d[1];
        const off = Math.abs((cx - a[0]) * nrm[0] + (cz - a[1]) * nrm[1]);
        if (off <= wall.thickness + 0.05 && t > -o.width / 2 && t < len + o.width / 2) gaps.push([t - o.width / 2, t + o.width / 2]);
      }
      gaps.sort((x, y) => x[0] - y[0]);
      const solid: [number, number][] = [];
      let cursor = 0;
      for (const [g0, g1] of gaps) {
        if (g0 > cursor) solid.push([cursor, Math.min(g0, len)]);
        cursor = Math.max(cursor, g1);
      }
      if (cursor < len) solid.push([cursor, len]);
      for (const [s0, s1] of solid) {
        if (s1 - s0 < 0.1) continue;
        const cLen = Math.min(WALL_AO.cornerReach, (s1 - s0) / 2);
        const us = [s0, s0 + cLen, s1 - cLen, s1];
        const cornerAlpha = [s0 <= 1e-6 && startConvex ? WALL_AO.corner : 0, 0, 0, s1 >= len - 1e-6 && endConvex ? WALL_AO.corner : 0];
        const fR = Math.min(WALL_AO.floorReach, H / 3);
        const cR = Math.min(WALL_AO.ceilingReach, H / 3);
        const vs = [0, fR, H - cR, H];
        const rowAlpha = [WALL_AO.floor, 0, 0, WALL_AO.ceiling];
        const base = positions.length / 3;
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) {
            const u = us[c]!;
            positions.push(a[0] + d[0] * u + nrm[0] * 0.003, vs[r]!, a[1] + d[1] * u + nrm[1] * 0.003);
            colors.push(0, 0, 0, alphaAt(rowAlpha[r]!, cornerAlpha[c]!));
          }
        }
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) {
            const i0 = base + r * 4 + c;
            indices.push(i0, i0 + 1, i0 + 5, i0, i0 + 5, i0 + 4);
          }
        }
      }
    }
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors), indices: new Uint32Array(indices) };
}
