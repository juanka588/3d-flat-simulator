import { hostBands } from '../context/bdtopo';
import type { ContextBuildingLike } from '../context/bdtopo';
import { DEG, fromEnu, planBasis, round } from '../geo/enu';
import { distToRing, pointInRing, segDist, signedArea } from '../geo/polygon';
import type { Pt, Rect } from '../geo/polygon';

/** The part of a Scene the fit reads: room polygons and wall segments, in plan metres. */
export interface FlatLike {
  rooms?: { type?: string; polygon: Pt[] }[];
  walls?: { id: string; start: Pt; end: Pt; thickness?: number }[];
}

export interface FitReport {
  area: number;
  maxDistance: number;
  north: { mid: number; ends: number; angle: number } | null;
  west: { mid: number; ends: number; angle: number } | null;
}

export interface FitResult {
  dx: number;
  dy: number;
  thetaDeg: number;
  edgeWeight: number;
  before: FitReport;
  after: FitReport;
}

type Samples = { points: Pt[]; cell: number };
type Edge = [Pt, Pt];

/**
 * Plan position of the flat's origin (in the host's plan axes) so that the flat's outer envelope
 * corner touches the corner `anchor` of the host's oriented box. `envelope` is the flat's interior
 * envelope in flat coordinates and `inset` the distance from it to the outer wall face.
 */
export function anchorOrigin(box: Rect, anchor: 'nw' | 'ne' | 'sw' | 'se', inset: number, envelope: Rect): Pt {
  const ox = anchor.endsWith('w') ? box.minX + inset - envelope.minX : box.maxX - inset - envelope.maxX;
  const oy = anchor.startsWith('n') ? box.minY + inset - envelope.minY : box.maxY - inset - envelope.maxY;
  return [ox, oy];
}

/**
 * Regular grid of sample points (cell centres, `cell` metres apart) covering the flat's exterior
 * envelope without the balcony: every non-balcony room polygon plus every wall slab that is not
 * part of a balcony (a wall whose centre line lies inside a balcony room's bounding box, give or take 5 cm, is a rail/screen).
 * Returns `{points, cell}`; each point stands for `cell`^2 m2.
 */
export function envelopeSamples(flat: FlatLike, cell = 0.05): Samples {
  const rooms = flat.rooms ?? [];
  const balconies = rooms.filter((r) => r.type === 'balcony').map((r) => r.polygon);
  const solid = rooms.filter((r) => r.type !== 'balcony').map((r) => r.polygon);
  const box = (pts: Pt[]): Rect => ({ minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])), minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])) });
  const balconyBoxes = balconies.map(box);
  const slabs: Pt[][] = [];
  for (const w of flat.walls ?? []) {
    const t = w.thickness ?? 0.2;
    const b = box([w.start, w.end]);
    const inBalcony = balconyBoxes.some((o) => b.minX >= o.minX - 0.05 && b.maxX <= o.maxX + 0.05 && b.minY >= o.minY - 0.05 && b.maxY <= o.maxY + 0.05);
    if (inBalcony) continue;
    const dx = w.end[0] - w.start[0];
    const dy = w.end[1] - w.start[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * (t / 2);
    const ny = (dx / l) * (t / 2);
    slabs.push([[w.start[0] + nx, w.start[1] + ny], [w.end[0] + nx, w.end[1] + ny], [w.end[0] - nx, w.end[1] - ny], [w.start[0] - nx, w.start[1] - ny]]);
  }
  const polys = [...solid, ...slabs];
  // Walls may run on past the flat (a north wall along a balcony's edge): keep the samples within the
  // non-balcony rooms' bounding box grown by the thickest wall, i.e. up to the outer wall faces. Columns
  // (walls shorter than twice their thickness) stand inside the rooms and do not count.
  const isColumn = (w: { start: Pt; end: Pt; thickness?: number }) => Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]) < 2 * (w.thickness ?? 0.2);
  const maxT = Math.max(0, ...(flat.walls ?? []).filter((w) => !isColumn(w)).map((w) => w.thickness ?? 0.2));
  const rb = box(solid.flat());
  const bb = { minX: rb.minX - maxT, maxX: rb.maxX + maxT, minY: rb.minY - maxT, maxY: rb.maxY + maxT };
  const points: Pt[] = [];
  for (let x = bb.minX + cell / 2; x < bb.maxX; x += cell) {
    for (let y = bb.minY + cell / 2; y < bb.maxY; y += cell) {
      if (polys.some((poly) => pointInRing([x, y], poly))) points.push([x, y]);
    }
  }
  return { points, cell };
}

