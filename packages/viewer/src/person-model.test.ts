import { describe, expect, it } from 'vitest';
import { PERSON_PARTS, createPersonGeometry } from './person-model';
import { personPlacement } from './walk-start';

describe('person mannequin', () => {
  it('is exactly as tall as asked, soles on the floor, centred on the plan', () => {
    for (const h of [1.2, 1.66, 2.1]) {
      const g = createPersonGeometry(h);
      const b = g.boundingBox!;
      expect(b.min.y).toBeCloseTo(0, 6);
      expect(b.max.y).toBeCloseTo(h, 6);
      expect((b.min.x + b.max.x) / 2).toBeCloseTo(0, 6);
      expect((b.min.z + b.max.z) / 2).toBeCloseTo(0, 6);
      g.dispose();
    }
  });
  it('follows the 8-heads canon: head about 1/8 of the height, shoulders wider than the hips, a low-poly mesh', () => {
    const g = createPersonGeometry(1.66);
    const head = PERSON_PARTS.find((p) => p.name === 'head')!;
    expect((head.radius * (head.scale?.[1] ?? 1) * 2) / 1).toBeGreaterThan(0.1);
    expect((head.radius * (head.scale?.[1] ?? 1) * 2) / 1).toBeLessThan(0.14);
    const torso = PERSON_PARTS.find((p) => p.name === 'torso')!;
    const leg = PERSON_PARTS.find((p) => p.name === 'leg-l')!;
    expect(torso.radius * (torso.scale?.[0] ?? 1)).toBeGreaterThan(leg.radius);
    expect(g.getAttribute('position').count).toBeLessThan(6000);
    g.dispose();
  });
});

describe('personPlacement', () => {
  it('falls back to the default walk start when nothing is saved or the saved point is outside the flat', () => {
    const scene = { rooms: [{ id: 'r', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] }], walls: [], openings: [], items: [], lights: [], materials: [], site: {} } as never;
    const dflt = personPlacement(scene, null);
    expect(Number.isFinite(dflt.x)).toBe(true);
    expect(personPlacement(scene, { x: 99, z: 99, yawDeg: 10 })).toEqual(dflt);
    expect(personPlacement(scene, { x: 1, z: 2, yawDeg: 10 })).toEqual({ x: 1, z: 2, yawDeg: 10 });
  });
});
