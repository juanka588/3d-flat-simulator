import { describe, expect, it } from 'vitest';
import { fitSunShadow } from './sun-fit';
import type { V3 } from './sun-fit';

const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): V3[] => {
  const out: V3[] = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) out.push([x, y, z]);
  return out;
};

describe('fitSunShadow', () => {
  const flat = box(0, 10, 0, 2.5, 0, 8);

  it('returns null without receivers', () => {
    expect(fitSunShadow([0, 1, 0], [], [])).toBeNull();
  });

  it('fits a vertical sun to the plan footprint', () => {
    const fit = fitSunShadow([0, 1, 0], flat, flat, 0.5)!;
    const width = Math.max(fit.right - fit.left, fit.top - fit.bottom);
    const height = Math.min(fit.right - fit.left, fit.top - fit.bottom);
    expect(width).toBeCloseTo(10 + 1, 5);
    expect(height).toBeCloseTo(8 + 1, 5);
    expect(fit.up).toEqual([0, 0, -1]); // +Y up would be degenerate for a vertical light
  });

  it('puts the light on the sun side and covers casters between sun and receivers in depth', () => {
    const dir: V3 = [0.5, 0.6, 0.62];
    const tower = box(-20, -15, 0, 30, 3, 6); // a taller building towards the sun
    const fit = fitSunShadow(dir, flat, [...flat, ...tower])!;
    const len = Math.hypot(...dir);
    const toLight = [fit.position[0] - fit.target[0], fit.position[1] - fit.target[1], fit.position[2] - fit.target[2]];
    expect(toLight[0]! / Math.hypot(...toLight)).toBeCloseTo(dir[0] / len, 5);
    expect(fit.near).toBeGreaterThan(0);
    // Every caster lies between the near and far planes along the light direction.
    const unit = dir.map((c) => c / len) as V3;
    for (const p of [...flat, ...tower]) {
      const depth = -((p[0] - fit.position[0]) * unit[0] + (p[1] - fit.position[1]) * unit[1] + (p[2] - fit.position[2]) * unit[2]);
      expect(depth).toBeGreaterThanOrEqual(fit.near - 1e-6);
      expect(depth).toBeLessThanOrEqual(fit.far + 1e-6);
    }
  });

  it('does not widen the frustum for casters, only for receivers', () => {
    const far = box(100, 120, 0, 10, 100, 120);
    const a = fitSunShadow([0.3, 0.8, 0.5], flat, flat)!;
    const b = fitSunShadow([0.3, 0.8, 0.5], flat, [...flat, ...far])!;
    expect(b.right - b.left).toBeCloseTo(a.right - a.left, 9);
    expect(b.top - b.bottom).toBeCloseTo(a.top - a.bottom, 9);
    expect(b.far).toBeGreaterThan(a.far);
  });
});
