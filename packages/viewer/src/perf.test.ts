import { describe, expect, it } from 'vitest';
import { FULL_PROFILE, LOW_PROFILE, perfProfileFor, RESERVED_TEXTURE_UNITS, shadowLampBudget } from './perf';

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

describe('shadowLampBudget', () => {
  it('leaves the texture units the materials and the sun need on a 16-unit GPU', () => {
    expect(shadowLampBudget(FULL_PROFILE, 16)).toBe(16 - RESERVED_TEXTURE_UNITS);
    expect(shadowLampBudget(FULL_PROFILE, 16)).toBe(7); // a streamed glTF material can use 8 units itself (see RESERVED_TEXTURE_UNITS)
  });
  it('is capped by the profile on big GPUs and never below 2', () => {
    expect(shadowLampBudget(FULL_PROFILE, 32)).toBe(FULL_PROFILE.maxShadowLamps);
    expect(shadowLampBudget(LOW_PROFILE, 32)).toBe(LOW_PROFILE.maxShadowLamps);
    expect(shadowLampBudget(LOW_PROFILE, 16)).toBeLessThan(shadowLampBudget(FULL_PROFILE, 16));
    expect(shadowLampBudget(FULL_PROFILE, 8)).toBe(2);
  });
});
