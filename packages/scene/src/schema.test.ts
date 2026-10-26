import { describe, expect, it } from 'vitest';
import { wallLeftNormal } from './schema';

describe('wallLeftNormal', () => {
  it('points up the page (-y) for a wall drawn left to right', () => {
    const [nx, ny] = wallLeftNormal({ start: [0, 0], end: [4, 0] });
    expect(nx).toBeCloseTo(0);
    expect(ny).toBe(-1);
  });

  it('points to +x for a wall drawn bottom to top of the page', () => {
    expect(wallLeftNormal({ start: [0, 5], end: [0, 0] })).toEqual([-1, -0]);
  });
});
