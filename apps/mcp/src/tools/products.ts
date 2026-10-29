import { GENERATORS, PRODUCT_CATEGORIES, ProductCategory, ProductId } from '@flat/scene';
import { type ProductRecord, type ProductSummary } from '@flat/assets';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { assetThumb, cc0Assets } from '../assetCatalog';
import { apiFailure, toolError, toolOk } from '../errors';
import { MAX_THUMBS, PHOTO_MAX_SIDE, THUMB_MAX_SIDE, pictureContent } from '../imageContent';
import type { RawImage } from '../render/shrink';
import { READ, obj, parseArgs } from './common';
import type { ToolContext, ToolDef } from './registry';

/**
 * Product read tools (M5.11, D9). Everything a retailer is asked is asked by the SCENE SERVER; these
 * tools only call its `/api/providers`, `/api/products/*` routes. Every product id that a search or a
 * get returns is registered with the server's seen-products registry for THIS MCP session
 * (`POST /api/products/seen`): `place_item` refuses ids that were never returned here (`unknown_product`).
 *
 * Output budgets (chars/4 ~ tokens): `search_products` <= 2.5k tokens at 12 results, `get_product` <= 1.2k.
 */

export const MAX_SEARCH_RESULTS = 12;
const DEFAULT_SEARCH_RESULTS = 8;

const round = (n: number, digits = 3): number => Math.round(n * 10 ** digits) / 10 ** digits;
const dimsOf = (d: { w: number; d: number; h: number }) => ({ w: round(d.w), d: round(d.d), h: round(d.h) });

const MAX_URL_CHARS = 300;
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
/** Shop text is data a seller controls: a long URL (a place to hide text for the model) is replaced by its host. */
function urlFacts(url: string): { url: string } | { urlHost: string } {
  if (url.length <= MAX_URL_CHARS) return { url };
  try {
    return { urlHost: new URL(url).hostname };
  } catch {
    return { urlHost: '' };
  }
}

/** Registers ids as seen by this session; the failure result when the server cannot (placing would then be refused). */
export async function markSeen(ctx: ToolContext, ids: readonly string[]): Promise<CallToolResult | undefined> {
  if (ids.length === 0) return undefined;
  const r = await ctx.flat.markProductsSeen(ctx.session.id, ids);
  return r.ok ? undefined : apiFailure(r);
}

const rateLimited = (ctx: ToolContext, bucket: 'searches' | 'productGets', what: string, perMinute: number): CallToolResult | undefined => {
  const t = ctx.session[bucket].take();
  return t.ok ? undefined : toolError('rate_limited', `more than ${perMinute} ${what} per minute`, `Wait ${t.retryAfterMs} ms and retry; narrow the search (category, price, size) instead of repeating it.`, { retryAfterMs: t.retryAfterMs });
};

/** The photo of a product as raw bytes (local catalogue file or the server's photo proxy); `undefined` when there is none. Kept in memory only. */
export async function productPhoto(ctx: ToolContext, productId: string): Promise<RawImage | undefined> {
  const r = await ctx.flat.getProductPhoto(productId);
  return r.ok && r.data.status === 200 && r.data.body.length > 0 ? { data: r.data.body, contentType: r.data.contentType } : undefined;
}

/** Labelled photos for `ids`, fetched in parallel, in order; the ones without a photo are dropped. */
export async function productPictures(ctx: ToolContext, ids: readonly string[], maxSide: number): Promise<{ content: CallToolResult['content']; shown: number; missing: string[] }> {
  const raws = await Promise.all(ids.map((id) => productPhoto(ctx, id)));
  const have = ids.flatMap((id, i) => (raws[i] ? [{ label: `photo ${id}`, raw: raws[i]! }] : []));
  const { content, skipped } = await pictureContent(have, maxSide);
  return { content, shown: have.length - skipped.length, missing: [...ids.filter((_, i) => !raws[i]), ...skipped.map((l) => l.slice(6))] };
}

