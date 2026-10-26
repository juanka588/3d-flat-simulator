import { describe, expect, it } from 'vitest';
import { SUN_SHADOW_BIAS_M, sunShadowBias } from './sun-shadow';

describe('sunShadowBias', () => {
  const fit = (range: number) => ({ left: -8, right: 8, top: 5, bottom: -5, near: 0.1, far: 0.1 + range });

  it('is a constant number of metres whatever the depth range', () => {
    for (const range of [10, 60, 436]) {
      const { bias } = sunShadowBias(fit(range), 2048);
      expect(-bias * range).toBeCloseTo(SUN_SHADOW_BIAS_M, 9);
    }
  });

  it('offsets along the normal by a couple of texels', () => {
    const { normalBias } = sunShadowBias(fit(40), 2048);
    expect(normalBias).toBeCloseTo((2 * 16) / 2048, 9);
  });
});
