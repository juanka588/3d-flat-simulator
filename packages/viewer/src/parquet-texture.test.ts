import { describe, expect, it } from 'vitest';
import { chevronTile, herringboneTile, parquetTile, tilePixelsPerMetre, MAX_TILE_PX, type ParquetTile } from './parquet-texture';

function inside(poly: [number, number][], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** How many planks cover each of a grid of points inside the tile (every point must be covered exactly once). */
function coverage(tile: ParquetTile, steps = 60): number[] {
  const out: number[] = [];
  for (let a = 0; a < steps; a++) {
    for (let b = 0; b < steps; b++) {
      const x = ((a + 0.37) / steps) * tile.widthM;
      const y = ((b + 0.61) / steps) * tile.heightM;
      out.push(tile.planks.filter((p) => inside(p.points, x, y)).length);
    }
  }
  return out;
}

describe('parquet tiles', () => {
  it('herringbone covers the tile exactly once with 7:1 planks and repeats seamlessly', () => {
    const tile = herringboneTile(0.09);
    expect(tile.widthM).toBeCloseTo(28 * 0.09);
    expect(coverage(tile).every((c) => c === 1)).toBe(true);
    // 28 * 28 / 7 = 112 planks in the tile, those crossing its edge are drawn wrapped
    const inTile = tile.planks.filter((p) => p.points.every(([x, y]) => x >= -1e-9 && y >= -1e-9 && x <= tile.widthM + 1e-9 && y <= tile.heightM + 1e-9));
    expect(inTile.length).toBeGreaterThanOrEqual(80);
    for (const p of tile.planks) {
      const xs = p.points.map((q) => q[0]);
      const ys = p.points.map((q) => q[1]);
      const sides = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)].sort((a, b) => a - b);
      expect(sides[0]).toBeCloseTo(0.09);
      expect(sides[1]).toBeCloseTo(0.63);
    }
  });

  it('chevron covers the tile exactly once; planks are 45 degree parallelograms of the plank width', () => {
    const tile = chevronTile(0.09);
    expect(coverage(tile).every((c) => c === 1)).toBe(true);
    const half = (0.09 * 7) / Math.SQRT2;
    expect(tile.widthM).toBeCloseTo(4 * half);
    expect(tile.heightM).toBeCloseTo(8 * 0.09 * Math.SQRT2);
    for (const p of tile.planks) {
      const [a, b, , d] = p.points as [[number, number], [number, number], [number, number], [number, number]];
      // long edge a-b runs at 45 degrees; the end d-a is vertical
      expect(Math.abs(Math.abs(b[1] - a[1]) - Math.abs(b[0] - a[0]))).toBeLessThan(1e-9);
      expect(d[0]).toBeCloseTo(a[0]);
    }
  });

  it('a different width scales the tile; the canvas stays within the limit', () => {
    expect(parquetTile({ pattern: 'herringbone', plankWidthM: 0.14 }).widthM).toBeCloseTo(28 * 0.14);
    for (const w of [0.04, 0.09, 0.25]) {
      for (const pattern of ['herringbone', 'chevron'] as const) {
        const tile = parquetTile({ pattern, plankWidthM: w });
        expect(Math.max(tile.widthM, tile.heightM) * tilePixelsPerMetre(tile)).toBeLessThanOrEqual(MAX_TILE_PX + 1e-6);
      }
    }
  });

  it('shades are deterministic and vary', () => {
    const a = herringboneTile(0.09).planks.map((p) => p.shade);
    expect(herringboneTile(0.09).planks.map((p) => p.shade)).toEqual(a);
    expect(new Set(a.map((s) => s.toFixed(3))).size).toBeGreaterThan(20);
    expect(a.every((s) => s >= 0.88 && s <= 1.12)).toBe(true);
  });
});
