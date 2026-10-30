import { describe, expect, it } from 'vitest';
import { parseScene } from '../parse';
import { buildFittings, DOOR_HANDLE_HEIGHT, WINDOW_HANDLE_HEIGHT } from './fittings';
import { bounds, makeScene, materialTriangles } from './testUtil';
import { BUILTIN_MATERIALS } from './types';

const wall = { id: 'w', start: [0, 0] as [number, number], end: [6, 0] as [number, number], thickness: 0.2, height: 2.5 };

describe('white doors and sashed windows', () => {
  const scene = makeScene([wall], [
    { id: 'legacy', wallId: 'w', type: 'door', offset: 1, width: 0.9, height: 2.04 },
    { id: 'white', wallId: 'w', type: 'door', offset: 2.5, width: 0.8, height: 2.04, finish: 'white' },
    { id: 'fw', wallId: 'w', type: 'door', offset: 4.2, width: 1.4, height: 2.05, sill: 0.15, glazed: true, finish: 'white', sashes: 2 },
    { id: 'win', wallId: 'w', type: 'window', offset: 5.5, width: 0.7, height: 1.2, sill: 0.8, finish: 'white', sashes: 1 },
  ]);
  const { fittings, glass } = buildFittings(scene);
  const own = (id: string) => (o: { entityId: string }) => o.entityId === id;

  it('keeps the legacy look when no finish is given (back-compat)', () => {
    const mats = new Set(fittings.groups.map((g) => g.materialId));
    expect(materialTriangles(fittings, BUILTIN_MATERIALS.door, own('legacy')).length).toBeGreaterThan(0);
    expect(materialTriangles(fittings, BUILTIN_MATERIALS.handle, own('legacy'))).toHaveLength(0);
    expect(mats.has(BUILTIN_MATERIALS.door)).toBe(true);
  });

  it('draws a white lacquered leaf, a white frame and steel levers at 1.05 m on both sides', () => {
    expect(materialTriangles(fittings, BUILTIN_MATERIALS.doorWhite, own('white')).length).toBeGreaterThan(0);
    expect(materialTriangles(fittings, BUILTIN_MATERIALS.frameWhite, own('white')).length).toBeGreaterThan(0);
    expect(materialTriangles(fittings, BUILTIN_MATERIALS.door, own('white'))).toHaveLength(0);
    const steel = materialTriangles(fittings, BUILTIN_MATERIALS.handle, own('white'));
    expect(steel.length).toBeGreaterThan(0);
    // The wall runs along x at z = 0; the leaf (open at 90 degrees) lies in the x range of its hinge end, 4 cm thick.
    const levelled = steel.filter((t) => t.p.every((p) => Math.abs(p[1]! - DOOR_HANDLE_HEIGHT) < 0.012));
    expect(levelled.length).toBeGreaterThan(0);
    const b = bounds(levelled);
    expect(b.min[1]).toBeCloseTo(DOOR_HANDLE_HEIGHT - 0.01, 2);
    // One lever either side of the leaf: steel on both faces (x below and above the leaf).
    const leaf = bounds(materialTriangles(fittings, BUILTIN_MATERIALS.doorWhite, own('white')));
    expect(b.min[0]!).toBeLessThan(leaf.min[0]! - 0.02);
    expect(b.max[0]!).toBeGreaterThan(leaf.max[0]! + 0.02);
  });

  it('lays a slim architrave outside the frame without changing the hole', () => {
    const b = bounds(materialTriangles(fittings, BUILTIN_MATERIALS.frameWhite, own('white')));
    expect(b.min[0]!).toBeLessThan(2.5 - 0.4 - 0.04);
    expect(b.max[0]!).toBeGreaterThan(2.5 + 0.4 + 0.04);
    expect(b.max[2]!).toBeGreaterThan(0.1);
  });

  it('builds sashes, a meeting cover strip and one pane per sash, with a white handle at 1.1 m', () => {
    const panes = glass.owners.filter(own('fw')).reduce((n, o) => n + o.count, 0);
    expect(panes).toBe(4); // two quads
    const handle = materialTriangles(fittings, BUILTIN_MATERIALS.handleWhite, own('fw'));
    expect(handle.length).toBeGreaterThan(0);
    const hb = bounds(handle);
    expect(hb.min[1]!).toBeLessThan(WINDOW_HANDLE_HEIGHT - 0.1);
    expect(hb.max[1]!).toBeGreaterThan(WINDOW_HANDLE_HEIGHT + 0.05);
    // Room side = right of the wall direction, +z for a wall along +x: the handle lies on that side.
    expect(hb.min[2]!).toBeGreaterThanOrEqual(0);
    // handle sits at the meeting stiles, near the middle of the 1.4 m leaf pair
    expect((hb.min[0]! + hb.max[0]!) / 2).toBeGreaterThan(4.2 - 0.1);
    expect((hb.min[0]! + hb.max[0]!) / 2).toBeLessThan(4.2);
    expect(glass.owners.filter(own('win')).reduce((n, o) => n + o.count, 0)).toBe(2);
  });

  it('keeps the sashes inside the frame depth', () => {
    const b = bounds(materialTriangles(fittings, BUILTIN_MATERIALS.frameWhite, own('fw')));
    expect(b.max[2]!).toBeLessThanOrEqual(0.1 + 1e-6);
  });
});

describe('Opening schema back-compat', () => {
  const base = { version: 1, name: 'x', site: { latitude: 48.8, longitude: 2.3 }, walls: [{ id: 'w', start: [0, 0], end: [4, 0], thickness: 0.2, height: 2.5 }] };
  it('accepts openings with and without finish / sashes, and rejects unknown finishes', () => {
    const o = { id: 'd', wallId: 'w', type: 'door', offset: 1, width: 0.9, height: 2.04 };
    expect(parseScene({ ...base, openings: [o] }).ok).toBe(true);
    expect(parseScene({ ...base, openings: [{ ...o, finish: 'white' }] }).ok).toBe(true);
    expect(parseScene({ ...base, openings: [{ ...o, finish: 'white', sashes: 2, glazed: true }] }).ok).toBe(true);
    expect(parseScene({ ...base, openings: [{ ...o, finish: 'pink' }] }).ok).toBe(false);
    expect(parseScene({ ...base, openings: [{ ...o, sashes: 9 }] }).ok).toBe(false);
  });
});
