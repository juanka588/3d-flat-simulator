import { boxSize, frontRotationY, rotateBoxY, scaleSizeToDims as scaleToDims } from '@flat/assets';
import type { Box, Front, Vec3 } from '@flat/assets';
import { Matrix4 } from 'three';

/**
 * Maths of placing a loaded model in the item frame (see `packages/assets/src/meshes/build-items.ts`):
 * origin = footprint centre at the lowest point, +x right, +y up, +z front, dims `w` (x), `h` (y), `d` (z).
 * A source model has its own axes (`front`) and an arbitrary pivot, so it is rotated until its front is +z,
 * moved so that the bottom centre of its bounding box is the origin, and scaled NON-uniformly to the item's dims.
 */

export type { Box, DimsCheck, Front, ModelKind, Vec3 } from '@flat/assets';
export { DIMS_MISMATCH_LIMIT, HARD_DIMS_LIMIT, bothAxesOff, boxSize, checkDims, frontRotationY, rotateBoxY, scaleDistortion } from '@flat/assets';
export { scaleSizeToDims as scaleToDims } from '@flat/assets';
export interface Dims {
  w: number;
  d: number;
  h: number;
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
