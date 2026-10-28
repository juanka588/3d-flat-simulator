import { DEG, wrap180 } from './enu';

export type Pt = [number, number];
export interface Rect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function signedArea(p: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i]!;
    const [x2, y2] = p[(i + 1) % p.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function cleanRing(ring: readonly Pt[], eps = 0.01): Pt[] {
  let pts: Pt[] = ring.map((p): Pt => [p[0], p[1]]);
  const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (pts.length > 1 && dist(pts[0]!, pts.at(-1)!) < eps) pts.pop();
  pts = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]!) >= eps);
  // Drop collinear vertices.
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % pts.length]!;
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cross) < 1e-4 * Math.max(1, dist(a, c))) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/** Keeps the part of `poly` where `f(p)` (signed distance) >= 0. Sutherland-Hodgman. */
export function clipHalfPlane(poly: Pt[], f: (p: Pt) => number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Area of the intersection of `poly` and the rectangle `r` (0 when they do not overlap). */
export function polygonIntersectsRect(poly: Pt[], r: Rect): number {
  let p = poly;
  for (const f of [
    (q: Pt) => q[0] - r.minX,
    (q: Pt) => r.maxX - q[0],
    (q: Pt) => q[1] - r.minY,
    (q: Pt) => r.maxY - q[1],
  ]) {
    p = clipHalfPlane(p, f);
    if (p.length < 3) return 0;
  }
  return Math.abs(signedArea(p));
}

/** `poly` minus an axis-aligned rectangle, as up to four disjoint pieces. */
export function subtractRect(poly: Pt[], r: Rect): Pt[][] {
  if (polygonIntersectsRect(poly, r) < 1e-6) return [poly];
  const mid = [(q: Pt) => q[0] - r.minX, (q: Pt) => r.maxX - q[0]];
  const defs = [
    [(q: Pt) => r.minX - q[0]],
    [(q: Pt) => q[0] - r.maxX],
    [...mid, (q: Pt) => r.minY - q[1]],
    [...mid, (q: Pt) => q[1] - r.maxY],
  ];
  const pieces: Pt[][] = [];
  for (const fs of defs) {
    let p = poly;
    for (const f of fs) p = clipHalfPlane(p, f);
    p = cleanRing(p, 0.02);
    if (p.length >= 3 && Math.abs(signedArea(p)) > 0.05) pieces.push(p);
  }
  return pieces;
}

export function pointInRing(pt: Pt, ring: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from `p` to the segment `a`-`b`. */
export const segDist = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/** Distance from `p` to the boundary of a ring. */
export function distToRing(p: Pt, ring: readonly Pt[]): number {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) d = Math.min(d, segDist(p, ring[i]!, ring[(i + 1) % ring.length]!));
  return d;
}

/** Dominant orientation (compass bearing of an edge, mod 90) of a ring in ENU, edge-length weighted. */
export function dominantBearing(ring: readonly Pt[]): number {
  const edges = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length]!;
    return { len: Math.hypot(b[0] - a[0], b[1] - a[1]), bearing: Math.atan2(b[0] - a[0], b[1] - a[1]) / DEG };
  });
  // Length-weighted circular mean of bearing mod 90 (4x angle trick), then re-estimated without
  // edges more than 8 degrees away (chamfers, bay windows) so they do not skew the axis.
  const mean = (list: typeof edges) => {
    let c = 0;
    let s = 0;
    for (const e of list) {
      c += e.len * Math.cos(4 * e.bearing * DEG);
      s += e.len * Math.sin(4 * e.bearing * DEG);
    }
    return Math.atan2(s, c) / 4 / DEG;
  };
  let axis = mean(edges);
  const near = edges.filter((e) => Math.abs(wrap180(4 * (e.bearing - axis)) / 4) <= 8);
  if (near.length >= 2) axis = mean(near);
  return ((axis % 90) + 90) % 90;
}
