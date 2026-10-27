import { describe, expect, it } from 'vitest';
import { buildItems } from './builtin';
import { bedDressingOf, buildBedDressing, isBedFrameName, sleepingSurfaceOf } from './dressing';
import { defaultParametricFor, GENERATORS } from './catalog';
import type { Item } from '../schema';

const frame = (over: Partial<Item> = {}, name = 'KLEPPSTAD Cadre de lit - blanc/Vissle beige 160x200 cm'): Item =>
  ({
    id: 'item-1',
    assetId: 'product:ikea-fr',
    position: [3, 3],
    elevation: 0,
    rotation: 0,
    mesh: { kind: 'provider' },
    dims: { w: 1.66, d: 2.07, h: 0.86 },
    product: { provider: 'ikea-fr', sku: '10492672', name, url: 'https://www.ikea.com/fr/fr/p/x-10492672/', price: 179, currency: 'EUR', dims: { w: 1.66, d: 2.07, h: 0.86 }, category: 'bed', snapshotAt: '2026-10-27T10:00:00.000Z' },
    ...over,
  }) as Item;

describe('bed frame dressing', () => {
  it('knows a frame by its name, French and English, and never a mattress', () => {
    for (const n of ['KLEPPSTAD Cadre de lit', 'MALM Cadre lit', 'bed frame 160x200', 'Structure de lit']) expect(isBedFrameName(n), n).toBe(true);
    for (const n of ['MALFORS Matelas', 'mattress 90x200', 'KALLAX Étagère']) expect(isBedFrameName(n), n).toBe(false);
  });
  it('reads the sleeping surface from the name', () => {
    expect(sleepingSurfaceOf('Cadre de lit 160x200 cm')).toEqual({ w: 1.6, d: 2 });
    expect(sleepingSurfaceOf('Table 120x60 cm')).toBeUndefined();
  });
  it('fits the mattress to the frame and can be turned off or skipped', () => {
    const spec = bedDressingOf(frame())!;
    expect(spec.mattress).toEqual({ w: 1.6, d: 2 });
    expect(bedDressingOf(frame({ dressing: false }))).toBeUndefined();
    expect(bedDressingOf(frame({}, 'MALFORS Matelas à ressorts 160x200'))).toBeUndefined();
    expect(bedDressingOf(frame({ mesh: { kind: 'parametric', generator: 'bed', params: {} } }))).toBeUndefined();
  });
  it('is a few boxes inside the frame footprint, above the slats, and buildItems adds it next to the (claimed) item', () => {
    const spec = bedDressingOf(frame())!;
    const mesh = buildBedDressing(spec);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(Math.abs(mesh.positions[i]!)).toBeLessThanOrEqual(1.66 / 2 + 1e-6);
      expect(Math.abs(mesh.positions[i + 2]!)).toBeLessThanOrEqual(2.07 / 2 + 1e-6);
      minY = Math.min(minY, mesh.positions[i + 1]!);
      maxY = Math.max(maxY, mesh.positions[i + 1]!);
    }
    expect(minY).toBeGreaterThan(0.15);
    expect(maxY).toBeLessThan(0.86);
    const item = frame();
    // the item itself is drawn by the viewer from its model: nothing in `items`, but the dressing is still built
    expect(buildItems({ items: [] }, { dressed: [item] }).indices.length).toBeGreaterThan(0);
    expect(buildItems({ items: [] }, { dressed: [frame({ dressing: false })] }).indices.length).toBe(0);
  });
});

describe('kitchen island fallback', () => {
  it('an island by name gets the island generator with a worktop overhang; a plain kitchen unit keeps the base unit', () => {
    const dims = { w: 0.77, d: 1.26, h: 0.9 };
    const island = defaultParametricFor('kitchen', dims, 'TORNVIKEN Îlot pour cuisine - blanc cassé/chêne 126x77 cm')!;
    expect(island.generator).toBe('island');
    const g = GENERATORS.get('island')!;
    expect(g.describeParams(g.params.parse(island.params)).dims).toEqual(dims);
    expect(defaultParametricFor('kitchen', dims, 'METOD Élément bas')!.generator).toBe('kitchenBase');
  });
});
