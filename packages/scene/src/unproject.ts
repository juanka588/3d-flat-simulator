/**
 * Pinhole camera maths for the render passes (CG1): pixel + depth + camera <-> world / plan coordinates.
 * Pure maths, no three. World axes are the scene's: X = plan x, Y = up, Z = plan y (north is -Z), metres.
 *
 * Image convention: continuous pixel coordinates with the origin at the top-left corner of the image, x to the
 * right and y DOWN; the centre of pixel (i, j) is (i + 0.5, j + 0.5). Depth is the distance along the camera's
 * optical axis (the view-space z, what the depth pass stores), not the distance to the camera.
 */
import type { Point3 } from './camera';

/** A perspective camera: where it is, which way it looks, and its vertical field of view and image size. */
export interface PinholeCamera {
  position: Point3;
  /** Orthonormal basis in world space: screen +x, screen +y (up) and the viewing direction. */
  right: Point3;
  up: Point3;
  forward: Point3;
  /** Vertical field of view in degrees. */
  fovDeg: number;
  /** Image size in pixels. */
  width: number;
  height: number;
}

/** Intrinsics in pixels (square pixels, principal point at the image centre). */
export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

export function intrinsicsOf(cam: Pick<PinholeCamera, 'fovDeg' | 'width' | 'height'>): Intrinsics {
  const f = cam.height / 2 / Math.tan((cam.fovDeg * Math.PI) / 360);
  return { fx: f, fy: f, cx: cam.width / 2, cy: cam.height / 2 };
}

/**
 * The camera of a three.js `matrixWorld` (16 numbers, column-major, camera to world; the camera looks down its local
 * -Z with +Y up, so the basis is column 0, column 1 and minus column 2).
 */
export function cameraFromMatrixWorld(m: ArrayLike<number>, fovDeg: number, width: number, height: number): PinholeCamera {
  return {
    position: [m[12]!, m[13]!, m[14]!],
    right: [m[0]!, m[1]!, m[2]!],
    up: [m[4]!, m[5]!, m[6]!],
    forward: [-m[8]!, -m[9]!, -m[10]!],
    fovDeg,
    width,
    height,
  };
}

/** The world point seen at pixel `(x, y)` (continuous, see the file comment) at `depth` metres along the optical axis. */
export function unprojectPixel(cam: PinholeCamera, x: number, y: number, depth: number): Point3 {
  const { fx, fy, cx, cy } = intrinsicsOf(cam);
  const xc = ((x - cx) / fx) * depth;
  const yc = (-(y - cy) / fy) * depth;
  return [0, 1, 2].map((i) => cam.position[i]! + cam.right[i]! * xc + cam.up[i]! * yc + cam.forward[i]! * depth) as Point3;
}

/** The pixel (continuous) and depth at which a world point appears. `depth <= 0` means the point is behind the camera. */
export function projectToPixel(cam: PinholeCamera, world: Point3): { x: number; y: number; depth: number } {
  const { fx, fy, cx, cy } = intrinsicsOf(cam);
  const d = [0, 1, 2].map((i) => world[i]! - cam.position[i]!) as Point3;
  const dot = (a: Point3) => a[0] * d[0] + a[1] * d[1] + a[2] * d[2];
  const depth = dot(cam.forward);
  return { x: cx + (fx * dot(cam.right)) / depth, y: cy - (fy * dot(cam.up)) / depth, depth };
}

/** Plan coordinates `[x, y]` of a world point (the plan's y is the world Z). */
export const worldToPlan = (p: Point3): [number, number] => [p[0], p[2]];

/** The world point above plan point `[x, y]` at height `height` (default: floor level). */
export const planToWorld = (plan: readonly [number, number], height = 0): Point3 => [plan[0], height, plan[1]];

/** Pixel + depth to plan coordinates and height above the floor: what a reference image pixel means in the flat. */
export function pixelToPlan(cam: PinholeCamera, x: number, y: number, depth: number): { plan: [number, number]; height: number; world: Point3 } {
  const world = unprojectPixel(cam, x, y, depth);
  return { plan: worldToPlan(world), height: world[1], world };
}

/** The pixel and depth of a plan point at `height` metres above the floor (the inverse of `pixelToPlan`). */
export function planToPixel(cam: PinholeCamera, plan: readonly [number, number], height = 0): { x: number; y: number; depth: number } {
  return projectToPixel(cam, planToWorld(plan, height));
}
