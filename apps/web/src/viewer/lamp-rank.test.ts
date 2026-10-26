import { describe, expect, it } from 'vitest';
import { MAX_SHADOW_LAMPS, rankShadowLamps } from './lamp-rank';
import type { LampSpec } from './lighting';

const lamp = (id: string, x: number, extra: Partial<LampSpec> = {}): LampSpec => ({
  id,
  name: id,
  type: 'point',
  roomId: undefined,
  position: [x, 2.3, 0],
  on: true,
  lumens: 800,
  kelvin: 2700,
  color: [1, 1, 1],
  intensity: 60,
  angle: 0,
  width: 0,
  depth: 0,
  rotation: 0,
  ...extra,
});

describe('rankShadowLamps', () => {
  const lamps = [lamp('a', 0), lamp('b', 1), lamp('c', 2), lamp('d', 3), lamp('e', 4), lamp('f', 5)];

  it('keeps at most 4, the nearest to the camera', () => {
    const set = rankShadowLamps(lamps, [0, 1.6, 0], undefined);
    expect(MAX_SHADOW_LAMPS).toBe(4);
    expect([...set].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...rankShadowLamps(lamps, [5, 1.6, 0], undefined)].sort()).toEqual(['c', 'd', 'e', 'f']);
  });

  it('skips lamps that are off, dark or area panels', () => {
    const set = rankShadowLamps(
      [lamp('off', 0, { on: false, intensity: 0 }), lamp('area', 0, { type: 'area' }), lamp('ok', 9)],
      [0, 1.6, 0],
      undefined,
    );
    expect([...set]).toEqual(['ok']);
  });

  it('prefers the selected room over distance', () => {
    const set = rankShadowLamps([...lamps.slice(0, 5), lamp('far', 50, { roomId: 'sel' })], [0, 1.6, 0], 'sel');
    expect(set.has('far')).toBe(true);
    expect(set.size).toBe(4);
  });
});
