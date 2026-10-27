import { polygonArea } from './measure';
import type { Scene } from './schema';
import { roomCeilingHeight } from './geometry/floors';

export type Point3 = [number, number, number];

/** Axis-aligned world-space box (X = plan x, Y = up, Z = plan y), in metres. */
export interface Box3 {
  min: Point3;
  max: Point3;
}

/** Box around every wall footprint (centreline plus half thickness) and room polygon, from the floor up. */
export function sceneBounds3(scene: Scene): Box3 {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let maxY = 0;
  const add = (x: number, z: number, pad = 0) => {
    minX = Math.min(minX, x - pad);
    maxX = Math.max(maxX, x + pad);
    minZ = Math.min(minZ, z - pad);
    maxZ = Math.max(maxZ, z + pad);
  };
  for (const w of scene.walls) {
    // The wall's exact rectangle: its ends are not padded, so a thick, short wall (a column) stays where it is.
    const len = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
    const nx = len > 0 ? ((w.end[1] - w.start[1]) / len) * (w.thickness / 2) : w.thickness / 2;
    const nz = len > 0 ? (-(w.end[0] - w.start[0]) / len) * (w.thickness / 2) : w.thickness / 2;
    for (const p of [w.start, w.end]) {
      add(p[0] + nx, p[1] + nz);
      add(p[0] - nx, p[1] - nz);
    }
    maxY = Math.max(maxY, w.height);
  }
  for (const r of scene.rooms) {
    for (const p of r.polygon) add(p[0], p[1]);
    if (r.type !== 'balcony' && polygonArea(r.polygon) > 0) maxY = Math.max(maxY, roomCeilingHeight(scene, r));
  }
  if (!Number.isFinite(minX)) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: [minX, 0, minZ], max: [maxX, maxY, maxZ] };
}

export type CameraMode = 'orbit' | 'top';

export interface FitOptions {
  /** Vertical field of view in degrees. */
  fovDeg: number;
  /** Viewport width / height. */
  aspect: number;
  mode: CameraMode;
  /** Fraction of extra room around the box on every side. Default 0.1. */
  margin?: number;
}

export interface CameraFit {
  position: Point3;
  target: Point3;
  /** World up for `lookAt`: +Y for orbit, -Z for top so plan north (-y) is screen up. */
  up: Point3;
  /** Half the visible height for an orthographic top camera that fits the same box. */
  orthoHalfHeight?: number;
}

/** Orbit camera elevation above the horizon; it sits south-east (+X, +Z) of the target. */
export const ORBIT_ELEVATION_DEG = 45;

const sub = (a: Point3, b: Point3): Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point3, b: Point3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point3, b: Point3): Point3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Point3): Point3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function boxCorners(b: Box3): Point3[] {
  const out: Point3[] = [];
  for (const x of [b.min[0], b.max[0]]) {
    for (const y of [b.min[1], b.max[1]]) {
      for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
    }
  }
  return out;
}

/**
 * Places a perspective camera so that all 8 box corners project inside the frustum, with
 * `margin` (default 10 %) to spare. The target is the box centre; the camera sits on the
 * view ray at the smallest distance that satisfies every corner (closed form: for a corner
 * at lateral offset `x` and depth offset `f` from the target, depth `d + f` must be at
 * least `(1 + margin) * |x| / (tan(fov/2) * aspectFactor)`).
 *
 * `orbit` views from the south-east (+X, +Z) at 45 degrees elevation; `top` looks straight
 * down with up = -Z. In `top` mode `orthoHalfHeight` is also returned for orthographic cameras.
 */
export function fitCamera(bounds: Box3, options: FitOptions): CameraFit {
  const { fovDeg, aspect, mode } = options;
  const margin = options.margin ?? 0.1;
  const target: Point3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];

  let toCamera: Point3;
  let up: Point3;
  if (mode === 'top') {
    toCamera = [0, 1, 0];
    up = [0, 0, -1];
  } else {
    const el = (ORBIT_ELEVATION_DEG * Math.PI) / 180;
    const horizontal = Math.cos(el) / Math.SQRT2; // equal east and south components
    toCamera = [horizontal, Math.sin(el), horizontal];
    up = [0, 1, 0];
  }
  const forward: Point3 = [-toCamera[0], -toCamera[1], -toCamera[2]];
  const right = norm(cross(forward, up));
  const camUp = cross(right, forward);

  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * aspect;
  const k = 1 + margin;
  let distance = 0;
  let halfWidth = 0;
  let halfHeight = 0;
  for (const corner of boxCorners(bounds)) {
    const rel = sub(corner, target);
    const x = Math.abs(dot(rel, right));
    const y = Math.abs(dot(rel, camUp));
    const f = dot(rel, forward);
    halfWidth = Math.max(halfWidth, x);
    halfHeight = Math.max(halfHeight, y);
    // Depth along the view axis is `distance + f`; keep the corner in front of the camera too.
    distance = Math.max(distance, (k * x) / tanH - f, (k * y) / tanV - f, -f + 0.1);
  }
  const position: Point3 = [
    target[0] + toCamera[0] * distance,
    target[1] + toCamera[1] * distance,
    target[2] + toCamera[2] * distance,
  ];
  const fit: CameraFit = { position, target, up };
  if (mode === 'top') fit.orthoHalfHeight = Math.max(k * halfHeight, (k * halfWidth) / aspect, 0.1);
  return fit;
}
