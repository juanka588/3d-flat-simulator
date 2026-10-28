import { describe, expect, it } from 'vitest';
import { bedDressingOf } from '../items/dressing';
import { GENERATORS } from '../items/mesh-source';
import { defaultParametricFor } from '../items/parametric-defaults';
import type { Item } from '../schema';
import { buildBedDressing } from './bed-dressing';
import { buildItems } from './build-items';

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
