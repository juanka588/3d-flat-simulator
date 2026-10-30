import { z } from 'zod';
import { Dims, HttpUrl, IsoDateTime, Lumens, PROVIDER_ID_RE, Price, ProductName, ProviderId, SKU_MAX, Sku, stripControlChars } from './primitives';

/**
 * M5 product contracts (story M5.0). A PRODUCT is a real, purchasable thing sold by a provider
 * (IKEA FR, a pasted URL, the in-memory `mock` provider). Provider code lives in `apps/server` only;
 * everything in this file is plain JSON that crosses the HTTP / MCP boundary.
 *
 * Three levels, from richest to smallest (only `ProductSnapshot` lives here; the record, summary and API schemas are in `assets/products/`):
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
  'curtain',
  'plant',
  'vase',
  'frame',
  'cushion',
  'throw',
  'wall_cabinet',
  'kitchen',
  'appliance',
  'decor',
  'other',
  // Bathroom / kitchen / storage kinds the shop types tell apart (appended: older records and snapshots stay valid).
  'washbasin',
  'vanity',
  'towel_rail',
  'bath_accessory',
  'shower_curtain',
  'kitchen_island',
  'tall_cabinet',
  'appliance_housing',
  'hook',
  'storage',
  'radiator',
] as const;
/** Coarse furniture category; lookalike picking and generators key on it. */
export const ProductCategory = z.enum(PRODUCT_CATEGORIES);
export type ProductCategory = z.infer<typeof ProductCategory>;

/** Where the dimensions came from: provider data fields, parsed from text, typed by the user, or derived by a model (the local catalogue build takes a missing sofa height from the product's own 3D model). */
export const DimsSource = z.enum(['structured', 'text', 'user', 'model']);
export type DimsSource = z.infer<typeof DimsSource>;


/** ISO 4217 currency code. */
export const Currency = z.string().regex(/^[A-Z]{3}$/, 'expected an ISO 4217 code like "EUR"');

/** Weight (kg) above which a wall-mounted product counts as heavy (D7: structural walls only). */
export const HEAVY_MOUNT_KG = 15;

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
  /** When these facts were read from the provider (staleness: the bill of materials flags > 30 days). */
  snapshotAt: IsoDateTime,
  /** Chosen colour, when the product has several. */
  colour: z.string().min(1).max(40).optional(),
  /** Bulb flux in lumens, for lamps whose page states it; the lamp's light uses it ("product" source). */
  lumens: Lumens.optional(),
});
export type ProductSnapshot = z.infer<typeof ProductSnapshot>;


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
