import { z } from 'zod';
import { Dims, HttpUrl, IsoDateTime, ItemMount, Lumens, Price, ProductName, ProviderId, Sku } from '../../primitives';
import { Currency, DimsSource, ProductCategory, ProductId, ProductSnapshot, formatProductId } from '../../products';

/** Weight of the assembled item, or of its packages (IKEA page data is per package). */
export const WeightKind = z.enum(['assembled', 'package']);
export type WeightKind = z.infer<typeof WeightKind>;


const Tag = z.string().min(1).max(32);

/** A purchasable variant of a product (another colour or size, usually another article number). */
export const ProductVariant = z.strictObject({
  sku: Sku,
  name: ProductName.optional(),
  colour: z.string().min(1).max(40).optional(),
  price: Price.optional(),
  dims: Dims.optional(),
  url: HttpUrl.optional(),
});
export type ProductVariant = z.infer<typeof ProductVariant>;

/** Most variants kept per product. */
export const MAX_VARIANTS = 20;

export const ProductRecord = z.strictObject({
  provider: ProviderId,
  sku: Sku,
  name: ProductName,
  /** Public product page (the buy link). */
  url: HttpUrl,
  price: Price,
  currency: Currency,
  /** True when `price` includes VAT (TTC). Budgets only count TTC prices. */
  priceTtc: z.boolean(),
  dims: Dims,
  dimsSource: DimsSource,
  category: ProductCategory,
  /** How the product is fixed; `wall` products hang (mirror, wall cabinet). Defaults to `floor`. */
  mount: ItemMount.default('floor'),
  styleTags: z.array(Tag).max(12).default([]),
  colours: z.array(z.string().min(1).max(40)).max(8).default([]),
  variants: z.array(ProductVariant).max(MAX_VARIANTS).default([]),
  /** Weight in kg; heavy wall mounts (> 15 kg) are only allowed on structural walls. */
  weightKg: z.number().positive().max(2000).optional(),
  weightKind: WeightKind.optional(),
  /** Luminous flux of the bulb in lumens, for lamps, when the product page states it. Absent = unknown (a category default is used). */
  lumens: Lumens.optional(),
  /** Product photo; shown by the UI, NEVER stored in a scene. */
  photoUrl: HttpUrl.optional(),
  /** Opaque server-side handle of the provider's 3D model (for `fetchModel`); never stored in a scene. */
  modelRef: z.string().min(1).max(512).optional(),
  /** When the record was fetched from the provider. */
  fetchedAt: IsoDateTime,
  /** Data and models may only be used privately on this machine (retailer terms); the UI shows a banner. */
  personalUseOnly: z.boolean(),
});
export type ProductRecord = z.infer<typeof ProductRecord>;
export type ProductRecordInput = z.input<typeof ProductRecord>;


export function productIdOf(p: Pick<ProductRecord, 'provider' | 'sku'>): ProductId {
  return formatProductId(p);
}

/** `local` = served from the gitignored local catalogue built by `pnpm catalog:build`; `live` = read from the shop just now. */
export const ProductSource = z.enum(['local', 'live']);
export type ProductSource = z.infer<typeof ProductSource>;
/** A local record older than this many days is flagged stale (the price may have changed). */
export const LOCAL_STALE_DAYS = 30;

// ---------------------------------------------------------------------------------------------
// ProductSummary (search results)
// ---------------------------------------------------------------------------------------------

/** One compact line of a search result: enough to choose, small enough to list 10-20 of them. */
export const ProductSummary = z.strictObject({
  /** Opaque key to pass to `get_product` / `place_item`. */
  productId: ProductId,
  provider: ProviderId,
  name: ProductName,
  price: Price,
  currency: Currency,
  priceTtc: z.boolean(),
  dims: Dims,
  dimsSource: DimsSource,
  category: ProductCategory,
  mount: ItemMount,
  colours: z.array(z.string().min(1).max(40)).max(8),
  /** Weight in kg when known. */
  weightKg: z.number().positive().optional(),
  /** Bulb flux in lumens when the provider states it (lamps). */
  lumens: Lumens.optional(),
  /** The provider has a real 3D model (otherwise a lookalike / parametric shape at exact dims). */
  has3d: z.boolean(),
  photoUrl: HttpUrl.optional(),
  personalUseOnly: z.boolean(),
  /** Where the record came from: the local catalogue (instant, offline) or a live provider request. Absent in older answers. */
  source: ProductSource.optional(),
  /** When the record was read from the shop (set together with `source`). */
  fetchedAt: IsoDateTime.optional(),
  /** A local record older than `LOCAL_STALE_DAYS`: its price may have changed (update with `catalog:build --refresh-prices`). */
  stale: z.literal(true).optional(),
});
export type ProductSummary = z.infer<typeof ProductSummary>;

export function summarizeProduct(p: ProductRecord, extra: { source?: ProductSource; stale?: boolean } = {}): ProductSummary {
  return {
    productId: productIdOf(p),
    provider: p.provider,
    name: p.name,
    price: p.price,
    currency: p.currency,
    priceTtc: p.priceTtc,
    dims: p.dims,
    dimsSource: p.dimsSource,
    category: p.category,
    mount: p.mount,
    colours: p.colours,
    ...(p.weightKg !== undefined ? { weightKg: p.weightKg } : {}),
    ...(p.lumens !== undefined ? { lumens: p.lumens } : {}),
    has3d: p.modelRef !== undefined,
    ...(p.photoUrl !== undefined ? { photoUrl: p.photoUrl } : {}),
    personalUseOnly: p.personalUseOnly,
    ...(extra.source !== undefined ? { source: extra.source, fetchedAt: p.fetchedAt } : {}),
    ...(extra.stale ? { stale: true as const } : {}),
  };
}

/**
 * Snapshot of a record at `snapshotAt`. Throws `RangeError` for a record whose price is not TTC (budgets
 * count TTC prices only, so such a record cannot be placed).
 */
export function productSnapshot(p: ProductRecord, snapshotAt: string, colour?: string): ProductSnapshot {
  if (!p.priceTtc) throw new RangeError(`product ${productIdOf(p)} has a non-TTC price and cannot be snapshotted`);
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
    ...(p.lumens !== undefined ? { lumens: p.lumens } : {}),
  };
}
