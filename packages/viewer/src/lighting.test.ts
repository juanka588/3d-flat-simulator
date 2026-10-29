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
    // An area panel is a shadow-casting point proxy with the lower-hemisphere flux: lm / (2pi).
    const panel = m.lamps.find((l) => l.type === 'area')!;
    expect(panel.intensity).toBeCloseTo(panel.lumens / (2 * Math.PI), 6);
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

// ---- grids, render plan, bounce -----------------------------------------------------------------

import { spotCandela } from '@flat/scene';
import { planRenderLights, roomLampBounce } from './lighting';
import type { LampSpec } from './lighting';

function withGrid(): Scene {
  const grid = { id: 'led', type: 'grid' as const, roomId: 'sejour', position: [2, 4] as [number, number], elevation: 2.47, rows: 3, cols: 4, width: 3.2, depth: 3, rotation: 0, lumensEach: 450, angle: 100, kelvin: 2700, on: true };
  return { ...scene, lights: [...scene.lights, grid] };
}
const night = (lamps: LightingView['lamps'] = {}) => view({ sunEnabled: false, time: '23:00', lamps });
const BUDGET = { shadowLamps: 9, gridTiles: 4 };

describe('planRenderLights', () => {
  it('keeps the light structure and shadow flags when lamps are toggled or dimmed (no shader recompiles)', () => {
    const sc = withGrid();
    const shape = (lamps: LightingView['lamps']) => {
      const m = computeLighting(sc, night(lamps));
      if (!m.ok) throw new Error(m.error);
      return planRenderLights(m.lamps, BUDGET).map((l) => [l.key, l.kind, l.shadow, l.reach]);
    };
    const allOn = shape({});
    const allOff = shape(Object.fromEntries(sc.lights.map((l) => [l.id, { on: false }])));
    const dim = shape({ led: { lumens: 100 }, 'l-wc': { on: false } });
    expect(allOff).toEqual(allOn);
    expect(dim).toEqual(allOn);
    expect(allOn.length).toBe(scene.lights.length + 4); // the grid is 4 tile lights
  });

  it('a grid is lit by tile lights whose flux adds up to the grid total, and is dark when off', () => {
    const sc = withGrid();
    const m = computeLighting(sc, night());
    if (!m.ok) throw new Error(m.error);
    const led = m.lamps.find((l) => l.id === 'led')!;
    expect(led.lumens).toBe(5400);
    const tiles = planRenderLights([led], BUDGET);
    expect(tiles).toHaveLength(4);
    const solidAngle = 2 * Math.PI * (1 - Math.cos((100 * Math.PI) / 360));
    expect(tiles.reduce((s, t) => s + t.intensity * solidAngle, 0)).toBeCloseTo(5400, 3);
    expect(spotCandela(450, 100) * solidAngle).toBeCloseTo(450, 6);
    const off = computeLighting(sc, night({ led: { on: false } }));
    if (!off.ok) throw new Error(off.error);
    expect(planRenderLights([off.lamps.find((l) => l.id === 'led')!], BUDGET).every((t) => t.intensity === 0)).toBe(true);
    // a view override of lumens is the TOTAL flux
    const dimmed = computeLighting(sc, night({ led: { lumens: 2700 } }));
    if (!dimmed.ok) throw new Error(dimmed.error);
    expect(planRenderLights([dimmed.lamps.find((l) => l.id === 'led')!], BUDGET).reduce((s, t) => s + t.intensity * solidAngle, 0)).toBeCloseTo(2700, 3);
  });

  it('only the first lights up to the budget cast shadows; the others are unshadowed with a cut-off', () => {
    const lamps = resolveLamps(withGrid(), night()) as LampSpec[];
    const lights = planRenderLights(lamps, { shadowLamps: 5, gridTiles: 4 });
    expect(lights.filter((l) => l.shadow)).toHaveLength(5);
    expect(lights.slice(0, 5).every((l) => l.shadow && l.reach === 0)).toBe(true);
    expect(lights.slice(5).every((l) => !l.shadow && l.reach > 0)).toBe(true);
    expect(planRenderLights(lamps, { shadowLamps: 5, gridTiles: 2 }).length).toBe(lights.length - 2);
  });
});

describe('roomLampBounce', () => {
  it('lights only the rooms with a lit lamp, and a switched-off room goes dark', () => {
    const allOn = roomLampBounce(scene, resolveLamps(scene, night()));
    expect(Object.keys(allOn).sort()).toEqual(['alcove', 'balcon', 'ch1', 'ch2', 'entree', 'sdb', 'sejour', 'wc']);
    const noWc = roomLampBounce(scene, resolveLamps(scene, night({ 'l-wc': { on: false } })));
    expect(noWc.wc).toBeUndefined();
    expect(noWc.sdb).toEqual(allOn.sdb); // the neighbour is untouched
    const off = Object.fromEntries(scene.lights.map((l) => [l.id, { on: false }]));
    expect(roomLampBounce(scene, resolveLamps(scene, view({ lamps: off })))).toEqual({});
  });

  it('the bounce is warm for warm lamps, and the sejour sums its two lamps', () => {
    const b = roomLampBounce(scene, resolveLamps(scene, night()));
    expect(b.wc!.color[0]).toBeGreaterThan(b.wc!.color[2]);
    const single = roomLampBounce(scene, resolveLamps(scene, night({ 'l-cuisine': { on: false } })));
    expect(b.sejour!.lux).toBeGreaterThan(single.sejour!.lux);
    expect(b.wc!.lux).toBeGreaterThan(0);
  });
});
