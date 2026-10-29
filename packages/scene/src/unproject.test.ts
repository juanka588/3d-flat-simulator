import { describe, expect, it } from 'vitest';
import { cameraFromMatrixWorld, intrinsicsOf, pixelToPlan, planToPixel, projectToPixel, unprojectPixel, type PinholeCamera } from './unproject';

/** A camera looking from `from` to `to`, built the way three's lookAt does. */
function lookAt(from: [number, number, number], to: [number, number, number]): PinholeCamera {
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]!);
  const norm = (a: number[]) => a.map((v) => v / Math.hypot(...a));
  const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const forward = norm(sub(to, from));
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  return { position: from, right: right as never, up: up as never, forward: forward as never, fovDeg: 75, width: 1024, height: 768 };
}

describe('unproject', () => {
  const cam = lookAt([3, 1.5, 4], [1, 1, -2]);

  it('the principal point at depth d is d metres along the optical axis', () => {
    const p = unprojectPixel(cam, 512, 384, 2);
    expect(p[0]).toBeCloseTo(3 + cam.forward[0] * 2, 9);
    expect(p[1]).toBeCloseTo(1.5 + cam.forward[1] * 2, 9);
    expect(p[2]).toBeCloseTo(4 + cam.forward[2] * 2, 9);
  });

  it('round-trips pixel + depth -> world -> pixel + depth within 1 cm', () => {
    for (const [x, y, d] of [[0.5, 0.5, 1], [1023.5, 767.5, 6], [100.25, 600.75, 3.3], [512, 384, 0.4], [900, 20, 9.9]] as const) {
      const w = unprojectPixel(cam, x, y, d);
      const back = projectToPixel(cam, w);
      expect(back.depth).toBeCloseTo(d, 2);
      expect(Math.abs(back.x - x)).toBeLessThan(0.01);
      expect(Math.abs(back.y - y)).toBeLessThan(0.01);
      const again = unprojectPixel(cam, back.x, back.y, back.depth);
      expect(Math.hypot(again[0] - w[0], again[1] - w[1], again[2] - w[2])).toBeLessThan(0.01);
    }
  });

  it('round-trips world points through pixels', () => {
    for (const w of [[1, 0, 0], [0, 2.4, -3], [4.2, 0.1, 1.5]] as const) {
      const px = projectToPixel(cam, [...w]);
      const back = unprojectPixel(cam, px.x, px.y, px.depth);
      expect(Math.hypot(back[0] - w[0], back[1] - w[1], back[2] - w[2])).toBeLessThan(0.01);
    }
  });

  it('plan coordinates are (x, z) and the inverse recovers the plan point', () => {
    const plan: [number, number] = [0.5, -1.25];
    const px = planToPixel(cam, plan, 0);
    const back = pixelToPlan(cam, px.x, px.y, px.depth);
    expect(Math.hypot(back.plan[0] - plan[0], back.plan[1] - plan[1])).toBeLessThan(0.01);
    expect(Math.abs(back.height)).toBeLessThan(0.01);
  });

  it('intrinsics follow the vertical field of view', () => {
    const k = intrinsicsOf({ fovDeg: 90, width: 200, height: 100 });
    expect(k.fy).toBeCloseTo(50, 9);
    expect(k.cx).toBe(100);
    expect(k.cy).toBe(50);
  });

  it('reads the basis from a column-major camera matrix (identity looks down -Z)', () => {
    const c = cameraFromMatrixWorld([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1], 60, 640, 480);
    expect(c.position).toEqual([5, 6, 7]);
    const p = unprojectPixel(c, 320, 240, 2);
    expect(p[0]).toBeCloseTo(5, 9);
    expect(p[1]).toBeCloseTo(6, 9);
    expect(p[2]).toBeCloseTo(5, 9);
  });
});
