import type { Dims } from '@flat/scene';

/**
 * The pure half of the maths of placing a loaded model in the item frame (no three): how a model's bounding box is
 * rotated to its front, scaled non-uniformly to the item's dims, and how much that distorts it. The viewer
 * (`packages/viewer/src/model-math.ts`, which adds the matrices) and the server's catalogue build
 * (`apps/server/src/providers/local/fit.ts`, which runs the same rules once, offline) share it, so they cannot drift.
 *
 * Frame: origin = footprint centre at the lowest point, +x right, +y up, +z front, dims `w` (x), `h` (y), `d` (z).
 */

export type Vec3 = [number, number, number];
export interface Box {
  min: Vec3;
  max: Vec3;
}
/** Source-model axis that is the front of the item. */
export type Front = '+z' | '-z' | '+x' | '-x';
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
export function scaleSizeToDims(size: readonly [number, number, number], dims: Dims): Vec3 {
  const pick = (target: number, native: number) => (native > 1e-9 ? target / native : 1);
  return [pick(dims.w, size[0]), pick(dims.h, size[1]), pick(dims.d, size[2])];
}

/**
 * Aspect distortion of a non-uniform scale: the largest relative deviation of an axis scale from their
 * geometric mean (0 = uniform; a model 20% too deep for its dims is about 0.13).
 */
export function scaleDistortion(scale: readonly number[]): number {
  const g = Math.cbrt(scale[0]! * scale[1]! * scale[2]!);
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
export function checkDims(kind: ModelKind, size: readonly [number, number, number], dims: Dims): DimsCheck {
  const distortion = scaleDistortion(scaleSizeToDims(size, dims));
  const limit = DIMS_MISMATCH_LIMIT[kind];
  return { distortion, limit, mismatch: distortion > limit };
}

/** An axis counts as "off" when the model's extent differs from the listed one by more than this fraction. */
export const AXIS_OFF_LIMIT = 0.15;

/**
 * True when the model (as authored, front +z) is clearly the wrong way round for the listed size: its x extent misses
 * the listed width AND its z extent misses the listed depth. A model that matches on ONE axis is authored the right way
 * (a bed whose headboard is wider than the frame, a desk with a return): a quarter turn would only make it worse.
 */
export function bothAxesOff(size: readonly [number, number, number], dims: Dims, limit = AXIS_OFF_LIMIT): boolean {
  const off = (native: number, listed: number) => !(listed > 1e-9) || Math.abs(native / listed - 1) > limit;
  return off(size[0], dims.w) && off(size[2], dims.d);
}
