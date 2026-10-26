import { describe, expect, it } from 'vitest';
import { polygonArea, polygonCentroid, sceneBounds } from './measure';

describe('measure', () => {
  it('computes polygon area regardless of winding', () => {
    const square: [number, number][] = [[0, 0], [2, 0], [2, 3], [0, 3]];
    expect(polygonArea(square)).toBe(6);
    expect(polygonArea([...square].reverse())).toBe(6);
  });

  it('handles L-shaped rooms', () => {
    const l: [number, number][] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
    expect(polygonArea(l)).toBe(12);
  });

  it('computes centroid and bounds', () => {
    expect(polygonCentroid([[0, 0], [2, 0], [2, 2], [0, 2]])).toEqual([1, 1]);
    expect(
      sceneBounds({ walls: [{ start: [1, 2], end: [5, 2] }, { start: [5, 2], end: [5, 7] }] as never }),
    ).toEqual({ min: [1, 2], max: [5, 7] });
  });
});
