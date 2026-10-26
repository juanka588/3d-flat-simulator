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
    expect(summary.doorCount).toBe(5);
    expect(summary.windowCount).toBe(5);
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

describe('parseScene strictness', () => {
  const errorsOf = (input: unknown) => {
    const result = parseScene(input);
    if (result.ok) throw new Error('expected validation to fail');
    return result.errors;
  };

  it('rejects unknown keys so typos are not silently ignored', () => {
    const bad = clone(sample) as any;
    bad.walls[0].thicknes = 0.3;
    expect(errorsOf(bad)).toEqual([expect.stringMatching(/^walls\[0\]: .*thicknes/)]);
  });

  it('rejects non-object input with a root-level message', () => {
    expect(errorsOf(42)).toHaveLength(1);
  });

  it('reports invalid light types at the discriminator', () => {
    const bad = clone(sample) as any;
    bad.lights[0].type = 'laser';
    expect(errorsOf(bad)).toEqual([expect.stringMatching(/^lights\[0\]\.type: /)]);
  });

  it('rejects unknown IANA time zones', () => {
    const bad = clone(sample) as any;
    bad.site.timezone = 'Mars/Olympus';
    expect(errorsOf(bad)).toEqual(['site.timezone: unknown IANA time zone']);
  });

  it('rejects overlapping openings on the same wall', () => {
    const bad = clone(sample) as any;
    bad.openings.push({ id: 'win-extra', wallId: 'w-north', type: 'window', offset: 2.2, width: 1, height: 1, sill: 1 });
    expect(errorsOf(bad)).toEqual([
      expect.stringMatching(/^openings\[\d+\]\.offset: overlaps opening "win-bed1" on the same wall$/),
    ]);
  });

  it('accepts an opening that exactly fills its wall despite float error', () => {
    const ok = clone(sample) as any;
    ok.walls.push({ id: 'w-diag', start: [0, 0], end: [0.3, 0.4] });
    ok.openings.push({ id: 'o-diag', wallId: 'w-diag', type: 'door', offset: 0.25, width: 0.5, height: 2 });
    expect(parseScene(ok).ok).toBe(true);
  });

  it('rejects self-intersecting room polygons', () => {
    const bad = clone(sample) as any;
    bad.rooms[0].polygon = [[0, 0], [3.6, 3.4], [3.6, 0], [0, 2]];
    expect(errorsOf(bad)).toEqual(['rooms[0].polygon: room polygon intersects itself']);
  });

  it('requires a textureUrl for texture materials', () => {
    const bad = clone(sample) as any;
    bad.materials[0].kind = 'texture';
    expect(errorsOf(bad)).toEqual(['materials[0].textureUrl: texture materials need a textureUrl']);
  });
});

describe('parseScene limits', () => {
  const base = () => clone(sample) as any;
  const errorsOf = (scene: unknown) => {
    const r = parseScene(scene);
    if (r.ok) throw new Error('expected failure');
    return r.errors;
  };
  const wall = (i: number) => ({ id: `x${i}`, start: [0, 0], end: [1, 0] });
  const many = (n: number, f: (i: number) => object) => Array.from({ length: n }, (_, i) => f(i));

  it.each([
    ['walls', 2000, (i: number) => wall(i)],
    ['openings', 4000, (i: number) => ({ id: `x${i}`, wallId: 'w', type: 'door', offset: 1, width: 1, height: 1 })],
    ['rooms', 500, (i: number) => ({ id: `x${i}`, name: 'r', type: 'other', polygon: [[0, 0], [1, 0], [1, 1]] })],
    ['items', 5000, (i: number) => ({ id: `x${i}`, assetId: 'a', position: [0, 0] })],
    ['lights', 1000, (i: number) => ({ id: `x${i}`, type: 'point', position: [0, 0], elevation: 1, lumens: 1 })],
    ['materials', 1000, (i: number) => ({ id: `x${i}`, name: 'm', kind: 'paint', color: '#ffffff' })],
  ] as const)('rejects more than %s=%i', (key, max, make) => {
    const scene = base();
    scene[key] = many(max + 1, make);
    expect(errorsOf(scene)).toContain(`${key}: too many ${key} (max ${max})`);
  });

  it('rejects polygons with more than 500 vertices', () => {
    const scene = base();
    scene.rooms[0].polygon = many(501, (i) => [i, 0] as any);
    expect(errorsOf(scene)).toContain('rooms[0].polygon: too many polygon vertices (max 500)');
  });

  it('caps reported errors at 50 plus a summary line', () => {
    const scene = base();
    scene.walls = many(200, (i) => ({ ...wall(i), thickness: -1 }));
    const errors = errorsOf(scene);
    expect(errors).toHaveLength(51);
    expect(errors[50]).toMatch(/^…and \d+ more errors$/);
    expect(Number(/\d+/.exec(errors[50]!)![0])).toBeGreaterThanOrEqual(150);
  });
});
