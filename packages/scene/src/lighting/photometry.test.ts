import { describe, expect, it } from 'vitest';
import { areaNits, kelvinToLinearRgb, pointCandela, spotCandela } from './photometry';

describe('photometry', () => {
  it('pointCandela(1600) ~ 127.3', () => expect(pointCandela(1600)).toBeCloseTo(127.32, 1));
  it('spotCandela(600, 100) matches the formula', () => {
    const exact = 600 / (2 * Math.PI * (1 - Math.cos((50 * Math.PI) / 180)));
    expect(spotCandela(600, 100)).toBeCloseTo(exact, 9);
    expect(spotCandela(600, 100)).toBeCloseTo(267.3, 0);
  });
  it('areaNits(2500, 1.2, 0.3) ~ 2210', () => expect(areaNits(2500, 1.2, 0.3)).toBeCloseTo(2210, -1));
  it('0 lm gives 0', () => {
    expect(pointCandela(0)).toBe(0);
    expect(spotCandela(0, 60)).toBe(0);
    expect(areaNits(0, 1, 1)).toBe(0);
  });
  it('a 179 degree spot is finite and ~ lm/2pi-ish', () => {
    const v = spotCandela(1000, 179);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(1000 / (4 * Math.PI));
    expect(v).toBeLessThan(1000 / Math.PI);
  });
  it('rejects non-positive panel size', () => expect(() => areaNits(100, 0, 1)).toThrow(RangeError));
});

describe('kelvinToLinearRgb', () => {
  const lum = ([r, g, b]: number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  it('is normalised to Y = 1', () => {
    for (const k of [1000, 2700, 4000, 6500, 12000]) expect(lum(kelvinToLinearRgb(k))).toBeCloseTo(1, 9);
  });
  it('2700 K is warm', () => {
    const [r, g, b] = kelvinToLinearRgb(2700);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });
  it('6500 K is roughly neutral', () => {
    const c = kelvinToLinearRgb(6500);
    for (const v of c) expect(Math.abs(v - 1) / 1).toBeLessThan(0.05);
  });
  it('b/r grows monotonically from 1000 to 12000 K', () => {
    let prev = -1;
    for (let k = 1000; k <= 12000; k += 100) {
      const [r, , b] = kelvinToLinearRgb(k);
      expect(b / r).toBeGreaterThanOrEqual(prev);
      prev = b / r;
    }
  });
});
