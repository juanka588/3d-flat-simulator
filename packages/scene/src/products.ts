import { z } from 'zod';
import {
  Dims,
  HttpUrl,
  IsoDateTime,
  ItemMount,
  ProductName,
  ProviderId,
  PROVIDER_ID_RE,
  SKU_MAX,
  Sku,
  stripControlChars,
} from './primitives';

/**
 * M5 product contracts (story M5.0). A PRODUCT is a real, purchasable thing sold by a provider
 * (IKEA FR, a pasted URL, the in-memory `mock` provider). Provider code lives in `apps/server` only;
 * everything in this file is plain JSON that crosses the HTTP / MCP boundary.
 *
 * Three levels, from richest to smallest:
 *  - `ProductRecord`:   the full record, held in SERVER MEMORY only (never persisted, never committed);
 *  - `ProductSummary`:  the compact line of a search result (what the LLM sees);
 *  - `ProductSnapshot`: the few FACTS persisted inside a scene next to a placed item (no photos, no 3D).
 *
 * Units: metres, kilograms. Prices are the TTC (tax included) shelf price in `currency` unless
 * `priceTtc` is false. Dimensions are ASSEMBLED outer dimensions: width (item x), depth (item z),
 * height (item y) as described in `assets/builtin.ts`.
 */

// ---------------------------------------------------------------------------------------------
// ProductId
// ---------------------------------------------------------------------------------------------

/** Provider-qualified product key `"<provider>:<sku>"`, e.g. `ikea-fr:80275887` or `mock:MOCK-BED-160`. */
export const ProductId = z
  .string()
  .max(32 + 1 + SKU_MAX)
  .refine((s) => parseProductId(s) !== undefined, 'expected "<provider>:<sku>", e.g. "ikea-fr:80275887"');
export type ProductId = string;

/** `{provider, sku}` -> `"provider:sku"`. Throws `RangeError` on an invalid provider id or an empty / overlong sku. */
export function formatProductId(ref: { provider: string; sku: string }): ProductId {
  if (!PROVIDER_ID_RE.test(ref.provider)) throw new RangeError(`invalid provider id "${ref.provider}"`);
  if (ref.sku.length === 0 || ref.sku.length > SKU_MAX) throw new RangeError(`invalid sku length ${ref.sku.length}`);
  return `${ref.provider}:${ref.sku}`;
}

/**
 * `"provider:sku"` -> `{provider, sku}`, splitting at the FIRST colon (a sku may contain colons).
 * `undefined` when the shape is wrong, the provider id is not a slug, or the sku is empty, overlong or
 * contains control characters. `parseProductId(formatProductId(r))` equals `r` for every valid ref.
 */
export function parseProductId(id: string): { provider: string; sku: string } | undefined {
  const i = id.indexOf(':');
  if (i < 1) return undefined;
  const provider = id.slice(0, i);
  const sku = id.slice(i + 1);
  if (!PROVIDER_ID_RE.test(provider)) return undefined;
  if (sku.length === 0 || sku.length > SKU_MAX || stripControlChars(sku) !== sku) return undefined;
  return { provider, sku };
}

/** Reference to a product as stored on an item (`Item.productRef`). */
export const ProductRef = z.strictObject({ provider: ProviderId, sku: Sku });
export type ProductRef = z.infer<typeof ProductRef>;

// ---------------------------------------------------------------------------------------------
// ProductRecord
// ---------------------------------------------------------------------------------------------

export const PRODUCT_CATEGORIES = [
  'bed',
  'wardrobe',
  'bedside',
  'drawers',
  'shelf',
  'sideboard',
  'tv_unit',
  'table',
  'desk',
  'chair',
  'armchair',
  'sofa',
  'rug',
  'lamp',
  'mirror',
  'wall_cabinet',
  'kitchen',
  'appliance',
  'decor',
  'other',
] as const;
/** Coarse furniture category; lookalike picking and generators key on it. */
export const ProductCategory = z.enum(PRODUCT_CATEGORIES);
export type ProductCategory = z.infer<typeof ProductCategory>;

/** Where the dimensions came from: provider data fields, parsed from text, typed by the user, or guessed by a model. */
export const DimsSource = z.enum(['structured', 'text', 'user', 'model']);
export type DimsSource = z.infer<typeof DimsSource>;

/** Weight of the assembled item, or of its packages (IKEA page data is per package). */
export const WeightKind = z.enum(['assembled', 'package']);
export type WeightKind = z.infer<typeof WeightKind>;

/** ISO 4217 currency code. */
export const Currency = z.string().regex(/^[A-Z]{3}$/, 'expected an ISO 4217 code like "EUR"');
const Price = z.number().min(0).max(1_000_000);
const Tag = z.string().min(1).max(32);
/** Luminous flux of a lamp product, in lumens. */
const Lumens = z.number().positive().max(100_000);

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

/** Weight (kg) above which a wall-mounted product counts as heavy (D7: structural walls only). */
export const HEAVY_MOUNT_KG = 15;

