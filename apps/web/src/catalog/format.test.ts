import { describe, expect, it } from 'vitest';
import { billOfMaterials, parseScene } from '@flat/scene';
import { readFileSync } from 'node:fs';
import { bomView, formatDate, formatDims, formatPrice, isBuiltIn, isStale, itemName } from './format';
import { defaultParams, paramFields, resolveParams } from './param-fields';
import { GENERATORS } from '@flat/scene';

const base = parseScene(JSON.parse(readFileSync(new URL('../../../../packages/scene/fixtures/charme-3205.flat.json', import.meta.url), 'utf8')));
if (!base.ok) throw new Error('fixture');
const snap = (price: number, at: string) => ({ provider: 'mock', sku: 'S', name: 'Sofa', url: 'https://shop.mock.example/s', price, currency: 'EUR', dims: { w: 2, d: 0.9, h: 0.85 }, category: 'sofa' as const, snapshotAt: at });

describe('room item list and totals', () => {
  const scene = {
    ...base.scene,
    items: [
      ...base.scene.items,
      { id: 'sofa-1', assetId: 'product:mock', position: [2, 5] as [number, number], elevation: 0, rotation: 0, roomId: 'sejour', product: snap(499, '2026-10-27T10:00:00.000Z'), mesh: { kind: 'parametric' as const, generator: 'sofa', params: {} } },
      { id: 'sofa-2', assetId: 'product:mock', position: [3, 6] as [number, number], elevation: 0, rotation: 0, roomId: 'sejour', product: snap(100, '2026-09-01T10:00:00.000Z') },
    ],
  };
  const view = bomView(scene, billOfMaterials(scene, { now: Date.parse('2026-10-28T10:00:00Z') }));
  it('totals per room and for the flat, TTC, locked items at 0', () => {
    expect(view.rooms.find((r) => r.roomId === 'sejour')!.totalEur).toBe(599);
    expect(view.rooms.find((r) => r.roomId === 'ch1')!.totalEur).toBe(0);
    expect(view.totalEur).toBe(599);
    const placard = view.rooms.find((r) => r.roomId === 'ch1')!.lines[0]!;
    expect(placard).toMatchObject({ locked: true, existing: true });
    expect(placard.price).toMatch(/^0,00/);
  });
  it('flags stale prices and items without a product', () => {
    expect(view.stale).toBe(1);
    expect(view.rooms.find((r) => r.roomId === 'sejour')!.lines.find((l) => l.itemId === 'sofa-2')!.stale).toBe(true);
    expect(view.rooms.find((r) => r.roomId === 'sejour')!.lines.find((l) => l.itemId === 'tv-sejour')!.noProduct).toBe(true);
    expect(view.missingPrice).toBe(1);
  });
});

describe('formatting', () => {
  it('prices, dims and dates', () => {
    expect(formatPrice(299)).toMatch(/^299,00\s€$/);
    expect(formatDims({ w: 1.6, d: 2, h: 0.9 })).toBe('160 × 200 × 90 cm');
    expect(formatDate('2026-10-27T10:00:00Z')).toBe('27 Oct 2026');
  });
  it('a snapshot is stale after 7 days', () => {
    const now = Date.parse('2026-10-28T00:00:00Z');
    expect(isStale('2026-10-21T00:00:00Z', now)).toBe(false);
    expect(isStale('2026-10-20T00:00:00Z', now)).toBe(true);
    expect(isStale('garbage', now)).toBe(true);
  });
  it('names items and spots built-ins', () => {
    const placard = base.scene.items.find((i) => i.id === 'placard-ch1')!;
    expect(isBuiltIn(placard)).toBe(true);
    expect(itemName(placard)).toBe(GENERATORS.get('wardrobe')!.label);
  });
});

describe('generator parameter forms', () => {
  it('every generator has fields, defaults that validate, and exact dims', () => {
    for (const g of GENERATORS.list()) {
      const fields = paramFields(g);
      expect(fields.length, g.id).toBeGreaterThan(0);
      const r = resolveParams(g, defaultParams(g));
      expect(r.ok, g.id).toBe(true);
    }
  });
  it('a size change changes the dims, an out-of-range value is an error', () => {
    const bed = GENERATORS.get('bed')!;
    const r = resolveParams(bed, { ...defaultParams(bed), w: 1.4 });
    expect(r.ok && r.dims.w).toBeCloseTo(1.4, 3);
    expect(resolveParams(bed, { ...defaultParams(bed), w: 99 }).ok).toBe(false);
  });
});
