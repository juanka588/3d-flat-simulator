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
    const bom = billOfMaterials(s, { now: t0 });
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

  it('existing furniture (locked, no product) is listed at EUR 0 and never missing a price', () => {
    const s = build([item('placard', [1, 1], { locked: true }), item('plain', [3, 3])]);
    const bom = billOfMaterials(s);
    expect(bom.lines.map((l) => [l.itemId, l.locked, l.existing, l.amount])).toEqual([['placard', true, true, 0], ['plain', false, false, 0]]);
    expect(bom.totalEur).toBe(0);
    expect(bom.missingPrice).toEqual(['plain']);
  });

  it('a pinned (locked) purchasable item keeps its price; only existing products count 0', () => {
    const own = { ...productSnapshot(wardrobe, T0), provider: 'existing' };
    const s = build([
      item('pinned', [2, 2], { locked: true, product: productSnapshot(wardrobe, T0) }),
      item('own', [3, 3], { locked: true, product: own }),
    ]);
    const bom = billOfMaterials(s);
    expect(bom.lines.map((l) => [l.itemId, l.locked, l.existing, l.amount])).toEqual([['pinned', true, false, wardrobe.price], ['own', true, true, 0]]);
    expect(bom.totalEur).toBe(wardrobe.price);
    expect(bom.bySku[0]!).toMatchObject({ quantity: 1, toBuy: 1, amount: wardrobe.price });
    expect(bom.bySku[1]!).toMatchObject({ quantity: 1, toBuy: 0, amount: 0 });
  });

  it('groups by (sku, price, currency): the same SKU at two prices is two groups whose amounts add up', () => {
    const cheap = { ...productSnapshot(bed, T0), price: 100 };
    const dear = { ...productSnapshot(bed, T0), price: 150 };
    const usd = { ...productSnapshot(bed, T0), price: 100, currency: 'USD' };
    const s = build([item('a', [1, 1], { product: cheap }), item('b', [2, 2], { product: dear }), item('c', [3, 3], { product: cheap }), item('d', [1, 3], { product: usd })]);
    const bom = billOfMaterials(s);
    expect(bom.bySku.map((g) => [g.unitPrice, g.currency, g.quantity, g.amount])).toEqual([[100, 'EUR', 2, 200], [150, 'EUR', 1, 150], [100, 'USD', 1, 100]]);
    for (const g of bom.bySku) expect(g.amount).toBe(g.unitPrice * g.toBuy);
  });

  it('flags snapshots older than 7 days relative to the injected now; pinned items too, existing ones never', () => {
    const old = productSnapshot(bed, new Date(t0 - (STALE_PRICE_DAYS + 1) * DAY).toISOString());
    const edge = productSnapshot(wardrobe, new Date(t0 - STALE_PRICE_DAYS * DAY).toISOString());
    const s = build([item('old', [1, 1], { product: old }), item('edge', [2, 2], { product: edge }), item('own', [3, 3], { product: { ...old, provider: 'existing' }, locked: true })]);
    const bom = billOfMaterials(s, { now: t0 });
    expect(bom.stale).toEqual(['old']);
    expect(bom.lines.find((l) => l.itemId === 'old')!.stale).toBe(true);
    expect(bom.bySku.find((g) => g.productId === `mock:${bed.sku}`)!.stale).toBe(true);
    expect(billOfMaterials(s, { now: t0 + 30 * DAY }).stale).toEqual(['old', 'edge']);
  });

  it('defaults now to the real clock: an old snapshot is stale without an injected now', () => {
    const old = productSnapshot(bed, '2020-01-01T00:00:00.000Z');
    const fresh = productSnapshot(wardrobe, new Date().toISOString());
    expect(billOfMaterials(build([item('old', [1, 1], { product: old }), item('new', [2, 2], { product: fresh })])).stale).toEqual(['old']);
  });

  it('an unparseable snapshotAt is stale', () => {
    const scene = build([item('bad', [1, 1], { product: productSnapshot(bed, T0) })]);
    // the schema refuses such a date, but a hand-edited or legacy scene may reach the BOM unparsed
    const bad = { ...scene, items: scene.items.map((i) => ({ ...i, product: { ...i.product!, snapshotAt: 'not a date' } })) };
    const bom = billOfMaterials(bad, { now: t0 });
    expect(bom.stale).toEqual(['bad']);
    expect(bom.lines[0]!.stale).toBe(true);
  });

  it('mixedCurrency ignores existing (EUR 0) items in another currency', () => {
    const usd = { ...productSnapshot(bed, T0), currency: 'USD', provider: 'existing' };
    const s = build([item('own', [1, 1], { product: usd, locked: true }), item('eur', [2, 2], { product: productSnapshot(wardrobe, T0) })]);
    expect(billOfMaterials(s).mixedCurrency).toBe(false);
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
