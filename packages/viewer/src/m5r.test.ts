import { describe, expect, it } from 'vitest';
import { AWB_TARGET_KELVIN, ENV_SHARE, awbWeight, environmentLight, whiteBalancedKelvin } from './lighting';
import { blur, creaseMesh, fillRects, rasterContactShadows, wallRects } from './contact-shadows';
import { FULL_PROFILE, LOW_PROFILE } from './perf';
import { meanRadianceOf } from './environment';
import { toneSettingFor } from './tone';

describe('automatic white balance', () => {
  it('leaves daylight views alone and moves lamp-only views towards the target, keeping warmth', () => {
    expect(awbWeight(16000, 5000, 20)).toBeLessThan(0.01);
    expect(awbWeight(0, 0, 150)).toBe(1);
    expect(whiteBalancedKelvin(2700, 0)).toBeCloseTo(2700, 3);
    const k = whiteBalancedKelvin(2700, 1);
    expect(k).toBeGreaterThan(3500);
    expect(k).toBeLessThan(AWB_TARGET_KELVIN + 1);
  });
});

describe('environment light', () => {
  it('conserves the ambient total and vanishes with the sky', () => {
    const l = environmentLight(1000, 0.5);
    expect(l.hemisphere).toBeCloseTo(1000 * (1 - ENV_SHARE));
    expect(l.environment * Math.PI * 0.5).toBeCloseTo(1000 * ENV_SHARE);
    expect(environmentLight(0, 0.5)).toEqual({ hemisphere: 0, environment: 0 });
  });
  it('measures mean radiance with latitude weights', () => {
    expect(meanRadianceOf(new Float32Array(2 * 2 * 4).fill(1), 2, 2, 4)).toBeCloseTo(1);
  });
});

describe('perf profile and tone', () => {
  it('turns the costly extras off on low', () => {
    expect(FULL_PROFILE.contactShadows && FULL_PROFILE.environment).toBe(true);
    expect(LOW_PROFILE.contactShadows || LOW_PROFILE.environment).toBe(false);
  });
  it('defaults to neutral tone mapping', () => {
    expect(toneSettingFor(null).name).toBe('neutral');
    expect(toneSettingFor('agx').name).toBe('agx');
    expect(toneSettingFor('nonsense').name).toBe('neutral');
  });
});

describe('contact shadows', () => {
  const bounds = { x0: 0, z0: 0, x1: 2, z1: 2 };
  it('darkens around a footprint, most at its edge, and nowhere far away', () => {
    const img = rasterContactShadows(bounds, 50, [{ id: 'a', centre: [1, 1], half: [0.3, 0.3], rotation: 0, strength: 1 }], []);
    const at = (x: number, z: number) => img.data[(Math.floor((bounds.z1 - z) * 50) * img.width + Math.floor(x * 50)) * 4 + 3]!;
    expect(at(1.33, 1)).toBeGreaterThan(at(1.5, 1));
    expect(at(1.5, 1)).toBeGreaterThan(at(1.9, 1));
    expect(at(0.1, 0.1)).toBe(0);
  });
  it('fills rotated rects and blurs without gaining energy', () => {
    const g = new Float32Array(40 * 40);
    fillRects(g, 40, 40, { x0: 0, z0: 0, x1: 4, z1: 4 }, 10, [{ id: 'a', centre: [2, 2], half: [0.5, 0.2], rotation: 90, strength: 1 }], 0);
    expect(g[20 * 40 + 20]).toBe(1);
    const before = g.reduce((s, v) => s + v, 0);
    blur(g, 40, 40, 2);
    expect(g.reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(before + 1e-3);
  });
  it('keeps wall creases off door openings', () => {
    const walls = [{ id: 'w', start: [0, 0] as [number, number], end: [4, 0] as [number, number], thickness: 0.1, height: 2.5 }];
    const openings = [{ id: 'd', wallId: 'w', type: 'door' as const, offset: 2, width: 1, height: 2, sill: 0 }];
    const rects = wallRects({ walls, openings } as never);
    expect(rects).toHaveLength(2);
    const room = { id: 'r', name: 'r', type: 'living', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] as [number, number][] };
    const mesh = creaseMesh({ rooms: [room], walls, openings } as never, () => 2.5);
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.colors.length / 4).toBe(mesh.positions.length / 3);
  });
});
