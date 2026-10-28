// Scene tests need a few `ProductSnapshot`s. The product record schema and `productSnapshot()` now live in @flat/assets
// (step A4), which scene must not import, so this builds the snapshot from the raw fixture records directly. It copies the
// field mapping of assets' `productSnapshot` (covered by packages/assets/src/products/records.test.ts).
import products from '../fixtures/products.json';
import type { ProductSnapshot } from '../src/products';

/** A raw record of `fixtures/products.json` (all fixtures are TTC and have no lumens unless stated). */
export type RawProduct = (typeof products)[number];

export const wardrobe: RawProduct = products[0]!;
export const bed: RawProduct = products[1]!;

export function productSnapshot(p: RawProduct, snapshotAt: string, colour?: string): ProductSnapshot {
  return {
    provider: p.provider,
    sku: p.sku,
    name: p.name,
    url: p.url,
    price: p.price,
    currency: p.currency,
    dims: p.dims,
    category: p.category,
    snapshotAt,
    ...(colour !== undefined ? { colour } : {}),
    ...('lumens' in p && typeof p.lumens === 'number' ? { lumens: p.lumens } : {}),
  } as ProductSnapshot;
}
