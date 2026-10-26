import { describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING, loadSceneText } from '@flat/scene';
import type { LightingView, Scene } from '@flat/scene';
import charme from '@flat/scene/fixtures/charme-3205.flat.json';
import { SUN_TO_AMBIENT_RATIO, computeLighting, hemisphereColors, luminance, renderSun, resolveLamps } from './lighting';

const result = loadSceneText(JSON.stringify(charme));
if (!result.ok) throw new Error('fixture does not load');
const scene: Scene = result.scene;

const view = (patch: Partial<LightingView>): LightingView => ({ ...DEFAULT_LIGHTING, date: '2026-06-21', time: '12:00', ...patch });

describe('resolveLamps', () => {
  it('applies on/lumens/kelvin overrides', () => {
    const lamps = resolveLamps(scene, view({ lamps: { 'l-ch1': { on: false, lumens: 100, kelvin: 4000 } } }));
    const ch1 = lamps.find((l) => l.id === 'l-ch1')!;
    expect([ch1.on, ch1.lumens, ch1.kelvin]).toEqual([false, 100, 4000]);
    expect(lamps).toHaveLength(scene.lights.length);
  });
});

describe('computeLighting', () => {
  it('lights the flat in real units at noon', () => {
    const m = computeLighting(scene, view({}));
    if (!m.ok) throw new Error(m.error);
    expect(m.sunActive).toBe(true);
    expect(m.sunLux).toBeGreaterThan(50_000);
    expect(m.exposure).toBeLessThan(1e-3);
    const sejour = m.lamps.find((l) => l.id === 'l-sejour')!;
    expect(sejour.intensity).toBeCloseTo(1600 / (4 * Math.PI), 3); // candela
  });

  it('turns the sun off when disabled or below the horizon, and raises exposure', () => {
    const noon = computeLighting(scene, view({}));
    const off = computeLighting(scene, view({ sunEnabled: false }));
    const midnight = computeLighting(scene, view({ time: '00:00' }));
    if (!noon.ok || !off.ok || !midnight.ok) throw new Error('lighting unavailable');
    expect(off.sunLux).toBe(0);
    expect(off.ambientLux).toBe(0);
    expect(midnight.sunLux).toBe(0);
    expect(off.exposure).toBeGreaterThan(noon.exposure * 10);
  });

  it('gives off lamps no intensity and applies EV on the exposure', () => {
    const base = computeLighting(scene, view({ sunEnabled: false }));
    const plus = computeLighting(scene, view({ sunEnabled: false, exposureEV: 2 }));
    const allOff = computeLighting(scene, view({ sunEnabled: false, lamps: Object.fromEntries(scene.lights.map((l) => [l.id, { on: false }])) }));
    if (!base.ok || !plus.ok || !allOff.ok) throw new Error('lighting unavailable');
    expect(plus.exposure / base.exposure).toBeCloseTo(4, 6);
    expect(allOff.lamps.every((l) => l.intensity === 0)).toBe(true);
    expect(allOff.exposure).toBeGreaterThan(base.exposure);
  });

  it('reports failures instead of throwing', () => {
    const m = computeLighting(scene, view({ date: 'not-a-date' }));
    expect(m.ok).toBe(false);
    expect(m.lamps).toHaveLength(scene.lights.length);
  });
});

describe('screen-tuned daylight', () => {
  it('compresses the sun against the hemisphere but keeps the physical lux and exposure sane', () => {
    const m = computeLighting(scene, view({}));
    if (!m.ok) throw new Error(m.error);
    expect(m.sunLux).toBeGreaterThan(50_000);
    expect(m.sunIntensity).toBeLessThan(SUN_TO_AMBIENT_RATIO * m.ambientIntensity * 1.001);
    expect(m.sunIntensity).toBeGreaterThan(m.ambientIntensity); // the sun patch stays brighter than shade
    expect(m.exposure).toBeGreaterThan(1.5e-4); // shade is not crushed (was ~1.2e-4 with the 87 klux key)
  });

  it('renderSun is zero without sun, monotonic and ~identity for a weak sun', () => {
    expect(renderSun(0, 5000)).toBe(0);
    expect(renderSun(100, 5000)).toBeCloseTo(100, 0);
    let prev = 0;
    for (const lux of [1e3, 1e4, 3e4, 1e5, 1e6]) {
      const v = renderSun(lux, 5000);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    expect(prev).toBeLessThanOrEqual(SUN_TO_AMBIENT_RATIO * 5000);
  });

  it('keeps night and lamps-only exposure unchanged (no sun, no hemisphere)', () => {
    const off = computeLighting(scene, view({ sunEnabled: false }));
    if (!off.ok) throw new Error(off.error);
    expect(off.sunIntensity).toBe(0);
    expect(off.ambientIntensity).toBe(0);
  });

  it('hemisphere colours are neutral-ish and unit-luminance (sky) by day', () => {
    const { sky, ground } = hemisphereColors([0.1, 0.27, 0.9], [0.65, 0.75, 0.9]);
    expect(luminance(sky)).toBeCloseTo(1, 5);
    expect(sky[2] / sky[0]).toBeLessThan(1.25);
    expect(luminance(ground)).toBeLessThan(1);
  });
});
