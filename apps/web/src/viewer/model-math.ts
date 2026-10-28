import { Matrix4 } from 'three';

/**
 * Pure maths of placing a loaded model in the item frame (see `packages/assets/src/meshes/build-items.ts`):
 * origin = footprint centre at the lowest point, +x right, +y up, +z front, dims `w` (x), `h` (y), `d` (z).
 * A source model has its own axes (`front`) and an arbitrary pivot, so it is rotated until its front is +z,
 * moved so that the bottom centre of its bounding box is the origin, and scaled NON-uniformly to the item's dims.
 */

export type Vec3 = [number, number, number];
export interface Box {
  min: Vec3;
  max: Vec3;
}
/** Source-model axis that is the front of the item. */
export type Front = '+z' | '-z' | '+x' | '-x';
export interface Dims {
  w: number;
  d: number;
  h: number;
}
export type ModelKind = 'provider' | 'lookalike';

/** Aspect distortion above which a `dims_mismatch` warning is reported (relative; 0.10 = 10%). */
export const DIMS_MISMATCH_LIMIT: Record<ModelKind, number> = { provider: 0.1, lookalike: 0.25 };

/** Distortion above which a model is NOT used at all (the next source in the chain is): 50%. */
export const HARD_DIMS_LIMIT = 0.5;

/** Rotation about +y (radians, three.js convention) that turns the source model's front axis into +z. */
export function frontRotationY(front: Front): number {
  switch (front) {
    case '+z':
      return 0;
    case '-z':
      return Math.PI;
    case '+x':
      return -Math.PI / 2;
    case '-x':
      return Math.PI / 2;
  }
}

/** The box that bounds `box` after rotating it by `angle` about +y (exact: corners are rotated). */
export function rotateBoxY(box: Box, angle: number): Box {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const min: Vec3 = [Infinity, box.min[1], Infinity];
  const max: Vec3 = [-Infinity, box.max[1], -Infinity];
  for (const x of [box.min[0], box.max[0]]) {
    for (const z of [box.min[2], box.max[2]]) {
      const rx = x * c + z * s;
      const rz = -x * s + z * c;
      min[0] = Math.min(min[0], rx);
      max[0] = Math.max(max[0], rx);
      min[2] = Math.min(min[2], rz);
      max[2] = Math.max(max[2], rz);
    }
  }
  return { min, max };
}

export function boxSize(box: Box): Vec3 {
  return [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
}

/** Per-axis scale from a model of `size` (x, y, z) to `dims`; an axis the model has no extent on is left at 1. */
export function scaleToDims(size: Vec3, dims: Dims): Vec3 {
  const pick = (target: number, native: number) => (native > 1e-9 ? target / native : 1);
  return [pick(dims.w, size[0]), pick(dims.h, size[1]), pick(dims.d, size[2])];
}

/**
 * Aspect distortion of a non-uniform scale: the largest relative deviation of an axis scale from their
 * geometric mean (0 = uniform; a model 20% too deep for its dims is about 0.13).
 */
export function scaleDistortion(scale: Vec3): number {
  const g = Math.cbrt(scale[0] * scale[1] * scale[2]);
  if (!(g > 0)) return Infinity;
  return Math.max(...scale.map((s) => Math.abs(s / g - 1)));
}

export interface DimsCheck {
  distortion: number;
  limit: number;
  /** True when scaling to the item's dims distorts the model more than `limit`. */
  mismatch: boolean;
}

/** Whether a model of native `size` can be scaled to `dims` without too much distortion (10% provider, 25% lookalike). */
export function checkDims(kind: ModelKind, size: Vec3, dims: Dims): DimsCheck {
  const distortion = scaleDistortion(scaleToDims(size, dims));
  const limit = DIMS_MISMATCH_LIMIT[kind];
  return { distortion, limit, mismatch: distortion > limit };
}

export interface ItemPlacement {
  position: [number, number];
  elevation: number;
  rotation: number;
}

const rotY = new Matrix4();
const scaleM = new Matrix4();
const shift = new Matrix4();
const front = new Matrix4();
const place = new Matrix4();

/**
 * The matrix taking the source model's own coordinates to world space: front rotation, then auto-pivot
 * (bottom centre of the rotated bounding box to the origin), non-uniform scale to `dims`, then the item's
 * rotation (degrees counter-clockwise from above = three.js `rotation.y`) and position/elevation.
 */
export function itemMatrix(item: ItemPlacement, native: Box, frontAxis: Front, dims: Dims, out = new Matrix4()): Matrix4 {
  const angle = frontRotationY(frontAxis);
  const rotated = rotateBoxY(native, angle);
  const size = boxSize(rotated);
  const scale = scaleToDims(size, dims);
  const cx = (rotated.min[0] + rotated.max[0]) / 2;
  const cz = (rotated.min[2] + rotated.max[2]) / 2;
  front.makeRotationY(angle);
  shift.makeTranslation(-cx, -rotated.min[1], -cz);
  scaleM.makeScale(scale[0], scale[1], scale[2]);
  rotY.makeRotationY((item.rotation * Math.PI) / 180);
  place.makeTranslation(item.position[0], item.elevation, item.position[1]);
  return out.copy(place).multiply(rotY).multiply(scaleM).multiply(shift).multiply(front);
}

/** World-space box of `native` under `matrix` (all 8 corners). */
export function transformBox(native: Box, matrix: Matrix4): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const e = matrix.elements;
  for (const x of [native.min[0], native.max[0]]) {
    for (const y of [native.min[1], native.max[1]]) {
      for (const z of [native.min[2], native.max[2]]) {
        const p: Vec3 = [
          e[0]! * x + e[4]! * y + e[8]! * z + e[12]!,
          e[1]! * x + e[5]! * y + e[9]! * z + e[13]!,
          e[2]! * x + e[6]! * y + e[10]! * z + e[14]!,
        ];
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i]!, p[i]!);
          max[i] = Math.max(max[i]!, p[i]!);
        }
      }
    }
  }
  return { min, max };
}
