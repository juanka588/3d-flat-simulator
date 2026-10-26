import { describe, expect, it } from 'vitest';
import { FULL_PROFILE, LOW_PROFILE, perfProfileFor } from './perf';

describe('perfProfileFor', () => {
  it('keeps full quality on a desktop', () => {
    expect(perfProfileFor({ coarsePointer: false, cores: 8 })).toBe(FULL_PROFILE);
    expect(perfProfileFor({ coarsePointer: false, cores: 4 })).toBe(FULL_PROFILE);
    expect(perfProfileFor({ coarsePointer: false })).toBe(FULL_PROFILE);
  });
  it('lowers quality on touch devices and very weak machines', () => {
    expect(perfProfileFor({ coarsePointer: true, cores: 8 })).toBe(LOW_PROFILE);
    expect(perfProfileFor({ coarsePointer: false, cores: 2 })).toBe(LOW_PROFILE);
  });
  it('honours an explicit override', () => {
    expect(perfProfileFor({ coarsePointer: true, override: 'high' })).toBe(FULL_PROFILE);
    expect(perfProfileFor({ coarsePointer: false, cores: 16, override: 'low' })).toBe(LOW_PROFILE);
  });
  it('caps the pixel ratio of the low profile below the full one', () => {
    expect(LOW_PROFILE.maxDpr).toBeLessThan(FULL_PROFILE.maxDpr);
    expect(LOW_PROFILE.sunMap).toBeLessThan(FULL_PROFILE.sunMap);
  });
});
