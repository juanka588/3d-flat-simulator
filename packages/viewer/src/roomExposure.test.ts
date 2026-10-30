import { describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING, loadSceneText, roomDaylightFactors } from '@flat/scene';
import type { LightingView, Scene } from '@flat/scene';
import charme from '@flat/scene/fixtures/charme-3205.flat.json';
import { MAX_ROOM_EXPOSURE_GAIN, computeLighting, resolveLamps, roomAtPoint, roomExposureGain, roomLampLuxById } from './lighting';

const result = loadSceneText(JSON.stringify(charme));
if (!result.ok) throw new Error('fixture does not load');
const scene: Scene = result.scene;
const view = (patch: Partial<LightingView>): LightingView => ({ ...DEFAULT_LIGHTING, date: '2026-06-21', time: '12:00', ...patch });
const allOff = Object.fromEntries(scene.lights.map((l) => [l.id, { on: false }]));

function noon(lamps: LightingView['lamps'] = {}) {
  const m = computeLighting(scene, view({ lamps }));
  if (!m.ok) throw new Error(m.error);
  return m;
}
const factors = roomDaylightFactors(scene);

describe('roomExposureGain: a camera in a windowless room opens up', () => {
  it('opens the exposure up in a room that gets only borrowed light (the hall), not in a sealed one (the bathroom stays dark)', () => {
    const m = noon(allOff);
    // The bathroom has no window and its door leads to the hall, which has none either: no sky reaches it, so it is dark and the exposure does not chase it.
    expect(factors.sdb).toBe(0);
    expect(roomExposureGain(m, factors.sdb!, 0)).toBe(1);
    // The hall borrows a share of the living room's light through its door; the camera adapts to that.
    expect(factors.entree).toBeGreaterThan(0.1);
    expect(factors.entree).toBeLessThan(0.2);
    const gain = roomExposureGain(m, factors.entree!, 0);
    expect(gain).toBeGreaterThan(3);
    expect(gain).toBeLessThanOrEqual(MAX_ROOM_EXPOSURE_GAIN);
    // Wall radiance at that exposure (albedo x sky x factor / pi x exposure) is a readable mid tone, not black.
    const before = (0.8 * m.ambientIntensity * factors.entree! * m.exposure) / Math.PI;
    expect(before * gain).toBeGreaterThan(0.25);
  });

  it('leaves a daylit room and a room as bright as the flat alone, and never darkens', () => {
    const m = noon();
    expect(roomExposureGain(m, 1, 0)).toBeCloseTo(1, 1);
    expect(roomExposureGain(m, factors.sejour!, 0)).toBeLessThan(1.5);
    expect(roomExposureGain(m, 1, 1e6)).toBe(1);
  });

  it('the room`s own lamp lowers the gain, and garbage degrades to 1', () => {
    const m = noon();
    expect(roomExposureGain(m, 0.14, 300)).toBeLessThan(roomExposureGain(m, 0.14, 0));
    expect(roomExposureGain(m, Number.NaN, 0)).toBeCloseTo(1, 1);
    expect(roomExposureGain({ ...m, sunIntensity: 0, ambientIntensity: 0, keyLux: 0 }, 0.14, 0)).toBe(1);
  });

  it('finds the room under a point and the lamp lux per room', () => {
    expect(roomAtPoint(scene, 5.4, 7.2)).toBe('sdb');
    expect(roomAtPoint(scene, -50, -50)).toBeUndefined();
    expect(roomLampLuxById(scene, resolveLamps(scene, view({}))).sdb).toBeGreaterThan(100);
    expect(roomLampLuxById(scene, resolveLamps(scene, view({ lamps: { 'l-sdb': { on: false } } }))).sdb).toBeUndefined();
  });
});
