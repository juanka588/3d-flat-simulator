import { BUILTIN_ASSETS } from '../items/builtin-assets';
import type { Dims, ItemMount } from '../primitives';
import type { Item, Vec2 } from '../schema';

/**
 * Plan footprints of items (rotated rectangles) and the separating-axis test the placement rules use.
 * Item frame as in `assets/builtin.ts`: local +x is the item's right seen from the front, local +z the
 * front; at `rotation` r (degrees, counter-clockwise seen from above) local x maps to the plan direction
 * `[cos r, -sin r]` and local z to `[sin r, cos r]`.
 */

/** Penetration (metres) below which two shapes only "touch": flush contact is not an overlap. */
export const TOUCH_TOLERANCE = 0.005;
/** Items at most this high are floor coverings (rugs): they do not collide with furniture or block walking. */
export const FLAT_MAX_H = 0.03;

const DEG = Math.PI / 180;

/** Plan direction the item's front faces. */
export function frontOf(rotationDeg: number): Vec2 {
  const r = rotationDeg * DEG;
  return [Math.sin(r), Math.cos(r)];
}

/** Plan direction of the item's local +x (its right seen from the front). */
export function rightOf(rotationDeg: number): Vec2 {
  const r = rotationDeg * DEG;
  return [Math.cos(r), -Math.sin(r)];
}

/** Local `(x, z)` offset of an item to plan coordinates (without translation). */
export function localToPlan(rotationDeg: number, x: number, z: number): Vec2 {
  const r = rotationDeg * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [x * c + z * s, -x * s + z * c];
}

/** Rotation (degrees, in [0, 360)) whose front faces the plan direction `dir`. */
export function rotationFacing(dir: Vec2): number {
  const deg = Math.atan2(dir[0], dir[1]) / DEG;
  return round4(((deg % 360) + 360) % 360);
}

export const round4 = (n: number): number => {
  const v = Math.round(n * 1e4) / 1e4;
  return Object.is(v, -0) ? 0 : v;
};

/** The four corners of the footprint, counter-clockwise in local axes. */
export function footprintOf(position: Vec2, rotationDeg: number, dims: Pick<Dims, 'w' | 'd'>): Vec2[] {
  const hw = dims.w / 2;
  const hd = dims.d / 2;
  const corner = (x: number, z: number): Vec2 => {
    const o = localToPlan(rotationDeg, x, z);
    return [position[0] + o[0], position[1] + o[1]];
  };
  return [corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd)];
}

/** Rectangle swept by the segment `a -> b` with `half` on each side (a wall piece). */
export function segmentRect(a: Vec2, b: Vec2, half: number): Vec2[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dx = (b[0] - a[0]) / len;
  const dy = (b[1] - a[1]) / len;
  const nx = -dy * half;
  const ny = dx * half;
  return [
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny],
    [a[0] - nx, a[1] - ny],
  ];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(points: readonly Vec2[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

export const boundsTouch = (a: Bounds, b: Bounds, pad = 0): boolean =>
  a.minX <= b.maxX + pad && b.minX <= a.maxX + pad && a.minY <= b.maxY + pad && b.minY <= a.maxY + pad;

/**
 * Separating axis test of two CONVEX polygons. Returns the penetration depth (the smallest overlap over
 * all edge normals, i.e. the shortest push that separates them); 0 when they are apart or only touch.
 */
export function penetration(a: readonly Vec2[], b: readonly Vec2[]): number {
  let depth = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      let nx = q[1] - p[1];
      let ny = p[0] - q[0];
      const len = Math.hypot(nx, ny);
      if (len < 1e-12) continue;
      nx /= len;
      ny /= len;
      let minA = Infinity;
      let maxA = -Infinity;
      for (const v of a) {
        const t = v[0] * nx + v[1] * ny;
        if (t < minA) minA = t;
        if (t > maxA) maxA = t;
      }
      let minB = Infinity;
      let maxB = -Infinity;
      for (const v of b) {
        const t = v[0] * nx + v[1] * ny;
        if (t < minB) minB = t;
        if (t > maxB) maxB = t;
      }
      const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);
      if (overlap <= 0) return 0;
      if (overlap < depth) depth = overlap;
    }
  }
  return depth === Infinity ? 0 : depth;
}

/** True when the convex polygons overlap by more than `TOUCH_TOLERANCE`. */
export const overlaps = (a: readonly Vec2[], b: readonly Vec2[], tolerance = TOUCH_TOLERANCE): boolean => penetration(a, b) > tolerance;

/** Point inside a convex polygon (either winding), boundary included. */
export function insideConvex(p: Vec2, poly: readonly Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(cross) < 1e-12) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// ---- items ----------------------------------------------------------------------------------------

/** Footprint dimensions of an item: its own `dims`, else the product's, else the builtin asset's, else a 0.3 m cube. */
export function itemDims(item: Pick<Item, 'assetId' | 'dims' | 'product'>): Dims {
  return item.dims ?? item.product?.dims ?? BUILTIN_ASSETS[item.assetId]?.dims ?? { w: 0.3, d: 0.3, h: 0.3 };
}

export function itemMountOf(item: Pick<Item, 'assetId' | 'mount'>): ItemMount {
  return item.mount ?? BUILTIN_ASSETS[item.assetId]?.mount ?? 'floor';
}

/** Everything the placement rules need to know about one item, derived once. */
export interface ItemBox {
  id: string;
  /** Index in `scene.items`. */
  index: number;
  roomId: string | undefined;
  position: Vec2;
  rotation: number;
  elevation: number;
  dims: Dims;
  mount: ItemMount;
  locked: boolean;
  /** Floor covering: no collisions, never blocks walking. */
  flat: boolean;
  footprint: Vec2[];
  bounds: Bounds;
  bottom: number;
  top: number;
}

export function makeBox(
  id: string,
  index: number,
  roomId: string | undefined,
  position: Vec2,
  rotation: number,
  elevation: number,
  dims: Dims,
  mount: ItemMount,
  locked: boolean,
): ItemBox {
  const footprint = footprintOf(position, rotation, dims);
  return {
    id,
    index,
    roomId,
    position,
    rotation,
    elevation,
    dims,
    mount,
    locked,
    flat: mount === 'floor' && elevation === 0 && dims.h <= FLAT_MAX_H,
    footprint,
    bounds: boundsOf(footprint),
    bottom: elevation,
    top: elevation + dims.h,
  };
}

export function boxOfItem(item: Item, index: number): ItemBox {
  return makeBox(item.id, index, item.roomId, item.position, item.rotation, item.elevation, itemDims(item), itemMountOf(item), item.locked === true);
}
