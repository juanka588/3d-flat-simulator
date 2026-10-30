import { describe, expect, it } from 'vitest';
import { FULL_PROFILE, LOW_PROFILE, perfProfileFor, RESERVED_TEXTURE_UNITS, shadowLampBudget, weakGpu } from './perf';
import { supportsProbes } from './gl-caps';
import type { GlCaps } from './gl-caps';

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

const caps = (over: Partial<GlCaps>): GlCaps => ({ webgl2: true, renderer: 'x', vendor: 'x', software: false, mobileGpu: false, floatRender: true, halfFloatRender: true, floatLinear: true, maxTextures: 16, maxVertexTextures: 16, maxTextureSize: 16384, max3dTextureSize: 2048, maxFragmentUniformVectors: 1024, maxVertexUniformVectors: 1024, maxVaryingVectors: 30, maxSamples: 4, extensions: [], ...over });

describe('GPU capability gates', () => {
  it('probes need float rendering AND float linear filtering (Mali has no float32 linear: the atlas reads black)', () => {
    expect(supportsProbes(caps({}))).toBe(true);
    expect(supportsProbes(caps({ floatLinear: false }))).toBe(false);
    expect(supportsProbes(caps({ floatRender: false }))).toBe(false);
    expect(supportsProbes(caps({ webgl2: false }))).toBe(false);
  });
  it('a phone GPU or a small-texture device gets the low tier whatever the pointer says', () => {
    expect(weakGpu(caps({ mobileGpu: true }))).toBe(true);
    expect(weakGpu(caps({ maxTextureSize: 4096 }))).toBe(true);
    expect(weakGpu(caps({ maxTextures: 8 }))).toBe(true);
    expect(weakGpu(caps({}))).toBe(false);
    expect(weakGpu(null)).toBe(false);
    expect(perfProfileFor({ coarsePointer: false, cores: 8, weakGpu: true })).toBe(LOW_PROFILE);
  });
});
