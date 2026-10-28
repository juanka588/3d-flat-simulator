import { describe, expect, it } from 'vitest';
import { BUILTIN_ASSETS, TV_55_DIAGONAL_M } from './builtin-assets';
import { itemBlocksWalking, itemFrontDirection } from './item-helpers';

describe('builtin:tv-55', () => {
  const tv = BUILTIN_ASSETS['builtin:tv-55']!;

  it('is a 55 inch 16:9 panel (diagonal 1.397 m within 1 cm) with a thin bezel', () => {
    expect(TV_55_DIAGONAL_M).toBeCloseTo(1.397, 3);
    expect(tv).toMatchObject({ category: 'electronics', mount: 'wall' });
    expect(tv.dims.w).toBeCloseTo(1.23, 2);
    expect(tv.dims.h).toBeCloseTo(0.71, 2);
    expect(tv.dims.d).toBeCloseTo(0.05, 3);
    const panelW = tv.dims.w - 0.012;
    const panelH = tv.dims.h - 0.025;
    expect(Math.abs(Math.hypot(panelW, panelH) - 1.397)).toBeLessThan(0.01);
    expect(panelW / panelH).toBeCloseTo(16 / 9, 2);
  });

  it('front direction follows rotation CCW from above (rotation 0 faces plan +y)', () => {
    const f = (rotation: number) => itemFrontDirection({ rotation }).map((v) => Math.round(v * 1e6) / 1e6 + 0);
    expect(f(0)).toEqual([0, 1]);
    expect(f(90)).toEqual([1, 0]);
    expect(f(180)).toEqual([0, -1]);
    expect(f(270)).toEqual([-1, 0]);
  });

  it('wall-mounted items above 0.6 m do not block walking', () => {
    expect(itemBlocksWalking({ assetId: 'builtin:tv-55', elevation: 0.745 })).toBe(false);
    expect(itemBlocksWalking({ assetId: 'builtin:tv-55', elevation: 0.3 })).toBe(true);
    expect(itemBlocksWalking({ assetId: 'nope', elevation: 1 })).toBe(true);
  });
});
