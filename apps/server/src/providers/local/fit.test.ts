import { describe, expect, it } from 'vitest';
import { checkDims as viewerCheck } from '@flat/assets';
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

  describe('authored orientation first (a model that matches on one axis is the right way round)', () => {
    const BED = { w: 1.6, d: 2.02, h: 0.676 };
    const bedHint = { category: 'bed', typeName: 'Structure lit avec tête de lit' };

    it('keeps a bed whose headboard is wider than the frame unrotated and takes the overall dims from the model', () => {
      // MANDAL: 240 cm headboard, 205.6 deep, 83.5 high; listed frame 160 x 202
      const fit = chooseFit([2.4, 0.835, 2.056], BED, bedHint);
      expect(fit.quarterTurn).toBe(false);
      expect(fit.dims).toEqual({ w: 2.4, d: 2.056, h: 0.835 });
      expect(fit.dimsFrom).toBe('model');
      expect(fit.verdict).toBe('ok');
      expect(fit.size).toEqual([2.4, 0.835, 2.056]);
    });

    it('does not turn on a one-axis match even without a type hint (the viewer uses the same both-axes test)', () => {
      expect(chooseFit([2.4, 0.835, 2.056], BED).quarterTurn).toBe(false);
    });

    it('still turns a genuinely sideways model (wrong in both axes, fits once turned)', () => {
      const fit = chooseFit([2.02, 0.676, 1.6], BED, bedHint);
      expect(fit.quarterTurn).toBe(true);
      expect(fit.size).toEqual([1.6, 0.676, 2.02]);
      expect(fit.dims).toBeUndefined();
    });

    it('turns a sideways bed only for a near-exact fit', () => {
      expect(chooseFit([2.02 * 1.08, 0.7, 1.6 * 1.08], BED, bedHint).quarterTurn).toBe(false);
    });

    it('adopts the model dims only for plausible overhangs, only for types that may overhang, and not for shrunken models', () => {
      expect(chooseFit([1.6 * 1.18, 0.7, 2.02], BED, bedHint).dims).toBeUndefined(); // 18%: a loose model, kept and flagged
      expect(chooseFit([2.4, 0.835, 2.056], BED, { category: 'table' }).dims).toBeUndefined();
      expect(chooseFit([0.8, 0.676, 2.02], BED, bedHint).dims).toBeUndefined(); // smaller than listed
      expect(chooseFit([4.0, 0.835, 2.056], BED, bedHint).dims).toBeUndefined(); // 2.5x: not a headboard
    });

    it('swaps the listed width and depth of a desk instead of turning the model (the shop lists the length as depth)', () => {
      const fit = chooseFit([1.4, 0.735, 0.6], { w: 0.6, d: 1.4, h: 0.73 }, { category: 'desk', typeName: 'Bureau' });
      expect(fit.quarterTurn).toBe(false);
      expect(fit.dims).toEqual({ w: 1.4, d: 0.6, h: 0.73 });
      expect(fit.dimsFrom).toBe('swap');
      expect(fit.verdict).toBe('ok');
    });

    it('still turns a symmetric island (both axes off, no front to protect)', () => {
      expect(chooseFit([1.26, 0.9, 0.77], DIMS, { category: 'table' }).quarterTurn).toBe(true);
    });
  });
});