/**
 * Outer face of a wall as a segment: the long side of a horizontal wall that faces plan up
 * (`north`) or of a vertical wall that faces plan left (`west`).
 */
export function outerFace(wall: { start: Pt; end: Pt; thickness?: number }, side: 'north' | 'west'): Edge {
  const t = (wall.thickness ?? 0.2) / 2;
  const [x0, y0] = wall.start;
  const [x1, y1] = wall.end;
  return side === 'north' ? [[Math.min(x0, x1), y0 - t], [Math.max(x0, x1), y0 - t]] : [[x0 - t, Math.min(y0, y1)], [x0 - t, Math.max(y0, y1)]];
}

/**
 * The footprint edge that the flat's `north`/`west` façade should sit on: an edge of the
 * rings whose outward normal is within 20 degrees of plan up / plan left, nearest to `near` when
 * given (else the longest). Returns `[a, b]` or null.
 */
export function referenceEdge(rings: readonly (readonly Pt[])[], side: 'north' | 'west', near: Pt | null = null): Edge | null {
  let best: { a: Pt; b: Pt; score: number } | null = null;
  for (const ring of rings) {
    const sign = signedArea(ring) >= 0 ? 1 : -1;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l < 1e-6) continue;
      // Outward normal for y-down coordinates: area sign flips with the handedness.
      const n = [((b[1] - a[1]) / l) * sign, (-(b[0] - a[0]) / l) * sign] as const;
      const want = side === 'north' ? [0, -1] : [-1, 0];
      if (n[0] * want[0]! + n[1] * want[1]! < Math.cos(20 * DEG)) continue;
      // With a reference point, the nearest candidate wins (the edge the façade actually faces);
      // otherwise the longest.
      const score = near ? -segDist(near, a, b) : l;
      if (!best || score > best.score) best = { a, b, score };
    }
  }
  return best ? [best.a, best.b] : null;
}

/** Rigid map of a flat-frame point into the footprint frame: p -> R(theta) p + t (theta clockwise on the y-down plan). */
export const rigid = (theta: number, tx: number, ty: number): ((p: Pt) => Pt) => {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return (p) => [p[0] * c - p[1] * s + tx, p[0] * s + p[1] * c + ty];
};

