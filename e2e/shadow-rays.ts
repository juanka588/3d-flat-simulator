/**
 * A tiny sun-ray tracer over the flat's JSON (walls, openings, room polygons), used by the e2e
 * shadow tests to find floor points whose only occluder is a single thin partition, so that a
 * shadow-bias error shows up as light leaking under that wall.
 */
type P2 = [number, number];

export interface RayWall {
  id: string;
  start: P2;
  end: P2;
  thickness: number;
  height: number | null;
}
export interface RayOpening {
  wallId: string;
  type: string;
  glazed: boolean | null;
  offset: number;
  width: number;
  sill: number | null;
  height: number;
}
export interface RayRoom {
  id: string;
  type?: string;
  polygon: P2[];
  /** A part of the floor with its own material: its albedo differs from the room's, so ratios across it mean nothing. */
  floorZones?: { polygon: P2[] }[] | null;
}
export interface RayItem {
  position: P2;
  rotation: number;
  dims?: { w: number; d: number; h: number } | null;
}
export interface RayFlat {
  walls: RayWall[];
  openings: RayOpening[];
  rooms: RayRoom[];
  /** Furniture: a probe point under one would read the top of the item in a top view, not the floor, so it is skipped. */
  items?: RayItem[];
}

const DEFAULT_WALL_HEIGHT = 2.5;
const CEILING = 2.5;
/** Rays must clear opening edges by this much (metres) to count as passing through the glass. */
const EDGE = 0.12;
/** Partitions are walls up to this thick. */
const PARTITION_MAX = 0.1;
/** Probe points keep this far (metres) from furniture and from other walls, so the luma reads bare floor. */
const ITEM_MARGIN = 0.1;

export function inPoly(p: P2, polygon: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when a floor point is within `margin` of an item footprint (a rotated w x d rectangle about its position). */
function onItem(flat: RayFlat, p: P2, margin: number): boolean {
  for (const it of flat.items ?? []) {
    if (!it.dims) continue;
    const a = (it.rotation * Math.PI) / 180;
    const dx = p[0] - it.position[0];
    const dy = p[1] - it.position[1];
    // item local x is plan x at rotation 0; rotation is counter-clockwise seen from above (plan y grows down)
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) <= it.dims.w / 2 + margin && Math.abs(ly) <= it.dims.d / 2 + margin) return true;
  }
  return false;
}

function onZone(flat: RayFlat, p: P2): boolean {
  return flat.rooms.some((r) => (r.floorZones ?? []).some((z) => inPoly(p, z.polygon)));
}

/** True when a floor point lies inside (or within `margin` of) a wall other than `except`: columns and partitions read as wall tops. */
function onOtherWall(flat: RayFlat, p: P2, margin: number, except: string): boolean {
  for (const w of flat.walls) {
    if (w.id === except) continue;
    const length = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
    if (length < 1e-9) continue;
    const d: P2 = [(w.end[0] - w.start[0]) / length, (w.end[1] - w.start[1]) / length];
    const a = (p[0] - w.start[0]) * d[0] + (p[1] - w.start[1]) * d[1];
    const c = -(p[0] - w.start[0]) * d[1] + (p[1] - w.start[1]) * d[0];
    if (a >= -w.thickness / 2 - margin && a <= length + w.thickness / 2 + margin && Math.abs(c) <= w.thickness / 2 + margin) return true;
  }
  return false;
}

/** An opening lets light through when it is a window, a glazed door or a passage. */
const transparent = (o: RayOpening) => o.type === 'passage' || (o.glazed ?? o.type === 'window');

interface Trace {
  /** Walls the ray crosses below their top (not through glass). */
  hits: string[];
  /** The ray passes too close to an opening edge, a wall end or the ceiling edge to be sure. */
  uncertain: boolean;
  /** The ray reaches the ceiling height inside a room. */
  ceiling: boolean;
}

