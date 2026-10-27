import { describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING } from '@flat/scene';
import { WALK_LIGHTS_EV, effectiveLighting, withAllLampsOn } from './effectiveLighting';

const lights = [{ id: 'a' }, { id: 'b' }];
const base = { ...DEFAULT_LIGHTING, exposureEV: 1, lamps: { a: { on: false, lumens: 300 } } };

describe('effectiveLighting', () => {
  it('turns every lamp on and adds exposure in walk mode, keeping other overrides', () => {
    const e = effectiveLighting(base, 'walk', true, lights);
    expect(e.lamps).toEqual({ a: { on: true, lumens: 300 }, b: { on: true } });
    expect(e.exposureEV).toBe(1 + WALK_LIGHTS_EV);
  });

  it('never touches the stored lighting, and is the same object outside walk mode or with the preference off', () => {
    const copy = structuredClone(base);
    effectiveLighting(base, 'walk', true, lights);
    expect(base).toEqual(copy);
    expect(effectiveLighting(base, 'orbit', true, lights)).toBe(base);
    expect(effectiveLighting(base, 'top', true, lights)).toBe(base);
    expect(effectiveLighting(base, 'walk', false, lights)).toBe(base);
  });

  it('is memoised per lighting object and lights list', () => {
    expect(effectiveLighting(base, 'walk', true, lights)).toBe(effectiveLighting(base, 'walk', true, lights));
    expect(effectiveLighting({ ...base }, 'walk', true, lights)).not.toBe(effectiveLighting(base, 'walk', true, lights));
  });

  it('clamps the exposure to the schema range', () => {
    expect(withAllLampsOn({ ...base, exposureEV: 6 }, lights, 0.5).exposureEV).toBe(6);
  });
});