/** One compact line of a search result. */
function searchLine(p: ProductSummary) {
  return {
    productId: p.productId,
    name: clip(p.name, 120),
    price: p.price,
    currency: p.currency,
    ...(p.priceTtc ? {} : { priceTtc: false }),
    dims: dimsOf(p.dims),
    ...(p.dimsSource === 'structured' ? {} : { dimsSource: p.dimsSource }),
    category: p.category,
    ...(p.mount === 'floor' ? {} : { mount: p.mount }),
    colours: p.colours.map((c) => clip(c, 40)),
    has3d: p.has3d,
    ...(p.personalUseOnly ? { personalUse: true } : {}),
    ...(p.source ? { source: p.source } : {}),
    ...(p.fetchedAt ? { fetchedAt: p.fetchedAt.slice(0, 10) } : {}),
    ...(p.stale ? { stale: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// list_providers
// ---------------------------------------------------------------------------------------------

const listProviders: ToolDef = {
  name: 'list_providers',
  description:
    'List the product providers (shops): id, label, enabled, capabilities (search, 3D model, dimension quality, pasted URLs), circuit state (open = paused after blocks; retryAt), personal-use flag. ikea-fr-local is the local catalogue (searched first; localCatalog = size and date). Call it before search_products.',
  inputSchema: obj({}),
  annotations: READ,
  group: 'read',
  mutatesScene: false,
  async handler(ctx, args) {
    const a = parseArgs(z.strictObject({}), args);
    if (!a.ok) return a.result;
    const r = await ctx.flat.listProviders();
    if (!r.ok) return apiFailure(r);
    return toolOk({
      ok: true,
      providers: r.data.providers.map((p) => ({
        id: p.id,
        label: p.label,
        enabled: p.enabled,
        circuit: p.circuit,
        ...(p.retryAt !== undefined ? { retryAt: p.retryAt } : {}),
        capabilities: p.capabilities,
        personalUseOnly: p.personalUseOnly,
        ...(p.note ? { note: p.note } : {}),
      })),
      ...(r.data.localCatalog ? { localCatalog: { id: r.data.localCatalog.id, products: r.data.localCatalog.count, withModels: r.data.localCatalog.withModels, builtAt: r.data.localCatalog.builtAt.slice(0, 10), ...(r.data.localCatalog.stale ? { stale: true } : {}) } } : {}),
    });
  },
};

// ---------------------------------------------------------------------------------------------
// search_products
// ---------------------------------------------------------------------------------------------

const SearchArgs = z.strictObject({
  query: z.string().max(200),
  provider: z.string().min(1).max(32).optional(),
  category: ProductCategory.optional(),
  maxPrice: z.number().min(0).max(1_000_000).optional(),
  maxWidth: z.number().positive().max(20).optional(),
  maxDepth: z.number().positive().max(20).optional(),
  maxHeight: z.number().positive().max(20).optional(),
  colour: z.string().min(1).max(40).optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
  live: z.boolean().optional(),
  thumbs: z.boolean().optional(),
});

const searchProducts: ToolDef = {
  name: 'search_products',
  description:
    `Search real, purchasable furniture: the local catalogue first (instant, offline), the live shop only if it has fewer than limit results or live:true. Returns at most ${MAX_SEARCH_RESULTS} compact results (productId, name, TTC price, assembled dims w x d x h in metres, colours, has3d = real 3D model, source local|live, fetchedAt, stale = price over 30 days old). ` +
    'The returned productIds are the only ones place_item accepts in this session. Filter by category, maxPrice and max width/depth/height (describe_room gives the room size) so results fit. Limited to 20 searches per minute.',
  inputSchema: obj(
    {
      query: { type: 'string', maxLength: 200, description: 'Words to look for, e.g. "bed 160", "oak desk". May be empty with a category.' },
      provider: { type: 'string', description: 'One provider id (list_providers); default all.' },
      category: { type: 'string', enum: [...PRODUCT_CATEGORIES], description: 'Furniture category.' },
      maxPrice: { type: 'number', minimum: 0, description: 'Highest TTC price, in the product currency (EUR for the shops here).' },
      maxWidth: { type: 'number', exclusiveMinimum: 0, description: 'Widest acceptable product, metres (item x).' },
      maxDepth: { type: 'number', exclusiveMinimum: 0, description: 'Deepest acceptable product, metres (item z).' },
      maxHeight: { type: 'number', exclusiveMinimum: 0, description: 'Tallest acceptable product, metres.' },
      colour: { type: 'string', maxLength: 40, description: 'Keep products that come in this colour (case-insensitive text match on the colour names).' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: `Results wanted, default ${DEFAULT_SEARCH_RESULTS}.` },
      live: { type: 'boolean', description: 'Also ask the live shop (10-20 s).' },
      thumbs: { type: 'boolean', description: `Add px photos (first ).` },
    },
    ['query'],
  ),
  annotations: { ...READ, readOnlyHint: true },
  group: 'read',
  mutatesScene: false,
  async handler(ctx, args) {
    const a = parseArgs(SearchArgs, args);
    if (!a.ok) return a.result;
    const q = a.data;
    const limited = rateLimited(ctx, 'searches', 'searches', ctx.limits.searchesPerMinute);
    if (limited) return limited;
    const limit = q.limit ?? DEFAULT_SEARCH_RESULTS;
    const colour = q.colour?.toLowerCase();
    const r = await ctx.flat.searchProducts({
      q: q.query,
      ...(q.provider ? { provider: q.provider } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.maxPrice !== undefined ? { maxPrice: q.maxPrice } : {}),
      ...(q.maxWidth !== undefined ? { maxW: q.maxWidth } : {}),
      ...(q.maxDepth !== undefined ? { maxD: q.maxDepth } : {}),
      ...(q.maxHeight !== undefined ? { maxH: q.maxHeight } : {}),
      ...(q.live !== undefined ? { live: q.live } : {}),
      // The server has no colour filter: ask for more and filter here.
      limit: colour ? Math.min(50, limit * 4) : limit,
    });
    if (!r.ok) return apiFailure(r);
    let results = r.data.results;
    if (colour) results = results.filter((p) => p.colours.some((c) => c.toLowerCase().includes(colour)));
    const truncated = r.data.truncated || results.length > limit;
    results = results.slice(0, limit);
    const failed = await markSeen(ctx, results.map((p) => p.productId));
    if (failed) return failed;
    const problems = r.data.providers.filter((p) => !p.ok).map((p) => ({ provider: p.provider, code: p.code ?? 'provider_unavailable', ...(p.message ? { message: p.message.slice(0, 160) } : {}) }));
    const warnings = r.data.providers.filter((p) => p.ok && p.message).map((p) => `${p.provider}: ${p.message!.slice(0, 200)}`);
    const pics = q.thumbs && results.length ? await productPictures(ctx, results.slice(0, MAX_THUMBS).map((p) => p.productId), THUMB_MAX_SIDE) : undefined;
    return toolOk(
      {
        ok: true,
        count: results.length,
        truncated,
        results: results.map(searchLine),
        ...(pics ? { thumbs: pics.shown, ...(pics.missing.length ? { noPhoto: pics.missing } : {}) } : {}),
        ...(problems.length ? { providerProblems: problems } : {}),
        ...(warnings.length ? { providerWarnings: warnings } : {}),
        note: results.length ? 'Prices are indicative TTC shelf prices. Next: get_product for variants and weight, then get_placement_options / place_item.' : 'No match: loosen the filters or try another provider (list_providers).',
      },
      pics?.content ?? [],
    );
  },
};

// ---------------------------------------------------------------------------------------------
// get_product
// ---------------------------------------------------------------------------------------------

/** The product facts the model may see (no photo, no model reference). */
export function productFacts(p: ProductRecord) {
  return {
    productId: `${p.provider}:${p.sku}`,
    name: clip(p.name, 120),
    ...urlFacts(p.url),
    price: p.price,
    currency: p.currency,
    priceTtc: p.priceTtc,
    dims: dimsOf(p.dims),
    dimsSource: p.dimsSource,
    category: p.category,
    mount: p.mount,
    ...(p.styleTags.length ? { styleTags: p.styleTags } : {}),
    colours: p.colours,
    ...(p.variants.length
      ? {
          variants: p.variants.map((v) => ({
            sku: v.sku,
            ...(v.name ? { name: v.name } : {}),
            ...(v.colour ? { colour: v.colour } : {}),
            ...(v.price !== undefined ? { price: v.price } : {}),
            ...(v.dims ? { dims: dimsOf(v.dims) } : {}),
          })),
        }
      : {}),
    ...(p.weightKg !== undefined ? { weightKg: p.weightKg, ...(p.weightKind ? { weightKind: p.weightKind } : {}) } : {}),
    has3d: p.modelRef !== undefined,
    fetchedAt: p.fetchedAt,
    ...(p.personalUseOnly ? { personalUseOnly: true } : {}),
  };
}

/** `productFacts` plus where the record came from (`local` catalogue snapshot or `live`) and whether a local price is stale (> 30 days). */
function factsWithSource(p: ProductRecord, source: string | undefined, stale: boolean | undefined) {
  return { ...productFacts(p), ...(source ? { source } : {}), ...(stale ? { stale: true } : {}) };
}

const getProduct: ToolDef = {
  name: 'get_product',
  description:
    'Full facts of one product from search_products: price (TTC), link, assembled dimensions, colours, variants (variants[].sku with own price and dims, for place_item variantSku), weightKg (wall mounts over 15 kg need a structural wall), has3d and when it was read. Use it for the few products you intend to place. Limited to 60 per minute.',
  inputSchema: obj(
    {
      productId: { type: 'string', description: 'productId from search_products, "<provider>:<sku>".' },
      photo: { type: 'boolean', description: `Add the photo (JPEG, px max).` },
    },
    ['productId'],
  ),
  annotations: READ,
  group: 'read',
  mutatesScene: false,
  async handler(ctx, args) {
    const a = parseArgs(z.strictObject({ productId: ProductId, photo: z.boolean().optional() }), args);
    if (!a.ok) return a.result;
    const limited = rateLimited(ctx, 'productGets', 'product reads', ctx.limits.productGetsPerMinute);
    if (limited) return limited;
    const r = await ctx.flat.getProduct(a.data.productId);
    if (!r.ok) return apiFailure(r);
    const failed = await markSeen(ctx, [a.data.productId]);
    if (failed) return failed;
    const pics = a.data.photo ? await productPictures(ctx, [a.data.productId], PHOTO_MAX_SIDE) : undefined;
    return toolOk({ ok: true, ...factsWithSource(r.data.product, r.data.source, r.data.stale), ...(pics && !pics.shown ? { photo: 'unavailable' } : {}) }, pics?.content ?? []);
  },
};

// ---------------------------------------------------------------------------------------------
// search_assets
// ---------------------------------------------------------------------------------------------

/** `{type:'number', minimum:0.7, maximum:2.4, default:1.6}` -> `"number 0.7..2.4 =1.6"`. */
function paramShort(schema: Record<string, unknown>): string {
  const def = schema.default;
  const tail = def !== undefined ? ` =${String(def)}` : '';
  if (Array.isArray(schema.enum)) return `${(schema.enum as unknown[]).join('|')}${tail}`;
  const lo = schema.minimum ?? schema.exclusiveMinimum;
  const hi = schema.maximum;
  const range = lo !== undefined || hi !== undefined ? ` ${lo ?? ''}..${hi ?? ''}` : '';
  return `${String(schema.type ?? 'any')}${range}${tail}`;
}

function generatorEntry(g: (typeof GENERATORS extends { list(): readonly (infer G)[] } ? G : never)) {
  const json = z.toJSONSchema(g.params, { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, Record<string, unknown>> };
  const params = Object.fromEntries(Object.entries(json.properties ?? {}).map(([k, v]) => [k, paramShort(v)]));
  const dims = g.describeParams(g.params.parse({})).dims;
  return { id: g.id, label: g.label, category: g.category, defaultDims: dimsOf(dims), params };
}

const SearchAssetsArgs = z.strictObject({
  category: ProductCategory.optional(),
  style: z.string().min(1).max(32).optional(),
  maxDims: z.strictObject({ w: z.number().positive().optional(), d: z.number().positive().optional(), h: z.number().positive().optional() }).optional(),
  limit: z.number().int().min(1).max(30).optional(),
  thumbs: z.boolean().optional(),
});

const searchAssets: ToolDef = {
  name: 'search_assets',
  description:
    'Find SHAPES (not products) for place_item\'s optional mesh argument: parametric generators with parameter ranges ({kind:"parametric", generator, params}; dims must match the product within 2%) and the CC0 model library ({kind:"lookalike", assetId}; scaled to the product, at most 25% distortion). Rarely needed: place_item picks the real model, else a lookalike, else a parametric shape itself.',
  inputSchema: obj({
    category: { type: 'string', enum: [...PRODUCT_CATEGORIES], description: 'Furniture category.' },
    style: { type: 'string', maxLength: 32, description: 'A style tag to prefer/filter, e.g. "wood", "modern" (library models).' },
    maxDims: {
      type: 'object',
      additionalProperties: false,
      properties: { w: { type: 'number', exclusiveMinimum: 0 }, d: { type: 'number', exclusiveMinimum: 0 }, h: { type: 'number', exclusiveMinimum: 0 } },
      description: 'Keep library models whose authored size fits this box (metres). Generators are resizable, so they are always kept.',
    },
    limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Library models wanted, default 12.' },
    thumbs: { type: 'boolean', description: `Add px thumbnails (first ).` },
  }),
  annotations: READ,
  group: 'read',
  mutatesScene: false,
  async handler(_ctx, args) {
    const a = parseArgs(SearchAssetsArgs, args);
    if (!a.ok) return a.result;
    const { category, style, maxDims, limit, thumbs } = a.data;
    const wantStyle = style?.toLowerCase();
    const parametric = GENERATORS.list()
      .filter((g) => category === undefined || g.category === category)
      .map(generatorEntry);
    const library = cc0Assets()
      .filter((m) => category === undefined || m.category === category)
      .filter((m) => !wantStyle || m.styleTags.some((t) => t.toLowerCase().includes(wantStyle)))
      .filter((m) => (maxDims?.w === undefined || m.nativeDims.w <= maxDims.w) && (maxDims?.d === undefined || m.nativeDims.d <= maxDims.d) && (maxDims?.h === undefined || m.nativeDims.h <= maxDims.h));
    const shown = library.slice(0, limit ?? 12);
    const withThumb = thumbs
      ? shown.slice(0, MAX_THUMBS).flatMap((m) => {
          const raw = assetThumb(m.id);
          return raw ? [{ label: `thumb ${m.id}`, raw }] : [];
        })
      : [];
    const pics = thumbs ? await pictureContent(withThumb, THUMB_MAX_SIDE) : undefined;
    return toolOk(
      {
        ok: true,
        parametric,
        library: shown.map((m) => ({ assetId: m.id, name: m.name, category: m.category, styleTags: m.styleTags, nativeDims: dimsOf(m.nativeDims), licence: m.licence })),
        ...(library.length > shown.length ? { libraryTruncated: library.length - shown.length } : {}),
        note: 'Local 3D-FUTURE models are not exposed by the scene server, so they are not listed.',
      },
      pics?.content ?? [],
    );
  },
};

export function productTools(): ToolDef[] {
  return [listProviders, searchProducts, getProduct, searchAssets];
}
