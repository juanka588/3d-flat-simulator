import { describe, expect, it } from 'vitest';
import sample from '../fixtures/sample.flat.json';
import { parseScene } from './parse';
import { summarizeScene } from './measure';

const clone = <T>(v: T): T => structuredClone(v);

describe('parseScene', () => {
  it('accepts the sample flat and applies defaults', () => {
    const result = parseScene(sample);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const wall = result.scene.walls.find((w) => w.id === 'w-bed1-east')!;
    expect(wall.thickness).toBe(0.1);
    expect(wall.height).toBe(2.6);
    expect(result.scene.lights.every((l) => l.on)).toBe(true);
  });

  it('describes the sample as a ~65 m² two-bedroom flat', () => {
    const result = parseScene(sample);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const summary = summarizeScene(result.scene);
    expect(summary.totalArea).toBeCloseTo(65, 6);
    expect(summary.rooms.filter((r) => r.type === 'bedroom')).toHaveLength(2);
    expect(summary.doorCount).toBe(4);
    expect(summary.windowCount).toBe(6);
  });

  it('reports field paths for invalid values', () => {
    const bad = clone(sample) as any;
    bad.walls[2].thickness = -1;
    bad.materials[0].color = 'white';
    const result = parseScene(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^walls\[2\]\.thickness: /),
        expect.stringMatching(/^materials\[0\]\.color: expected a hex colour/),
      ]),
    );
  });

  it('rejects broken references and openings that do not fit their wall', () => {
    const bad = clone(sample) as any;
    bad.openings[0].wallId = 'nope';
    bad.openings[3].offset = 6.3; // entry door on the 6.5 m east wall, 0.9 m wide
    bad.rooms[0].floorMaterial = 'marble';
    bad.lights[0].roomId = 'garage';
    const result = parseScene(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      'openings[0].wallId: unknown wall "nope"',
      expect.stringMatching(/^openings\[3\]\.offset: opening spans 5\.85–6\.75 m but wall "w-east" is 6\.50 m long/),
      'rooms[0].floorMaterial: unknown material "marble"',
      'lights[0].roomId: unknown room "garage"',
    ]);
  });

  it('rejects duplicate ids across collections', () => {
    const bad = clone(sample) as any;
    bad.rooms[0].id = 'w-north';
    const result = parseScene(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('rooms[0].id: duplicate id "w-north" (already used in walls)');
  });
});
