import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { boxSize, checkDims, frontRotationY, itemMatrix, rotateBoxY, scaleDistortion, scaleToDims, transformBox } from './model-math';
import type { Box, Front } from './model-math';

// A 2 x 1 x 0.5 model whose pivot is far from where the item frame wants it.
const NATIVE: Box = { min: [10, 3, -4], max: [12, 4, -3.5] };
const DIMS = { w: 1.6, h: 0.8, d: 0.4 };

function worldBox(rotation: number, position: [number, number], elevation: number, front: Front = '+z', native = NATIVE, dims = DIMS): Box {
  return transformBox(native, itemMatrix({ position, elevation, rotation }, native, front, dims));
}

describe('item frame fit', () => {
  it('puts the bottom centre at the item position, scaled to the dims (rotation 0)', () => {
    const b = worldBox(0, [3, 4], 0);
    expect(b.min[0]).toBeCloseTo(3 - 0.8);
    expect(b.max[0]).toBeCloseTo(3 + 0.8);
    expect(b.min[1]).toBeCloseTo(0);
    expect(b.max[1]).toBeCloseTo(0.8);
    expect(b.min[2]).toBeCloseTo(4 - 0.2);
    expect(b.max[2]).toBeCloseTo(4 + 0.2);
  });

  it('lifts the bottom to the item elevation', () => {
    const b = worldBox(0, [0, 0], 1.2);
    expect(b.min[1]).toBeCloseTo(1.2);
    expect(b.max[1]).toBeCloseTo(2.0);
  });

  it('rotates about the item origin: 90 degrees swaps the footprint extents', () => {
    const b = worldBox(90, [1, 2], 0);
    expect(boxSize(b)[0]).toBeCloseTo(0.4);
    expect(boxSize(b)[2]).toBeCloseTo(1.6);
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(1);
    expect((b.min[2] + b.max[2]) / 2).toBeCloseTo(2);
  });

  it('turns local +z (the front) towards plan [sin r, cos r]', () => {
    const unit: Box = { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] };
    const plate: Box = { min: [-0.5, 0, 0.4], max: [0.5, 1, 0.5] }; // the front plate of a model facing +z
    for (const [rotation, dir] of [[0, [0, 1]], [90, [1, 0]], [180, [0, -1]], [270, [-1, 0]]] as const) {
      const m = itemMatrix({ position: [0, 0], elevation: 0, rotation }, unit, '+z', { w: 1, h: 1, d: 1 });
      const b = transformBox(plate, m);
      expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(dir[0] * 0.45, 5);
      expect((b.min[2] + b.max[2]) / 2).toBeCloseTo(dir[1] * 0.45, 5);
    }
  });

  it('a model whose front is -x puts its front plate on item +z', () => {
    const unit: Box = { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] };
    const plate: Box = { min: [-0.5, 0, -0.5], max: [-0.4, 1, 0.5] }; // front on -x
    const b = transformBox(plate, itemMatrix({ position: [0, 0], elevation: 0, rotation: 0 }, unit, '-x', { w: 1, h: 1, d: 1 }));
    expect((b.min[2] + b.max[2]) / 2).toBeCloseTo(0.45, 5);
  });

  it.each<[Front, number]>([
    ['+z', 0],
    ['-z', Math.PI],
    ['+x', -Math.PI / 2],
    ['-x', Math.PI / 2],
  ])('front axis %s is rotated onto +z', (front, angle) => {
    expect(frontRotationY(front)).toBeCloseTo(angle);
    const axis = { '+z': [0, 0, 1], '-z': [0, 0, -1], '+x': [1, 0, 0], '-x': [-1, 0, 0] }[front];
    const m = new Matrix4().makeRotationY(angle);
    const v = [axis[0]! * m.elements[0]! + axis[2]! * m.elements[8]!, axis[0]! * m.elements[2]! + axis[2]! * m.elements[10]!];
    expect(v[0]).toBeCloseTo(0);
    expect(v[1]).toBeCloseTo(1);
  });

  it('a model facing +x with its length along x ends up with that length along the item depth', () => {
    // 1 (x) by 0.4 (z) model facing +x: after the fit the 1 m side is the depth (z).
    const native: Box = { min: [0, 0, 0], max: [1, 1, 0.4] };
    const b = worldBox(0, [0, 0], 0, '+x', native, { w: 0.4, h: 1, d: 1 });
    expect(boxSize(b)[0]).toBeCloseTo(0.4);
    expect(boxSize(b)[2]).toBeCloseTo(1);
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(0);
  });

  it('rotateBoxY keeps the height and swaps extents at 90 degrees', () => {
    const r = rotateBoxY({ min: [0, 1, 0], max: [2, 3, 1] }, Math.PI / 2);
    expect(boxSize(r)[0]).toBeCloseTo(1);
    expect(boxSize(r)[1]).toBeCloseTo(2);
    expect(boxSize(r)[2]).toBeCloseTo(2);
  });

  it('is exact for every rotation and front combination: the world box has the item dims', () => {
    for (const front of ['+z', '-z', '+x', '-x'] as Front[]) {
      for (const rotation of [0, 30, 90, 180, 270]) {
        const b = worldBox(rotation, [2, -1], 0.5, front);
        const size = boxSize(b);
        const quarter = rotation % 180 === 90;
        // axis-aligned only for multiples of 90; footprint volume and height must always match.
        expect(size[1]).toBeCloseTo(DIMS.h);
        if (rotation % 90 === 0) {
          const swap = quarter;
          expect(size[0]).toBeCloseTo(swap ? DIMS.d : DIMS.w);
          expect(size[2]).toBeCloseTo(swap ? DIMS.w : DIMS.d);
        }
        expect(b.min[1]).toBeCloseTo(0.5);
      }
    }
  });
});

describe('distortion and dims_mismatch thresholds', () => {
  it('scaleToDims maps (x, y, z) extents to (w, h, d); a flat axis stays 1', () => {
    expect(scaleToDims([2, 1, 0.5], DIMS)).toEqual([0.8, 0.8, 0.8]);
    expect(scaleToDims([2, 0, 0.5], DIMS)[1]).toBe(1);
  });

  it('a uniform scale has no distortion', () => {
    expect(scaleDistortion([0.8, 0.8, 0.8])).toBeCloseTo(0);
  });

  it('flags a provider model whose aspect is off by more than 10% and accepts one within', () => {
    const dims = { w: 2, h: 1, d: 1 };
    expect(checkDims('provider', [2, 1, 1], dims).mismatch).toBe(false);
    expect(checkDims('provider', [2, 1, 1.05], dims).mismatch).toBe(false); // ~3% off
    expect(checkDims('provider', [2, 1, 1.3], dims).mismatch).toBe(true); // ~30% too deep
    const edge = checkDims('provider', [2, 1, 1.25], dims);
    expect(edge.distortion).toBeGreaterThan(0.1);
    expect(edge.limit).toBe(0.1);
  });

  it('uses 25% for lookalikes: the same model passes as a lookalike and fails as a provider model', () => {
    const dims = { w: 2, h: 1, d: 1 };
    const size: [number, number, number] = [2, 1, 1.2]; // distortion ~ 0.12
    expect(checkDims('provider', size, dims).mismatch).toBe(true);
    expect(checkDims('lookalike', size, dims).mismatch).toBe(false);
    expect(checkDims('lookalike', [2, 1, 1.6], dims).mismatch).toBe(true);
    expect(checkDims('lookalike', [2, 1, 1.6], dims).limit).toBe(0.25);
  });
});
