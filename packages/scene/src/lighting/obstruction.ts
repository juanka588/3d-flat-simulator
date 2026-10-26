import type { Point3 } from '../camera';
import type { SiteContext } from '../context/schema';
import type { Vec2 } from '../schema';

/** A context building as a vertical prism: footprint (with holes) extruded from `y0` to `y1`. */
export interface Prism {
  id: string;
  rings: Vec2[][]; // outer ring first, then holes
  y0: number;
  y1: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Rays are followed this far horizontally (metres); anything beyond is ignored. */
const MAX_REACH = 2000;

function pointInRing(x: number, y: number, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Do segments p1-p2 and q1-q2 cross (proper or touching intersection)? */
function segmentsCross(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const d = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(q1, q2, p1);
  const d2 = d(q1, q2, p2);
  const d3 = d(p1, p2, q1);
  const d4 = d(p1, p2, q2);
  return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0);
}

/**
 * Prisms of the context buildings that can block light reaching the flat.
 *
 * Neighbouring buildings (`host: false`) always count. Host bands count only when they start at
 * or above `flatTop` (the flat's wall height): the generator's below band can never be above a
 * ray, and its "flat storey" bands surround the flat's cut-away, so they must not block the
 * flat's own windows (that would put the flat inside masonry).
 */
export function contextPrisms(context: SiteContext, flatTop: number): Prism[] {
  const prisms: Prism[] = [];
  for (const b of context.buildings) {
    if (b.host && b.base < flatTop - 1e-6) continue;
    const rings = [b.footprint as Vec2[], ...((b.holes as Vec2[][] | undefined) ?? [])];
    const outer = rings[0]!;
    const xs = outer.map((p) => p[0]);
    const ys = outer.map((p) => p[1]);
    prisms.push({
      id: b.id,
      rings,
      y0: b.base,
      y1: b.base + b.height,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    });
  }
  return prisms;
}

/**
 * Is the ray from the world point (plan `x`, `y`, height `h`) towards the sun (`direction`,
 * unit vector, world axes: X = plan x, Y = up, Z = plan y) blocked by any prism?
 * Blocked when the part of the ray inside a prism's height range has an endpoint in solid
 * material (inside the outer ring and outside every hole) or crosses any ring edge.
 */
export function rayBlocked(prisms: readonly Prism[], x: number, y: number, h: number, direction: Point3): boolean {
  const [dx, dy, dz] = direction;
  if (!(dy > 1e-9)) return true; // not heading upwards: never reaches the sun over the roofs
  const horiz = Math.hypot(dx, dz);
  const tMax = horiz > 1e-9 ? MAX_REACH / horiz : Infinity;
  for (const p of prisms) {
    const t0 = Math.max(0, (p.y0 - h) / dy);
    const t1 = Math.min((p.y1 - h) / dy, tMax);
    if (!(t1 > t0)) continue;
    const a: Vec2 = [x + t0 * dx, y + t0 * dz];
    const b: Vec2 = [x + t1 * dx, y + t1 * dz];
    if (Math.max(a[0], b[0]) < p.minX || Math.min(a[0], b[0]) > p.maxX) continue;
    if (Math.max(a[1], b[1]) < p.minY || Math.min(a[1], b[1]) > p.maxY) continue;
    const solid = (q: Vec2) =>
      pointInRing(q[0], q[1], p.rings[0]!) && !p.rings.slice(1).some((r) => pointInRing(q[0], q[1], r));
    if (solid(a) || solid(b)) return true;
    for (const ring of p.rings) {
      for (let i = 0; i < ring.length; i++) {
        if (segmentsCross(a, b, ring[i]!, ring[(i + 1) % ring.length]!)) return true;
      }
    }
  }
  return false;
}
