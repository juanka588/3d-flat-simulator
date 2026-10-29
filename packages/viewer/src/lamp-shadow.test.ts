import { describe, expect, it } from 'vitest';
import { LAMP_SHADOW_BIAS, LAMP_SHADOW_BIAS_M, LAMP_SHADOW_FAR, LAMP_SHADOW_NEAR, LAMP_SHADOW_REF_DISTANCE_M, perspectiveDepthBias } from './lamp-shadow';

/** Perspective depth in [0, 1] of a point at distance d along the view axis. */
const depth = (d: number, n = LAMP_SHADOW_NEAR, f = LAMP_SHADOW_FAR) => (f * (d - n)) / (d * (f - n));

describe('lamp shadow bias', () => {
  it('is negative (towards the light) and corresponds to the requested metres at the reference distance', () => {
    expect(LAMP_SHADOW_BIAS).toBeLessThan(0);
    const d = LAMP_SHADOW_REF_DISTANCE_M;
    // Moving the receiver by the bias in metres changes the stored perspective depth by about |bias| (first order).
    const shifted = depth(d + LAMP_SHADOW_BIAS_M) - depth(d);
    expect(Math.abs(LAMP_SHADOW_BIAS)).toBeCloseTo(shifted, 4);
  });

  it('shrinks with the square of the distance for the same number of metres', () => {
    expect(Math.abs(perspectiveDepthBias(0.02, 6))).toBeCloseTo(Math.abs(perspectiveDepthBias(0.02, 3)) / 4, 8);
  });
});
