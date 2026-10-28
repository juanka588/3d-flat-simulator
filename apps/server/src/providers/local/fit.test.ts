import { describe, expect, it } from 'vitest';
import { checkDims as viewerCheck } from '../../../../web/src/viewer/model-math';
import { CATALOG_REJECT_LIMIT, DIMS_MISMATCH_LIMIT, QUARTER_TURN_MARGIN, chooseFit, distortionOf } from './fit';

const DIMS = { w: 0.77, d: 1.26, h: 0.9 };

describe('fit rules (the viewer\'s own, run at build time)', () => {
  it('agrees with the viewer\'s distortion maths and thresholds', () => {
    for (const size of [[0.77, 0.9, 1.26], [1.26, 0.9, 0.77], [1, 1, 1], [0.5, 2, 0.3], [2.1, 0.8, 0.9]] as const) {
      const viewer = viewerCheck('provider', [size[0], size[1], size[2]], DIMS);
      expect(distortionOf(size, DIMS)).toBeCloseTo(viewer.distortion, 12);
      expect(DIMS_MISMATCH_LIMIT).toBe(viewer.limit);
    }
  });

  it('keeps a model that fits, with no quarter turn', () => {
    const fit = chooseFit([0.77, 0.9, 1.26], DIMS);
    expect(fit).toMatchObject({ quarterTurn: false, verdict: 'ok', size: [0.77, 0.9, 1.26] });
    expect(fit.distortion).toBeLessThan(0.001);
  });

  it('turns a quarter when the long side runs the other way (IKEA lists an island 77 wide, its model is 126 along x)', () => {
    const fit = chooseFit([1.26, 0.9, 0.77], DIMS);
    expect(fit.quarterTurn).toBe(true);
    expect(fit.size).toEqual([0.77, 0.9, 1.26]);
    expect(fit.verdict).toBe('ok');
  });

  it('does not turn for a marginal gain (the viewer needs 5 points)', () => {
    const size: [number, number, number] = [1.05, 0.9, 1.0];
    const asIs = distortionOf(size, DIMS);
    const turned = distortionOf([size[2], size[1], size[0]], DIMS);
    expect(asIs - turned).toBeLessThan(QUARTER_TURN_MARGIN + 0.3);
    expect(chooseFit([1.0, 0.9, 1.0], { w: 1, d: 1, h: 0.9 }).quarterTurn).toBe(false);
  });

  it('warns between 10 and 25% and rejects above 25% (stricter than the viewer\'s 50%)', () => {
    expect(chooseFit([0.77 * 1.3, 0.9, 1.26], DIMS).verdict).toBe('warn');
    const bad = chooseFit([0.77, 0.9, 1.26 * 1.9], DIMS);
    expect(bad.distortion).toBeGreaterThan(CATALOG_REJECT_LIMIT);
    expect(bad).toMatchObject({ verdict: 'reject' });
    expect(bad.reason).toMatch(/do not match the listed size/);
  });

  it('explains a model lying on its side', () => {
    // listed as a 0.4 x 0.4 x 1.8 tall thing; the model is 1.8 along x
    const fit = chooseFit([1.8, 0.4, 0.4], { w: 0.4, d: 0.4, h: 1.8 });
    expect(fit.verdict).toBe('reject');
    expect(fit.betterAxes).toBeDefined();
    expect(fit.reason).toMatch(/lies on its side/);
  });
});