const lineOffset = (p: Pt, edge: Edge): number => {
  // Signed distance of p from the edge's line, positive on the outward (non-building) side is not
  // known here, so the caller squares or abs-es it.
  const [a, b] = edge;
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return ((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / l;
};

/** Overhang of the sample points (mapped by `map`) outside every footprint ring. */
export function overhang(samples: Samples, rings: readonly (readonly Pt[])[], map: (p: Pt) => Pt, withDistance = false): { area: number; maxDistance: number } {
  let n = 0;
  let maxD = 0;
  const bbs = rings.map((r) => ({ minX: Math.min(...r.map((p) => p[0])), maxX: Math.max(...r.map((p) => p[0])), minY: Math.min(...r.map((p) => p[1])), maxY: Math.max(...r.map((p) => p[1])) }));
  for (const sp of samples.points) {
    const p = map(sp);
    let inside = false;
    for (let i = 0; i < rings.length && !inside; i++) {
      const b = bbs[i]!;
      if (p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY && pointInRing(p, rings[i]!)) inside = true;
    }
    if (!inside) {
      n++;
      if (withDistance) maxD = Math.max(maxD, Math.min(...rings.map((r) => distToRing(p, r))));
    }
  }
  return { area: n * samples.cell * samples.cell, maxDistance: maxD };
}

/** Edge distances of a mapped façade from its reference edge: offset of the midpoint and of the worse end, plus angle. */
export function edgeReport(face: Edge | null, edge: Edge | null, map: (p: Pt) => Pt): FitReport['north'] {
  if (!face || !edge) return null;
  const a = map(face[0]);
  const b = map(face[1]);
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.atan2(edge[1][1] - edge[0][1], edge[1][0] - edge[0][0])) / DEG;
  const wrapped = ((((ang + 90) % 180) + 180) % 180) - 90;
  return { mid: Math.abs(lineOffset(mid, edge)), ends: Math.max(Math.abs(lineOffset(a, edge)), Math.abs(lineOffset(b, edge))), angle: wrapped };
}

interface Candidate {
  x: number[];
  v: number;
}

function nelderMead(f: (x: number[]) => number, x0: number[], step: number[], iters = 160): Candidate {
  const n = x0.length;
  let pts: Candidate[] = [x0, ...x0.map((_, i) => x0.map((v, j) => (j === i ? v + step[i]! : v)))].map((x) => ({ x, v: f(x) }));
  for (let it = 0; it < iters; it++) {
    pts.sort((p, q) => p.v - q.v);
    const best = pts[0]!;
    const worst = pts[n]!;
    const c = x0.map((_, j) => pts.slice(0, n).reduce((s, p) => s + p.x[j]!, 0) / n);
    const along = (k: number) => c.map((v, j) => v + k * (worst.x[j]! - v));
    const xr = along(-1);
    const fr = f(xr);
    if (fr < best.v) {
      const xe = along(-2);
      const fe = f(xe);
      pts[n] = fe < fr ? { x: xe, v: fe } : { x: xr, v: fr };
    } else if (fr < pts[n - 1]!.v) {
      pts[n] = { x: xr, v: fr };
    } else {
      const xc = fr < worst.v ? along(-0.5) : along(0.5);
      const fc = f(xc);
      if (fc < Math.min(fr, worst.v)) pts[n] = { x: xc, v: fc };
      else pts = pts.map((p, i) => (i === 0 ? p : { x: best.x.map((v, j) => v + 0.5 * (p.x[j]! - v)), v: f(best.x.map((v, j) => v + 0.5 * (p.x[j]! - v))) }));
    }
    if (Math.max(...pts.map((p) => p.v)) - Math.min(...pts.map((p) => p.v)) < 1e-7 && it > 30) break;
  }
  pts.sort((p, q) => p.v - q.v);
  return pts[0]!;
}

/**
 * Finds the rigid transform of the flat (translation + rotation within +-`maxRotationDeg`) that
 * minimises the flat's non-balcony exterior envelope lying outside the host footprint(s), plus a
 * soft penalty `edgeWeight` * (d_north^2 + d_west^2) on the distance of the north / west façades
 * from the footprint's corresponding outer edges (mean squared distance of the façade ends).
 * Coarse grid over (dx, dy, theta) on a coarse sample, then Nelder-Mead on a fine one from the
 * best candidates. The flat is rotated about the centre of its envelope while searching.
 *
 * `flat`: Scene-like `{rooms, walls}`; `rings`: host footprint rings in the footprint frame, which
 * is the frame the flat currently lives in. Returns `{dx, dy, thetaDeg, tx, ty, before, after}` where
 * the flat point p maps to R(theta) p + (tx, ty) in the footprint frame (theta clockwise, y down), and
 * `before`/`after` report `{area, maxDistance, north, west}`.
 */
export function fitFlatToFootprint(
  flat: FlatLike,
  rings: readonly (readonly Pt[])[],
  { maxRotationDeg = 3, maxShift = 5, edgeWeight = 0.5, northWall = 'w-north', westWall = 'w-west' }: { maxRotationDeg?: number; maxShift?: number; edgeWeight?: number; northWall?: string; westWall?: string } = {},
): FitResult {
  const fine = envelopeSamples(flat, 0.05);
  const report025 = 0.025;
  const mid = envelopeSamples(flat, 0.1);
  const coarse = envelopeSamples(flat, 0.25);
  const pts = fine.points;
  const centre: Pt = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  const find = (id: string) => (flat.walls ?? []).find((w) => w.id === id);
  const nw = find(northWall);
  const ww = find(westWall);
  const faceN = nw ? outerFace(nw, 'north') : null;
  const faceW = ww ? outerFace(ww, 'west') : null;
  const mid2 = (f: Edge | null): Pt | null => (f ? [(f[0][0] + f[1][0]) / 2, (f[0][1] + f[1][1]) / 2] : null);
  const edgeN = referenceEdge(rings, 'north', mid2(faceN));
  const edgeW = referenceEdge(rings, 'west', mid2(faceW));
  // x = [ux, uy, theta(rad)]: rotation about `centre`, then shift by u.
  const mapOf = (x: number[]) => {
    const r = rigid(x[2]!, 0, 0);
    const rc = r(centre);
    return rigid(x[2]!, centre[0] - rc[0] + x[0]!, centre[1] - rc[1] + x[1]!);
  };
  const penalty = (map: (p: Pt) => Pt) => {
    let p = 0;
    for (const [face, edge] of [[faceN, edgeN], [faceW, edgeW]] as const) {
      if (!face || !edge) continue;
      const d = [lineOffset(map(face[0]), edge), lineOffset(map(face[1]), edge)] as const;
      p += (d[0] * d[0] + d[1] * d[1]) / 2;
    }
    return edgeWeight * p;
  };
  const cost = (samples: Samples) => (x: number[]) => {
    const th = Math.max(-maxRotationDeg, Math.min(maxRotationDeg, x[2]! / DEG)) * DEG;
    const clamp = Math.abs(x[2]! / DEG) > maxRotationDeg ? 1e3 * (Math.abs(x[2]! / DEG) - maxRotationDeg) : 0;
    const map = mapOf([x[0]!, x[1]!, th]);
    return overhang(samples, rings, map).area + penalty(map) + clamp + 1e3 * Math.max(0, Math.hypot(x[0]!, x[1]!) - maxShift);
  };
  const cands: Candidate[] = [];
  const cc = cost(coarse);
  for (let th = -maxRotationDeg; th <= maxRotationDeg + 1e-9; th += maxRotationDeg / 3) {
    for (let ux = -maxShift; ux <= maxShift; ux += 0.25) for (let uy = -maxShift; uy <= maxShift; uy += 0.25) cands.push({ x: [ux, uy, th * DEG], v: cc([ux, uy, th * DEG]) });
  }
  cands.sort((a, b) => a.v - b.v);
  // Keep the best few that are not neighbours of each other.
  const starts: Candidate[] = [];
  for (const c of cands) {
    if (starts.every((s) => Math.hypot(s.x[0]! - c.x[0]!, s.x[1]! - c.x[1]!) > 0.75 || Math.abs(s.x[2]! - c.x[2]!) > 1.5 * DEG)) starts.push(c);
    if (starts.length === 3) break;
  }
  let best: Candidate | null = null;
  for (const s of starts) {
    const res = nelderMead(cost(mid), s.x, [0.2, 0.2, 0.5 * DEG], 80);
    if (!best || res.v < best.v) best = res;
  }
  best = nelderMead(cost(fine), best!.x, [0.05, 0.05, 0.15 * DEG], 60);
  const th0 = Math.max(-maxRotationDeg, Math.min(maxRotationDeg, best.x[2]! / DEG)) * DEG;
  const origin0 = mapOf([best.x[0]!, best.x[1]!, th0])([0, 0]);
  // Round to 0.01 degree and 1 mm so the stored northAngle / origin are tidy; report with the rounded values.
  const thetaDeg = Math.round((th0 / DEG) * 100) / 100;
  const origin = [Math.round(origin0[0] * 1000) / 1000, Math.round(origin0[1] * 1000) / 1000] as const;
  const map = rigid(thetaDeg * DEG, origin[0], origin[1]);
  const report = (m: (p: Pt) => Pt): FitReport => {
    const o = overhang(envelopeSamples(flat, report025), rings, m, true);
    return { area: o.area, maxDistance: o.maxDistance, north: edgeReport(faceN, edgeN, m), west: edgeReport(faceW, edgeW, m) };
  };
  return { dx: origin[0], dy: origin[1], thetaDeg, edgeWeight, before: report((p) => p), after: report(map) };
}

/**
 * Re-expresses a `SiteContext` in the frame of the flat after the rigid move `p -> R(theta) p + (dx, dy)`
 * found by `fitFlatToFootprint` (the flat keeps its own coordinates; the buildings move by the inverse
 * transform): footprints and holes become R(-theta)(q - t), `northAngle` decreases by theta and the
 * origin latitude/longitude moves to the new plan origin. The host's cut-away bands are rebuilt from
 * the full host footprint because the cut rectangle (the flat's bounds) does not move with the buildings.
 */
export function refitContext<C extends { origin: { latitude: number; longitude: number }; northAngle: number; buildings: ContextBuildingLike[] }>(
  context: C,
  fit: Pick<FitResult, 'dx' | 'dy' | 'thetaDeg'>,
  { flatCut, storeyBase = -0.05, storeyTop }: { flatCut: Rect; storeyBase?: number; storeyTop: number },
): C {
  const th = fit.thetaDeg * DEG;
  const c = Math.cos(th);
  const s = Math.sin(th);
  // R(-theta)(q - t); R(-theta) = [[c, s], [-s, c]] for the clockwise-positive y-down rotation.
  const inv = (q: Pt): Pt => {
    const x = q[0] - fit.dx;
    const y = q[1] - fit.dy;
    return [round(x * c + y * s, 2), round(-x * s + y * c, 2)];
  };
  const moveB = (b: ContextBuildingLike): ContextBuildingLike => ({ ...b, footprint: b.footprint.map(inv), ...(b.holes ? { holes: b.holes.map((h) => h.map(inv)) } : {}) });
  const hostIds = [...new Set(context.buildings.filter((b) => b.host).map((b) => b.id.replace(/:(below|flat-storey-\d+|above)$/, '')))];
  const buildings = context.buildings.filter((b) => !b.host).map(moveB);
  for (const id of hostIds) {
    const bands = context.buildings.filter((b) => b.host && (b.id === id || b.id.startsWith(`${id}:`)));
    const full = bands.find((b) => b.id.endsWith(':above')) ?? bands.find((b) => b.id.endsWith(':below'));
    if (!full) throw new Error(`Host ${id} has no full-footprint band; cannot rebuild the cut-away`);
    const base = Math.min(...bands.map((b) => b.base));
    const roofTop = Math.max(...bands.map((b) => b.base + b.height));
    const moved = moveB(full);
    buildings.push(
      ...hostBands({ id, footprint: moved.footprint, holes: moved.holes ?? [], base, height: roofTop - base, storeyBase, storeyTop, flatCut }).map((b) => ({
        ...b,
        base: round(b.base, 3),
        height: round(b.height, 3),
      })),
    );
  }
  const bx = 90 - context.northAngle;
  const { ex, ey } = planBasis(bx);
  const [latitude, longitude] = fromEnu(fit.dx * ex[0] + fit.dy * ey[0], fit.dx * ex[1] + fit.dy * ey[1], context.origin.latitude, context.origin.longitude);
  return { ...context, origin: { latitude: round(latitude, 8), longitude: round(longitude, 8) }, northAngle: round(context.northAngle - fit.thetaDeg, 4), buildings };
}

/** Full host footprint rings (one per host building) of a context, in its plan frame. */
export function hostRings(context: { buildings: ContextBuildingLike[] }): Pt[][] {
  const seen = new Map<string, Pt[]>();
  for (const b of context.buildings) {
    if (!b.host || !/:(above|below)$/.test(b.id)) continue;
    seen.set(b.id.replace(/:(above|below)$/, ''), b.footprint);
  }
  return [...seen.values()];
}