/** Ray from the floor point `from` (at height 0.02) towards the sun: horizontal unit `u`, slope `tan(altitude)`. */
export function traceToSun(flat: RayFlat, from: P2, u: P2, tanAlt: number): Trace {
  const y0 = 0.02;
  const out: Trace = { hits: [], uncertain: false, ceiling: false };
  for (const wall of flat.walls) {
    const [ax, ay] = wall.start;
    const length = Math.hypot(wall.end[0] - ax, wall.end[1] - ay);
    if (length < 1e-9) continue;
    const d: P2 = [(wall.end[0] - ax) / length, (wall.end[1] - ay) / length];
    const n: P2 = [-d[1], d[0]];
    const half = wall.thickness / 2;
    const a0 = (from[0] - ax) * d[0] + (from[1] - ay) * d[1];
    const c0 = (from[0] - ax) * n[0] + (from[1] - ay) * n[1];
    const da = u[0] * d[0] + u[1] * d[1];
    const dc = u[0] * n[0] + u[1] * n[1];
    // Interval of s with |c| <= half and a within the (end-extended) wall.
    let lo = 0;
    let hi = Infinity;
    const clip = (v0: number, dv: number, min: number, max: number) => {
      if (Math.abs(dv) < 1e-9) {
        if (v0 < min || v0 > max) hi = -Infinity;
        return;
      }
      const s1 = (min - v0) / dv;
      const s2 = (max - v0) / dv;
      lo = Math.max(lo, Math.min(s1, s2));
      hi = Math.min(hi, Math.max(s1, s2));
    };
    clip(c0, dc, -half, half);
    clip(a0, da, -half, length + half);
    if (!(hi > lo)) continue;
    const top = wall.height ?? DEFAULT_WALL_HEIGHT;
    const yLo = y0 + lo * tanAlt;
    const yHi = y0 + hi * tanAlt;
    if (yLo > top + EDGE) continue; // passes over the wall
    if (yHi < 0) continue;
    const mid = (lo + hi) / 2;
    const along = a0 + mid * da;
    const height = y0 + mid * tanAlt;
    let open = false;
    for (const o of flat.openings) {
      if (o.wallId !== wall.id) continue;
      const sill = o.sill ?? 0;
      const insideSpan = Math.abs(along - o.offset) <= o.width / 2 - EDGE && height >= sill + EDGE && height <= sill + o.height - EDGE;
      const nearSpan = Math.abs(along - o.offset) <= o.width / 2 + EDGE && height >= sill - EDGE && height <= sill + o.height + EDGE;
      if (insideSpan && transparent(o)) open = true;
      else if (nearSpan && !insideSpan) out.uncertain = true;
    }
    if (!open) {
      if (yLo > top - EDGE) out.uncertain = true; // skims the top of the wall
      out.hits.push(wall.id);
    }
    if (along < half + EDGE || along > length - half - EDGE) out.uncertain = true; // near a wall end / corner
  }
  const sCeiling = (CEILING - y0) / tanAlt;
  for (const k of [-0.25, 0, 0.25]) {
    const s = sCeiling + k;
    if (s <= 0) continue;
    const at: P2 = [from[0] + u[0] * s, from[1] + u[1] * s];
    if (flat.rooms.some((r) => r.type !== 'balcony' && inPoly(at, r.polygon))) out.ceiling = true;
  }
  return out;
}

export interface WallShadowProbe {
  wallId: string;
  /** Floor point 10 cm behind the wall, as seen from the sun: its only occluder is that wall. */
  behind: P2;
  /** Floor point 10 cm in front of it, sunlit; null when the wall is an exterior wall (nothing to probe outside). */
  lit: P2 | null;
}

/**
 * Floor points whose only occluder, seen from the sun, is one wall (the sun otherwise reaches them
 * through glass), so a shadow-bias error shows up as light leaking under that wall.
 * With `partitions: true` the wall is a thin interior partition and the sunlit point on its other
 * side is returned as well; with `partitions: false` it is a thick (exterior) wall.
 * `direction` points towards the sun (world x, y up, z).
 */
export function findWallShadowProbes(flat: RayFlat, direction: [number, number, number], partitions: boolean, gap = 0.1): WallShadowProbe[] {
  const horizontal = Math.hypot(direction[0], direction[2]);
  if (horizontal < 1e-6 || direction[1] <= 0) return [];
  const u: P2 = [direction[0] / horizontal, direction[2] / horizontal];
  const tanAlt = direction[1] / horizontal;
  const probes: WallShadowProbe[] = [];
  const inRoom = (p: P2) => flat.rooms.some((r) => r.type !== 'balcony' && inPoly(p, r.polygon));
  for (const wall of flat.walls) {
    if ((wall.thickness <= PARTITION_MAX) !== partitions) continue;
    const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
    const d: P2 = [(wall.end[0] - wall.start[0]) / length, (wall.end[1] - wall.start[1]) / length];
    const n: P2 = [-d[1], d[0]];
    // Normal pointing away from the sun: the lee side.
    const lee: P2 = u[0] * n[0] + u[1] * n[1] > 0 ? [-n[0], -n[1]] : n;
    if (Math.abs(u[0] * lee[0] + u[1] * lee[1]) < 0.3) continue; // too grazing
    const off = wall.thickness / 2 + gap;
    for (let s = 0.3; s < length - 0.3; s += 0.1) {
      const c: P2 = [wall.start[0] + d[0] * s, wall.start[1] + d[1] * s];
      const behind: P2 = [c[0] + lee[0] * off, c[1] + lee[1] * off];
      if (!inRoom(behind) || onItem(flat, behind, ITEM_MARGIN) || onZone(flat, behind) || onOtherWall(flat, behind, ITEM_MARGIN, wall.id)) continue;
      const tb = traceToSun(flat, behind, u, tanAlt);
      if (tb.uncertain || tb.ceiling || tb.hits.length !== 1 || tb.hits[0] !== wall.id) continue;
      if (!partitions) {
        probes.push({ wallId: wall.id, behind, lit: null });
        continue;
      }
      const lit: P2 = [c[0] - lee[0] * off, c[1] - lee[1] * off];
      if (!inRoom(lit) || onItem(flat, lit, ITEM_MARGIN) || onZone(flat, lit) || onOtherWall(flat, lit, ITEM_MARGIN, wall.id)) continue;
      const tl = traceToSun(flat, lit, u, tanAlt);
      if (!tl.uncertain && !tl.ceiling && tl.hits.length === 0) probes.push({ wallId: wall.id, behind, lit });
    }
  }
  return probes;
}