export function productIdOf(p: Pick<ProductRecord, 'provider' | 'sku'>): ProductId {
  return formatProductId(p);
}

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
});
export type ProductSummary = z.infer<typeof ProductSummary>;

export function summarizeProduct(p: ProductRecord): ProductSummary {
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
  };
}

// ---------------------------------------------------------------------------------------------
// ProductSnapshot (persisted in scenes)
// ---------------------------------------------------------------------------------------------

/**
 * The FACTS persisted in a scene next to a placed item (`Item.product`): enough to show the name, the
 * price and the link offline and to size the item, and nothing a retailer owns (no photo, no model,
 * no description). The price is ALWAYS the TTC price (see `productSnapshot`).
 */
export const ProductSnapshot = z.strictObject({
  provider: ProviderId,
  sku: Sku,
  name: ProductName,
  url: HttpUrl,
  /** TTC price in `currency`. */
  price: Price,
  currency: Currency,
  dims: Dims,
  category: ProductCategory,
  /** When these facts were read from the provider (staleness: the bill of materials flags > 7 days). */
  snapshotAt: IsoDateTime,
  /** Chosen colour, when the product has several. */
  colour: z.string().min(1).max(40).optional(),
  /** Bulb flux in lumens, for lamps whose page states it; the lamp's light uses it ("product" source). */
  lumens: Lumens.optional(),
});
export type ProductSnapshot = z.infer<typeof ProductSnapshot>;

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

// ---------------------------------------------------------------------------------------------
// ProviderInfo
// ---------------------------------------------------------------------------------------------

