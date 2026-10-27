import { describe, expect, it } from 'vitest';
import { BLANK_LIMITS, analyzeThumb, describeBlank } from './blank';

/** Fast: the blank-capture decision on synthetic thumbnails. */

function image(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      out.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return out;
}
const verdict = (rgba: ArrayLike<number>) => describeBlank(analyzeThumb(rgba));

describe('blank capture detection', () => {
  it('a single flat colour is blank: sky grey, black, white', () => {
    for (const c of [[232, 235, 240], [0, 0, 0], [255, 255, 255]] as [number, number, number][]) {
      const stats = analyzeThumb(image(64, 48, () => c));
      expect(stats.stddev).toBeCloseTo(0, 3);
      expect(stats.colors).toBe(1);
      expect(describeBlank(stats)).toMatch(/single flat colour/);
    }
  });

  it('an empty buffer is blank', () => {
    expect(describeBlank(analyzeThumb(new Uint8ClampedArray(0)))).toMatch(/no pixels/);
  });

  it('a sky with a tiny speck of sensor noise is still blank', () => {
    const rgba = image(100, 100, (x, y) => (x === 0 && y === 0 ? [233, 235, 240] : [232, 235, 240]));
    expect(verdict(rgba)).toBeDefined();
  });

  it('a background with a very small (under 0.5%) multi-coloured patch is almost blank', () => {
    const patch = (x: number, y: number): [number, number, number] => (x < 8 && y < 8 ? [x * 30, y * 30, 60] : [232, 235, 240]);
    const stats = analyzeThumb(image(200, 100, patch));
    expect(stats.colors).toBeGreaterThanOrEqual(BLANK_LIMITS.minColors);
    expect(stats.topShare).toBeGreaterThan(BLANK_LIMITS.maxTopShare);
    expect(describeBlank(stats)).toMatch(/almost entirely one colour/);
  });

  it('a picture of a flat is not blank: floor, walls and sky in several tones', () => {
    const rgba = image(128, 96, (x, y) => {
      if (y < 30) return [232, 235, 240]; // sky
      if (x < 40) return [150 + (y % 20), 120, 90]; // wall
      if (x < 90) return [110, 130 + (x % 30), 100]; // sage wall
      return [90 + (y % 40), 70, 50 + (x % 25)]; // floor
    });
    const stats = analyzeThumb(rgba);
    expect(stats.colors).toBeGreaterThan(BLANK_LIMITS.minColors);
    expect(stats.stddev).toBeGreaterThan(10);
    expect(describeBlank(stats)).toBeUndefined();
  });

  it('a dark night render with lit patches is not blank, a pure black one is', () => {
    const night = image(128, 96, (x, y) => ((x + y) % 17 === 0 ? [180, 120, 60] : [(x % 6) * 12, 8 + (y % 5) * 9, 12 + (x % 4) * 10]));
    expect(verdict(night)).toBeUndefined();
    expect(verdict(image(128, 96, () => [0, 0, 0]))).toBeDefined();
  });

  it('few colours but real contrast (two flat regions) still counts as a picture only above the colour floor', () => {
    const two = image(64, 48, (x) => (x < 32 ? [20, 20, 20] : [220, 220, 220]));
    expect(analyzeThumb(two).colors).toBe(2);
    expect(describeBlank(analyzeThumb(two))).toMatch(/too few colours/); // two colours is not a render of a flat
  });
});
