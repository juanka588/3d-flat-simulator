import { describe, expect, it } from 'vitest';
import type { Item } from '../schema';
import { bedDressingOf, isBedFrameName, sleepingSurfaceOf } from './dressing';

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
});
