import { z } from 'zod';
import { HttpUrl, IsoDateTime, ProductCategory, ProductId, ProviderId, stripControlChars } from '@flat/scene';
import { ProductRecord, ProductSource, ProductSummary } from './records';

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
  /** Also ask the live shop even when the local catalogue has enough results (default: live only as a fallback). */
  live: z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')]).optional(),
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

/** The local catalogue, when one is loaded (`GET /api/providers`). */
export const LocalCatalogInfo = z.strictObject({
  /** Provider id of the local tier, `ikea-fr-local`. */
  id: ProviderId,
  count: z.number().int().nonnegative(),
  withModels: z.number().int().nonnegative(),
  builtAt: IsoDateTime,
  /** The newest record is older than `LOCAL_STALE_DAYS`. */
  stale: z.boolean(),
});
export type LocalCatalogInfo = z.infer<typeof LocalCatalogInfo>;

export const ProvidersResponse = z.strictObject({ providers: z.array(ProviderInfo), localCatalog: LocalCatalogInfo.optional() });
export type ProvidersResponse = z.infer<typeof ProvidersResponse>;

export const GetProductResponse = z.strictObject({ product: ProductRecord, source: ProductSource.optional(), stale: z.literal(true).optional() });
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
