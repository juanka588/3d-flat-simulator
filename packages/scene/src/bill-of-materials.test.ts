import { describe, expect, it } from 'vitest';
import products from '../fixtures/products.json';
import { makeScene } from './geometry/testUtil';
import { BOM_NO_ROOM, STALE_PRICE_DAYS, billOfMaterials } from './bill-of-materials';
import { ProductRecord, productSnapshot } from './products';
import type { SceneInput } from './schema';

const DAY = 86_400_000;
const bed = ProductRecord.parse(products[1]);
const wardrobe = ProductRecord.parse(products[0]);
const T0 = '2026-10-27T10:00:00.000Z';
const t0 = Date.parse(T0);

const rooms: NonNullable<SceneInput['rooms']> = [
  { id: 'r1', name: 'R1', type: 'bedroom', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
  { id: 'r2', name: 'R2', type: 'bedroom', polygon: [[4.5, 0], [8, 0], [8, 4], [4.5, 4]] },
];
const walls = [{ id: 'w', start: [0, 0] as [number, number], end: [8, 0] as [number, number] }];

const item = (id: string, at: [number, number], extra: Record<string, unknown> = {}) => ({
  id,
  assetId: 'custom:thing',
  position: at,
  ...extra,
});
const build = (items: unknown[]) => makeScene(walls, [], { rooms, items: items as SceneInput['items'] });

describe('billOfMaterials', () => {
  it('sums TTC snapshot prices per room and in total, grouped by SKU with quantities', () => {
    const snap = productSnapshot(bed, T0);
    const s = build([
      item('b1', [1, 1], { product: snap, productRef: { provider: 'mock', sku: bed.sku } }),
      item('b2', [2, 3], { product: snap, productRef: { provider: 'mock', sku: bed.sku } }),
      item('b3', [6, 2], { product: snap, productRef: { provider: 'mock', sku: bed.sku }, roomId: 'r2' }),
      item('w1', [5, 3], { product: productSnapshot(wardrobe, T0) }),
    ]);
    const bom = billOfMaterials(s);
    expect(bom.totalEur).toBeCloseTo(3 * bed.price + wardrobe.price, 2);
    expect(bom.byRoom.r1).toEqual({ totalEur: 2 * bed.price, itemCount: 2 });
    expect(bom.byRoom.r2!.itemCount).toBe(2);
    expect(bom.byRoom.r2!.totalEur).toBeCloseTo(bed.price + wardrobe.price, 2);
    expect(bom.bySku.map((g) => [g.productId, g.quantity, g.toBuy, g.amount])).toEqual([
      [`mock:${bed.sku}`, 3, 3, 3 * bed.price],
      [`mock:${wardrobe.sku}`, 1, 1, wardrobe.price],
    ]);
    expect(bom.lines.map((l) => l.itemId)).toEqual(['b1', 'b2', 'b3', 'w1']);
    expect(bom.mixedCurrency).toBe(false);
    expect(bom.missingPrice).toEqual([]);
    expect(bom.stale).toEqual([]);
  });

  it('locked items are listed at EUR 0 and are never missing a price, with or without a product', () => {
    const s = build([
      item('placard', [1, 1], { locked: true }),
      item('locked-priced', [2, 2], { locked: true, product: productSnapshot(wardrobe, T0) }),
      item('plain', [3, 3]),
    ]);
    const bom = billOfMaterials(s);
    expect(bom.lines.map((l) => [l.itemId, l.locked, l.amount])).toEqual([['placard', true, 0], ['locked-priced', true, 0], ['plain', false, 0]]);
    expect(bom.lines[1]!.unitPrice).toBe(wardrobe.price);
    expect(bom.totalEur).toBe(0);
    expect(bom.missingPrice).toEqual(['plain']);
    const g = bom.bySku[0]!;
    expect([g.quantity, g.toBuy, g.amount]).toEqual([1, 0, 0]);
  });

  it('flags snapshots older than 7 days relative to the injected now, not locked ones', () => {
    const old = productSnapshot(bed, new Date(t0 - (STALE_PRICE_DAYS + 1) * DAY).toISOString());
    const edge = productSnapshot(wardrobe, new Date(t0 - STALE_PRICE_DAYS * DAY).toISOString());
    const s = build([item('old', [1, 1], { product: old }), item('edge', [2, 2], { product: edge }), item('lk', [3, 3], { product: old, locked: true })]);
    const bom = billOfMaterials(s, { now: t0 });
    expect(bom.stale).toEqual(['old']);
    expect(bom.lines.find((l) => l.itemId === 'old')!.stale).toBe(true);
    expect(bom.bySku.find((g) => g.productId === `mock:${bed.sku}`)!.stale).toBe(true);
    // The default now is the latest snapshot in the scene: deterministic, and the oldest is 8 days before the newest only if so.
    expect(billOfMaterials(s).stale).toEqual([]);
    expect(billOfMaterials(s, { now: t0 + 30 * DAY }).stale).toEqual(['old', 'edge']);
  });

  it('flags non-EUR lines and leaves them out of the EUR total', () => {
    const usd = { ...productSnapshot(bed, T0), currency: 'USD' };
    const s = build([item('eur', [1, 1], { product: productSnapshot(wardrobe, T0) }), item('usd', [2, 2], { product: usd })]);
    const bom = billOfMaterials(s);
    expect(bom.mixedCurrency).toBe(true);
    expect(bom.totalEur).toBe(wardrobe.price);
    expect(bom.lines[1]).toMatchObject({ currency: 'USD', amount: bed.price });
    expect(bom.byRoom.r1).toEqual({ totalEur: wardrobe.price, itemCount: 2 });
  });

  it('puts items outside every room under "_none" and is deterministic', () => {
    const s = build([item('out', [20, 20], { product: productSnapshot(bed, T0) })]);
    expect(billOfMaterials(s).byRoom[BOM_NO_ROOM]).toEqual({ totalEur: bed.price, itemCount: 1 });
    expect(billOfMaterials(s)).toEqual(billOfMaterials(s));
    expect(billOfMaterials(build([]))).toEqual({ lines: [], bySku: [], totalEur: 0, byRoom: {}, stale: [], missingPrice: [], mixedCurrency: false });
  });

  it('keeps cents exact (no float drift)', () => {
    const cheap = { ...productSnapshot(bed, T0), price: 0.1 };
    const s = build(Array.from({ length: 3 }, (_, i) => item(`c${i}`, [1, 1 + i], { product: cheap })));
    expect(billOfMaterials(s).totalEur).toBe(0.3);
  });
});