export const ProviderCapabilities = z.strictObject({
  search: z.boolean(),
  /** The provider can give the product's real 3D model (`fetchModel`). */
  model3d: z.boolean(),
  /** How reliable the dimensions are: separate fields, parsed from text, or absent. */
  dims: z.enum(['structured', 'text', 'none']),
  /** The provider resolves a pasted product URL (`resolveUrl`). */
  resolveUrl: z.boolean().default(false),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>;

/** Circuit breaker state: `open` = the provider is disabled for now after repeated 403/429 or failures. */
export const CircuitState = z.enum(['closed', 'half_open', 'open']);
export type CircuitState = z.infer<typeof CircuitState>;

/** What `list_providers` / `GET /api/providers` tells about one provider. */
export const ProviderInfo = z.strictObject({
  id: ProviderId,
  label: z.string().min(1).max(80),
  capabilities: ProviderCapabilities,
  /** Listed in `FLAT_PROVIDERS` and constructed; a disabled provider is still listed so the UI can explain. */
  enabled: z.boolean(),
  circuit: CircuitState,
  /** Epoch ms when an open circuit retries; absent when closed. */
  retryAt: z.number().int().nonnegative().optional(),
  personalUseOnly: z.boolean(),
  /** Short user-facing note (terms, limits). */
  note: z.string().max(300).optional(),
});
export type ProviderInfo = z.infer<typeof ProviderInfo>;

// ---------------------------------------------------------------------------------------------
// HTTP shapes (/api/providers, /api/products/*)
// ---------------------------------------------------------------------------------------------

/** Query of `GET /api/products/search` (strings from the query string are coerced). */
export const ProductSearchParams = z.strictObject({
  q: z.string().max(200).transform(stripControlChars).default(''),
  /** Restrict to one provider id; absent = every enabled provider. */
  provider: ProviderId.optional(),
  category: ProductCategory.optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  /** Keep only products that fit in this box (each dimension at most the given metres). */
  maxW: z.coerce.number().positive().optional(),
  maxD: z.coerce.number().positive().optional(),
  maxH: z.coerce.number().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type ProductSearchParams = z.infer<typeof ProductSearchParams>;
export type ProductSearchParamsInput = z.input<typeof ProductSearchParams>;

export const ProviderStatus = z.strictObject({
  provider: ProviderId,
  ok: z.boolean(),
  /** Set when `ok` is false: a `ProviderErrorCode`. */
  code: z.string().optional(),
  message: z.string().optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export const ProductSearchResponse = z.strictObject({
  results: z.array(ProductSummary),
  /** One entry per provider that was asked: a failing provider does not fail the search. */
  providers: z.array(ProviderStatus),
  /** More matches existed than `limit`. */
  truncated: z.boolean(),
});
export type ProductSearchResponse = z.infer<typeof ProductSearchResponse>;

export const ProvidersResponse = z.strictObject({ providers: z.array(ProviderInfo) });
export type ProvidersResponse = z.infer<typeof ProvidersResponse>;

export const GetProductResponse = z.strictObject({ product: ProductRecord });
export type GetProductResponse = z.infer<typeof GetProductResponse>;

/** Body of `POST /api/products/resolve`. */
export const ResolveUrlBody = z.strictObject({ url: HttpUrl });
export type ResolveUrlBody = z.infer<typeof ResolveUrlBody>;

/** Body of `POST /api/products/seen`: the product ids a search returned to this MCP session. */
export const MarkSeenBody = z.strictObject({
  session: z.string().min(1).max(64),
  productIds: z.array(ProductId).min(1).max(100),
});
export type MarkSeenBody = z.infer<typeof MarkSeenBody>;

export const MarkSeenResponse = z.strictObject({ ok: z.literal(true), seen: z.number().int().nonnegative() });
export type MarkSeenResponse = z.infer<typeof MarkSeenResponse>;

/** Answer of `GET /api/products/seen?session=..&id=..`. */
export const IsSeenResponse = z.strictObject({ seen: z.boolean() });
export type IsSeenResponse = z.infer<typeof IsSeenResponse>;

// ---------------------------------------------------------------------------------------------
// Provider error codes (D3)
// ---------------------------------------------------------------------------------------------

/**
 * Codes of provider failures. They travel as MCP tool error codes (`mcp-types.ts` appends them to the
 * table) and as `ProviderStatus.code`. `PROVIDER_ERROR_HINTS` is the default "what to do next".
 */
export const PROVIDER_ERROR_CODES = [
  'unknown_provider',
  'provider_disabled',
  'provider_unavailable',
  'provider_blocked',
  'provider_rate_limited',
  'provider_parse_failed',
  'product_not_found',
  'product_not_seen',
  'product_dims_missing',
  'model_unavailable',
  'url_not_allowed',
  'robots_disallowed',
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export const PROVIDER_ERROR_HINTS: Readonly<Record<ProviderErrorCode, string>> = {
  unknown_provider: 'No such provider; call list_providers for the ids.',
  provider_disabled: 'The provider is not enabled on this server (FLAT_PROVIDERS); use another provider from list_providers.',
  provider_unavailable: 'The provider failed or its circuit is open; retry later (retryAt in list_providers) or use another provider.',
  provider_blocked: 'The retailer blocked the request (403/429 or bot protection); the provider is paused for this session. Use another provider or ask the user to paste a product URL.',
  provider_rate_limited: 'The provider is being polled too fast; wait and retry once.',
  provider_parse_failed: 'The retailer page changed and could not be read; use another product or provider.',
  product_not_found: 'No such product; call search_products and use a productId it returned.',
  product_not_seen: 'Only products returned by search_products in this session can be placed; search again.',
  product_dims_missing: 'The product has no usable dimensions; ask the user to type the width, depth and height.',
  model_unavailable: 'No real 3D model for this product; a lookalike or parametric shape at the exact dimensions is used instead.',
  url_not_allowed: 'This URL cannot be fetched (not http(s), not a public host, or not supported); ask the user for a product page URL on a supported site.',
  robots_disallowed: 'The site forbids automated access to this page (robots.txt); ask the user for the product details instead.',
};

// ---------------------------------------------------------------------------------------------
// Pure helpers shared by providers and mocks
// ---------------------------------------------------------------------------------------------

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Deterministic text search over records, for the mock provider, the mock `FlatApi` and offline
 * fixtures. Every query token must appear (accent- and case-insensitive prefix match) in the name,
 * category, style tags, colours or sku. Filters: category, price range, bounding box. Order: best
 * match first (name hits count more), then cheaper, then sku. At most `limit` records.
 */
export function matchProducts(
  records: readonly ProductRecord[],
  query: Pick<ProductSearchParamsInput, 'q' | 'category' | 'minPrice' | 'maxPrice' | 'maxW' | 'maxD' | 'maxH' | 'limit'>,
): { matches: ProductRecord[]; truncated: boolean } {
  const tokens = fold(query.q ?? '').split(/[^a-z0-9]+/).filter(Boolean);
  const limit = Number(query.limit ?? 10);
  const scored: { p: ProductRecord; score: number }[] = [];
  for (const p of records) {
    if (query.category !== undefined && p.category !== query.category) continue;
    if (query.minPrice !== undefined && p.price < Number(query.minPrice)) continue;
    if (query.maxPrice !== undefined && p.price > Number(query.maxPrice)) continue;
    if (query.maxW !== undefined && p.dims.w > Number(query.maxW)) continue;
    if (query.maxD !== undefined && p.dims.d > Number(query.maxD)) continue;
    if (query.maxH !== undefined && p.dims.h > Number(query.maxH)) continue;
    const nameWords = fold(p.name).split(/[^a-z0-9]+/).filter(Boolean);
    const otherWords = fold([p.category.replace('_', ' '), ...p.styleTags, ...p.colours, p.sku].join(' ')).split(/[^a-z0-9]+/).filter(Boolean);
    let score = 0;
    let all = true;
    for (const t of tokens) {
      if (nameWords.some((w) => w.startsWith(t))) score += 2;
      else if (otherWords.some((w) => w.startsWith(t))) score += 1;
      else {
        all = false;
        break;
      }
    }
    if (all) scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.p.price - b.p.price || (a.p.sku < b.p.sku ? -1 : a.p.sku > b.p.sku ? 1 : 0));
  return { matches: scored.slice(0, limit).map((s) => s.p), truncated: scored.length > limit };
}
