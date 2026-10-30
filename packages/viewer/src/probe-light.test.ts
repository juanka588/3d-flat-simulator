import { describe, expect, it } from 'vitest';
import { PROBE_CHUNK } from './probe-shader';
import { PROBE_ENV_SHARE, PROBE_SKY_FILL, bakeSky, probeAmbientSplit, skyLitRadiance } from './probe-light';
import { luminance } from './lighting';
import { perfProfileFor, FULL_PROFILE, LOW_PROFILE, RESERVED_TEXTURE_UNITS, shadowLampBudget } from './perf';

describe('bakeSky', () => {
  it('never produces NaN or Inf from non-finite lighting inputs', () => {
    const sky = bakeSky({ zenith: [Number.NaN, 0.2, 0.3], horizon: [0.5, Number.POSITIVE_INFINITY, 0.5], ambientIntensity: Number.NaN, sunIntensity: Number.NaN, sunAltitudeDeg: Number.NaN, gain: 10 });
    for (const v of [...sky.zenith, ...sky.horizon, ...sky.ground]) expect(Number.isFinite(v)).toBe(true);
  });
  const input = { zenith: [0.2, 0.35, 0.8] as [number, number, number], horizon: [0.6, 0.7, 0.9] as [number, number, number], ambientIntensity: 4000, sunIntensity: 9000, sunAltitudeDeg: 55 };
  it('lights an open horizontal surface with exactly the ambient illuminance (gain 1)', () => {
    const sky = bakeSky({ ...input, gain: 1 });
    // E = 2 pi integral L(h) h dh with L = lumH + (lumZ - lumH) sqrt(h) in luminance terms.
    const lumZ = luminance(sky.zenith);
    const lumH = luminance(sky.horizon);
    const E = 2 * Math.PI * (lumH / 2 + 0.4 * (lumZ - lumH));
    expect(E).toBeCloseTo(input.ambientIntensity, 0);
  });
  it('scales with the gain, and lights the ground by sun and sky', () => {
    const one = bakeSky({ ...input, gain: 1 });
    const six = bakeSky({ ...input, gain: 6 });
    expect(luminance(six.zenith) / luminance(one.zenith)).toBeCloseTo(6, 5);
    expect(six.ground).toEqual(one.ground);
    const night = bakeSky({ ...input, ambientIntensity: 0, sunIntensity: 0, sunAltitudeDeg: -20 });
    expect(night.zenith).toEqual([0, 0, 0]);
    expect(night.ground[0]).toBe(0);
  });
  it('sky-lit surfaces give off albedo x E / pi', () => {
    expect(skyLitRadiance(0.5, Math.PI * 100)).toBeCloseTo(50);
    expect(skyLitRadiance(0.5, Math.PI * 100, 0.5)).toBeCloseTo(25);
  });
});

describe('ambient with probes', () => {
  it('keeps only a small fill and a small environment share of the sky (the windows and walls decide the rest)', () => {
    const s = probeAmbientSplit(1000, 0.5);
    expect(s.hemisphere).toBeCloseTo(1000 * PROBE_SKY_FILL);
    expect(s.environment * Math.PI * 0.5).toBeCloseTo(1000 * PROBE_ENV_SHARE);
    expect(PROBE_SKY_FILL + PROBE_ENV_SHARE).toBeLessThanOrEqual(0.1);
    expect(probeAmbientSplit(1000, null).environment).toBe(0);
  });
});

describe('probe shader chunk', () => {
  it('keeps three.js names and uniforms, so every material finds them', () => {
    for (const name of ['getLightProbeGridIrradiance', 'probesSH', 'probesMin', 'probesMax', 'probesResolution', 'USE_LIGHT_PROBES_GRID']) expect(PROBE_CHUNK).toContain(name);
  });
  it('declares exactly one sampler (the atlas holds the visibility too)', () => {
    expect(PROBE_CHUNK.match(/sampler\d?D\s+\w+;/g)).toHaveLength(1);
  });
});

describe('probes in the perf profiles', () => {
  it('the full profile bakes probes, the low (phone) tier has none (float atlas + bake cost); the texture budget is unchanged', () => {
    expect(FULL_PROFILE.probes).not.toBeNull();
    expect(LOW_PROFILE.probes).toBeNull();
    expect(perfProfileFor({ coarsePointer: true }).probes).toBeNull();
    expect(RESERVED_TEXTURE_UNITS).toBe(9);
    expect(shadowLampBudget(FULL_PROFILE, 16)).toBe(7);
  });
});
