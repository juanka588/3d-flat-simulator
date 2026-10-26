import { describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING, applyPreset } from './view';
import type { Light, Site } from './schema';

const site: Site = { latitude: 48.8, longitude: 2.3, northAngle: 0, timezone: 'Europe/Paris', floorElevation: 0 };
const lights: Light[] = [
  { id: 'a', type: 'point', position: [1, 1], elevation: 2.4, lumens: 800, kelvin: 2700, on: true },
  { id: 'b', type: 'point', position: [2, 1], elevation: 2.4, lumens: 800, kelvin: 2700, on: false },
];

describe('applyPreset', () => {
  const base = { ...DEFAULT_LIGHTING, lamps: { a: { lumens: 500 }, zz: { on: true } } };
  it('day: noon, sun on, lamps off, keeps other overrides', () => {
    const v = applyPreset({ ...base, time: '08:00', sunEnabled: false }, 'day', site, lights);
    expect(v).toMatchObject({ date: '2026-06-21', time: '12:00', sunEnabled: true });
    expect(v.lamps).toEqual({ a: { lumens: 500, on: false }, b: { on: false }, zz: { on: true } });
  });
  it('evening: 20:00 on 21 Dec, lamps on', () => {
    const v = applyPreset(base, 'evening', site, lights);
    expect(v).toMatchObject({ date: '2026-12-21', time: '20:00', sunEnabled: true });
    expect(v.lamps.a).toEqual({ lumens: 500, on: true });
    expect(v.lamps.b).toEqual({ on: true });
  });
  it('evening in the southern hemisphere uses 21 Jun', () => {
    expect(applyPreset(base, 'evening', { ...site, latitude: -33 }, lights).date).toBe('2026-06-21');
  });
  it('night: 23:00, sun disabled, lamps on', () => {
    const v = applyPreset(base, 'night', site, lights);
    expect(v).toMatchObject({ time: '23:00', sunEnabled: false });
    expect(v.lamps.b).toEqual({ on: true });
  });
  it('does not mutate its input', () => {
    const copy = structuredClone(base);
    applyPreset(base, 'night', site, lights);
    expect(base).toEqual(copy);
  });
});
