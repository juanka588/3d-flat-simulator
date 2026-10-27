import { ProductRecord, type ProductVariant } from '@flat/scene';
import { IKEA_FR_META } from './catalog';
import { readTextCapped } from './http';
import { categoryOf, fold, WALL_CATEGORIES } from './category';
import { asArray, asPrice, extractJsonLd, hasType, isObj, str, type Json } from './jsonld';
import { htmlToText, parseLumens } from './lumens';
import { ProviderError, type ModelStream, type ProductProvider, type ProviderContext, type SearchOptions } from './types';
import { parseLength, parseMeasureText } from './units';

/**
 * IKEA France connector (M5.7), PERSONAL USE ONLY, undocumented endpoints that may break without notice.
 *
 *  - search:   GET sik.search.blue.cdtapps.com/fr/fr/search-result-page?q=..&size=..&types=PRODUCT
 *              (price = `product.salesPrice.numeral` in `salesPrice.currencyCode`, TTC EUR; `itemMeasureReferenceText` = "77x147 cm", only 2 dims)
 *  - product:  GET www.ikea.com/fr/fr/p/<slug>-<sku>/ -> JSON-LD `Product` (width/depth/height as "76.5 cm", offers.priceSpecification),
 *              `3DModel` (encodings on web-api.ikea.com/dimma/assets) and the measurement section. Package boxes are NOT the item size.
 *  - model:    GET web-api.ikea.com/dimma/assets/1.2/<sku>/<set>/<iqpN>/glb_draco/<hash>-<file>.glb (HEAD is blocked by the CDN)
 * Colours are separate articles (separate sku, page and GLB).
 */

export const IKEA_FR_ID = IKEA_FR_META.id;
const SITE = 'https://www.ikea.com/fr/fr';
const SEARCH_URL = 'https://sik.search.blue.cdtapps.com/fr/fr/search-result-page';
const ASSET_BASE = 'https://web-api.ikea.com/dimma/assets/';
const PAGE_MAX_BYTES = 4 * 1024 * 1024;
const SEARCH_MAX_BYTES = 2 * 1024 * 1024;
export const MODEL_MAX_BYTES = 20 * 1024 * 1024;
/** Product pages fetched by one search call at most (each costs one polite request). */
const ENRICH_MAX = 8;
const TTL_HIT_MS = 10 * 60_000;
const TTL_PRODUCT_MS = 60 * 60_000;

const CAPABILITIES = IKEA_FR_META.capabilities;

// ---------------------------------------------------------------------------------------------
// URL allow-lists: nothing the (undocumented, tamperable) IKEA JSON says is fetched unless it points at IKEA
// ---------------------------------------------------------------------------------------------

const PAGE_HOST = 'www.ikea.com';
const PAGE_PATH = '/fr/fr/p/';
/** Hosts a photo or a model may come from. */
const ASSET_HOSTS: ReadonlySet<string> = new Set(['www.ikea.com', 'web-api.ikea.com']);

function parseHttps(raw: string | undefined): URL | undefined {
  if (!raw || raw.length > 2048) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return undefined;
  return u;
}

/** A product page URL: `https://www.ikea.com/fr/fr/p/...` and nothing else (no other host, port, credentials or path). */
export function safePageUrl(raw: string | undefined): string | undefined {
  const u = parseHttps(raw);
  if (!u || u.hostname !== PAGE_HOST || !u.pathname.startsWith(PAGE_PATH)) return undefined;
  u.hash = '';
  return u.href;
}

/** A photo URL on an IKEA host (https, no port or credentials). */
export function safeAssetUrl(raw: string | undefined): string | undefined {
  const u = parseHttps(raw);
  return u && ASSET_HOSTS.has(u.hostname) ? u.href : undefined;
}

/** The page URL of an article: the (validated) one the search gave, else rebuilt from the article number. */
const pageUrlOf = (sku: string, candidate?: string) => {
  const safe = safePageUrl(candidate);
  return safe && new URL(safe).pathname.replace(/\/$/, '').endsWith(`-${sku}`) ? safe : `${SITE}/p/-${sku}/`;
};

// ---------------------------------------------------------------------------------------------
// Search response
// ---------------------------------------------------------------------------------------------

export interface IkeaHit {
  sku: string;
  name: string;
  typeName: string;
  measureText: string;
  price: number;
  currency: string;
  url: string;
  photoUrl?: string;
  colours: string[];
  categoryPath: string[];
  variants: ProductVariant[];
}

const fail = (selector: string, what = 'not found') =>
  new ProviderError('provider_parse_failed', `IKEA page structure changed: ${selector} ${what}`, {
    hint: `The IKEA page or API changed (${selector} ${what}); use another product or provider.`,
    details: { selector },
  });

/** `search-result-page` JSON -> hits. Throws `provider_parse_failed` naming the missing selector. */
export function parseSearchResponse(json: unknown): IkeaHit[] {
  const items = (((json as Json | undefined)?.['searchResultPage'] as Json | undefined)?.['products'] as Json | undefined)?.['main'];
  const list = (items as Json | undefined)?.['items'];
  if (!Array.isArray(list)) throw fail('searchResultPage.products.main.items', 'is not an array');
  const hits: IkeaHit[] = [];
  for (const [i, it] of list.entries()) {
    const p = isObj(it) ? it['product'] : undefined;
    if (!isObj(p)) continue; // banners and breakouts have no product
    const sku = str(p['itemNoGlobal']) ?? str(p['id']);
    const sp = p['salesPrice'];
    const price = isObj(sp) ? asPrice(sp['numeral']) : undefined;
    const pipUrl = str(p['pipUrl']);
    if (!sku || !/^\d{8}$/.test(sku) || !pipUrl) throw fail(`searchResultPage.products.main.items[${i}].product.{id,pipUrl}`);
    if (price === undefined) throw fail(`searchResultPage.products.main.items[${i}].product.salesPrice.numeral`);
    const name = str(p['name']) ?? '';
    const typeName = str(p['typeName']) ?? '';
    const colours = asArray(p['colors'] as unknown[]).flatMap((c) => (isObj(c) && str(c['name']) ? [str(c['name'])!] : []));
    const cats = asArray(p['categoryPath'] as unknown[]).flatMap((c) => (isObj(c) && str(c['name']) ? [str(c['name'])!] : []));
    const variants: ProductVariant[] = [];
    const gpr = p['gprDescription'];
    for (const v of isObj(gpr) ? asArray(gpr['variants'] as unknown[]) : []) {
      if (!isObj(v)) continue;
      const vsku = str(v['id']);
      if (!vsku || vsku === sku || variants.length >= 20) continue;
      const vp = isObj(v['salesPrice']) ? asPrice(v['salesPrice']['numeral']) : undefined;
      const colour = colourFromAlt(str(v['imageAlt']));
      const vurl = safePageUrl(str(v['pipUrl']));
      variants.push({
        sku: vsku,
        ...(colour ? { colour } : {}),
        ...(vp !== undefined ? { price: vp } : {}),
        ...(vurl ? { url: vurl } : {}),
      });
    }
    hits.push({
      sku,
      name,
      typeName,
      measureText: str(p['itemMeasureReferenceText']) ?? '',
      price,
      currency: isObj(sp) ? (str(sp['currencyCode']) ?? 'EUR') : 'EUR',
      url: pageUrlOf(sku, pipUrl),
      ...(safeAssetUrl(str(p['mainImageUrl'])) ? { photoUrl: safeAssetUrl(str(p['mainImageUrl']))! } : {}),
      colours,
      categoryPath: cats,
      variants,
    });
  }
  return hits;
}

/** `"KALLAX Étagère, effet chêne blanchi, 77x147 cm"` -> `"effet chêne blanchi"`. */
function colourFromAlt(alt: string | undefined): string | undefined {
  if (!alt) return undefined;
  const parts = alt.split(',').map((s) => s.trim());
  if (parts.length < 3) return undefined;
  const c = parts.slice(1, -1).join(', ');
  return c.length > 0 && c.length <= 40 ? c : undefined;
}

// ---------------------------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------------------------


// ---------------------------------------------------------------------------------------------
// Product page
// ---------------------------------------------------------------------------------------------

const ROW_RE = /measurement-name">([^<]+)<\/span><span class="[^"]*measurement-value">([^<]+)<\/span>/g;

/** Assembled width/depth/height from the "Dimensions" rows of the page (`Largeur`, `Profondeur`, `Hauteur`, `Longueur`). */
export function parseMeasurementRows(html: string): Partial<Record<'w' | 'd' | 'h' | 'length', number>> {
  const out: Partial<Record<'w' | 'd' | 'h' | 'length', number>> = {};
  for (const m of html.matchAll(ROW_RE)) {
    const label = fold(m[1]!.trim());
    const v = parseLength(m[2]!, 'cm');
    if (v === undefined) continue;
    if (label === 'largeur') out.w ??= v;
    else if (label === 'profondeur') out.d ??= v;
    else if (label === 'hauteur') out.h ??= v;
    else if (label === 'longueur') out.length ??= v;
  }
  return out;
}

/** Sum of the weights of all packages (kg), from the embedded `"packages":[...]` JSON. Package data, not the assembled weight. */
export function parsePackageWeightKg(html: string): number | undefined {
  const at = html.indexOf('"packages":[');
  if (at < 0) return undefined;
  const start = html.indexOf('[', at);
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      if (--depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return undefined;
  let packages: unknown;
  try {
    packages = JSON.parse(html.slice(start, end + 1));
  } catch {
    return undefined;
  }
  let total = 0;
  for (const pkg of asArray(packages as unknown[])) {
    if (!isObj(pkg)) continue;
    const qty = isObj(pkg['quantity']) && typeof pkg['quantity']['value'] === 'number' ? pkg['quantity']['value'] : 1;
    for (const g of asArray(pkg['measurementGroups'] as unknown[])) {
      for (const m of isObj(g) ? asArray(g['measurements'] as unknown[]) : []) {
        if (isObj(m) && m['type'] === 'weight' && typeof m['value'] === 'number') total += m['value'] * qty;
      }
    }
  }
  return total > 0 ? Math.round(total * 100) / 100 : undefined;
}

/** The smallest interactive Draco GLB of a `3DModel` block, as a path below the asset base (the opaque `modelRef`). */
export function pickModelRef(node: Json | undefined): string | undefined {
  if (!node) return undefined;
  const urls = asArray(node['encoding'] as unknown[]).flatMap((e) => (isObj(e) && str(e['contentUrl']) ? [str(e['contentUrl'])!] : []));
  const rank = (u: string): number | undefined => {
    if (!u.startsWith(ASSET_BASE) || !/\.glb(\?|$)/.test(u) || modelUrlOf(u.slice(ASSET_BASE.length)) === undefined) return undefined;
    const lod = /\/(iqp|rqp)(\d)\//.exec(u);
    const draco = u.includes('/glb_draco/');
    if (!lod) return draco ? 50 : 60;
    // Interactive quality first (iqp1 is the lightest: 0.5 MB vs 1.2 / 2.1 MB for iqp2 / iqp3), then render quality.
    return (lod[1] === 'iqp' ? 0 : 20) + (draco ? 0 : 10) + Number(lod[2]);
  };
  const ranked = urls.flatMap((u) => {
    const r = rank(u);
    return r === undefined ? [] : [{ u, r }];
  });
  ranked.sort((a, b) => a.r - b.r);
  const best = ranked[0]?.u;
  return best ? best.slice(ASSET_BASE.length) : undefined;
}

const MODEL_REF_RE = /^[A-Za-z0-9._+/-]+\.glb(\?cn=pip)?$/;
/** The only URL shape `fetchModel` will request: the IKEA asset CDN, `.glb`, no traversal. */
export function modelUrlOf(modelRef: string): string | undefined {
  return MODEL_REF_RE.test(modelRef) && !modelRef.includes('..') ? ASSET_BASE + modelRef : undefined;
}

export interface ParsePageOptions {
  sku: string;
  pageUrl: string;
  fetchedAt: string;
  /** The search hit of this article, when known: fallback price, URL, photo, variants and the 2-dim measure text. */
  hit?: IkeaHit;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Product page HTML -> `ProductRecord`. Throws `provider_parse_failed` (failing selector) or `product_dims_missing` (partial dims in `details`). */
export function parseProductPage(html: string, o: ParsePageOptions): ProductRecord {
  const { nodes, blocks } = extractJsonLd(html);
  if (blocks === 0) throw fail('script[type="application/ld+json"]');
  const product = nodes.find((n) => hasType(n, 'Product'));
  if (!product) throw fail('script[type="application/ld+json"] @type=Product');

  const name = str(product['name']) ?? (o.hit ? `${o.hit.name} ${o.hit.typeName}`.trim() : undefined);
  if (!name) throw fail('Product.name');

  // Price: offers.priceSpecification (first one that is not the strikethrough "was" price) or offers.price; else the search hit's.
  let price: number | undefined;
  let currency: string | undefined;
  for (const offer of asArray(product['offers'] as unknown[])) {
    if (!isObj(offer)) continue;
    for (const spec of asArray(offer['priceSpecification'] as unknown[])) {
      if (!isObj(spec) || (typeof spec['priceType'] === 'string' && /Strikethrough|List/i.test(spec['priceType']))) continue;
      price ??= asPrice(spec['price']);
      currency ??= str(spec['priceCurrency']);
    }
    price ??= asPrice(offer['price']);
    currency ??= str(offer['priceCurrency']);
  }
  if (price === undefined && o.hit) {
    price = o.hit.price;
    currency = o.hit.currency;
  }
  if (price === undefined) throw fail('Product.offers.priceSpecification[].price');

  // Assembled dimensions (NOT the package boxes): JSON-LD fields, then the page's dimension rows.
  const ld = {
    w: typeof product['width'] === 'string' ? parseLength(product['width'], 'cm') : undefined,
    d: typeof product['depth'] === 'string' ? parseLength(product['depth'], 'cm') : undefined,
    h: typeof product['height'] === 'string' ? parseLength(product['height'], 'cm') : undefined,
  };
  const rows = parseMeasurementRows(html);
  const w = ld.w ?? rows.w;
  const d = ld.d ?? rows.d ?? rows.length;
  const h = ld.h ?? rows.h;
  if (w === undefined || d === undefined || h === undefined) {
    const known: Record<string, number> = {};
    if (w !== undefined) known['w'] = w;
    if (d !== undefined) known['d'] = d;
    if (h !== undefined) known['h'] = h;
    const text = o.hit?.measureText || '';
    const fromText = parseMeasureText(text);
    const labels = { w: 'width', d: 'depth', h: 'height' } as const;
    const missing = (['w', 'd', 'h'] as const).filter((k) => known[k] === undefined).map((k) => labels[k]);
    const knownTxt = Object.entries(known).map(([k, v]) => `${labels[k as 'w']} ${round3(v * 100)} cm`);
    throw new ProviderError(
      'product_dims_missing',
      `IKEA ${o.sku}: assembled ${missing.join(' and ')} unknown${knownTxt.length ? ` (known: ${knownTxt.join(', ')})` : ''}${text ? `; listing says "${text}"` : ''}`,
      {
        hint: `IKEA lists only ${text ? `"${text}"` : 'some dimensions'} for this article; ask the user for the missing ${missing.join(' and ')} (metres) and keep dimsSource "user".`,
        details: { dimsSource: 'text', knownDims: known, missing, measureText: text, textDimsM: fromText },
      },
    );
  }

  const modelRef = pickModelRef(nodes.find((n) => hasType(n, '3DModel')));
  const mpnSku = (str(product['sku']) ?? str(product['mpn']) ?? '').replace(/\D/g, '');
  const sku = /^\d{8}$/.test(mpnSku) ? mpnSku : o.sku;
  const byType = categoryOf(o.hit?.typeName ?? '', [str(product['category']) ?? '', ...(o.hit?.categoryPath ?? [])]);
  const finalCategory = byType === 'other' ? categoryOf(name) : byType;
  // Lamps: the bulb flux when the page states it (else the viewer uses a default for the kind of lamp).
  const lumens = finalCategory === 'lamp' ? parseLumens(`${str(product['description']) ?? ''} ${htmlToText(html)}`) : undefined;
  const colour = str(product['color']);
  const colours = colour ? [colour.slice(0, 40)] : (o.hit?.colours.map((c) => c.slice(0, 40)) ?? []);
  const imgs = asArray(product['image'] as unknown[]);
  const first = imgs[0];
  const photoUrl = safeAssetUrl(typeof first === 'string' ? first : isObj(first) ? str(first['contentUrl']) : undefined) ?? o.hit?.photoUrl;
  const weightKg = parsePackageWeightKg(html);
  const offerUrl = asArray(product['offers'] as unknown[]).flatMap((x) => (isObj(x) && str(x['url']) ? [str(x['url'])!] : []))[0];
  const url = safePageUrl(str(product['url'])) ?? safePageUrl(offerUrl) ?? safePageUrl(o.hit?.url) ?? pageUrlOf(o.sku, o.pageUrl);

  const parsed = ProductRecord.safeParse({
    provider: IKEA_FR_ID,
    sku,
    name: name.slice(0, 200),
    url,
    price,
    currency: currency ?? 'EUR',
    priceTtc: true, // IKEA FR shelf prices are TTC
    dims: { w, d, h },
    dimsSource: 'structured',
    category: finalCategory,
    mount: WALL_CATEGORIES.has(finalCategory) ? 'wall' : 'floor',
    styleTags: [],
    colours: colours.slice(0, 8),
    variants: o.hit?.variants ?? [],
    ...(weightKg !== undefined ? { weightKg, weightKind: 'package' } : {}),
    ...(lumens !== undefined ? { lumens } : {}),
    ...(photoUrl ? { photoUrl } : {}),
    ...(modelRef ? { modelRef } : {}),
    fetchedAt: o.fetchedAt,
    personalUseOnly: true,
  });
  if (!parsed.success) throw fail('ProductRecord', `invalid (${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message})`);
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

export interface IkeaFrOptions {
  /** Product pages fetched by one search at most (default 8). */
  enrichMax?: number;
}

export function createIkeaFrProvider(options: IkeaFrOptions = {}): ProductProvider {
  const enrichMax = options.enrichMax ?? ENRICH_MAX;
  const inflight = new Map<string, Promise<ProductRecord>>();

  async function getRecord(sku: string, ctx: ProviderContext): Promise<ProductRecord> {
    if (!/^\d{8}$/.test(sku)) throw new ProviderError('product_not_found', `IKEA article numbers have 8 digits (got "${sku}")`);
    const cached = ctx.cache.get<ProductRecord>(`product:${sku}`);
    if (cached) return cached;
    const running = inflight.get(sku);
    if (running) return running;
    const p = (async () => {
      const hit = ctx.cache.get<IkeaHit>(`hit:${sku}`);
      // `/p/-<sku>/` redirects to the canonical slug page.
      const pageUrl = pageUrlOf(sku, hit?.url); // never a URL taken as-is from a response
      const res = await ctx.fetch(pageUrl, { headers: { accept: 'text/html', 'accept-language': 'fr-FR,fr;q=0.9' }, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError('product_not_found', `IKEA FR has no article ${sku}`);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError('provider_unavailable', `IKEA product page answered ${res.status}`);
      }
      const html = await readTextCapped(res, PAGE_MAX_BYTES);
      const record = parseProductPage(html, {
        sku,
        pageUrl: res.url || pageUrl,
        fetchedAt: new Date(ctx.clock.now()).toISOString(),
        ...(hit ? { hit } : {}),
      });
      ctx.cache.set(`product:${sku}`, record, TTL_PRODUCT_MS, 4096);
      return record;
    })().finally(() => inflight.delete(sku));
    inflight.set(sku, p);
    return p;
  }

  return {
    id: IKEA_FR_ID,
    label: IKEA_FR_META.label,
    capabilities: CAPABILITIES,
    personalUseOnly: IKEA_FR_META.personalUseOnly,
    ...(IKEA_FR_META.note ? { note: IKEA_FR_META.note } : {}),

    async search(query: string, opts: SearchOptions, ctx: ProviderContext): Promise<ProductRecord[]> {
      const q = query.trim();
      if (q === '') return [];
      const size = Math.min(48, Math.max(opts.limit * 2, 12));
      const key = `search:${q.toLowerCase()}|${size}`;
      let hits = ctx.cache.get<IkeaHit[]>(key);
      if (!hits) {
        const url = `${SEARCH_URL}?${new URLSearchParams({ q, size: String(size), types: 'PRODUCT' })}`;
        const res = await ctx.fetch(url, { headers: { accept: 'application/json' }, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new ProviderError('provider_unavailable', `IKEA search answered ${res.status}`);
        }
        let json: unknown;
        try {
          json = JSON.parse(await readTextCapped(res, SEARCH_MAX_BYTES));
        } catch (e) {
          if (e instanceof ProviderError) throw e;
          throw fail('search response', 'is not JSON');
        }
        hits = parseSearchResponse(json);
        ctx.cache.set(key, hits, TTL_HIT_MS, 64 * 1024);
      }
      for (const h of hits) ctx.cache.set(`hit:${h.sku}`, h, TTL_PRODUCT_MS, 1024);

      const candidates = hits.filter((h) => {
        if (opts.category !== undefined && categoryOf(h.typeName, h.categoryPath) !== opts.category) return false;
        if (opts.minPrice !== undefined && h.price < opts.minPrice) return false;
        if (opts.maxPrice !== undefined && h.price > opts.maxPrice) return false;
        return true;
      });
      const out: ProductRecord[] = [];
      let fetched = 0;
      let firstFailure: ProviderError | undefined;
      for (const h of candidates) {
        if (out.length >= opts.limit) break;
        const warm = ctx.cache.get<ProductRecord>(`product:${h.sku}`) !== undefined;
        if (!warm && fetched >= enrichMax) break;
        try {
          if (!warm) fetched++;
          const rec = await getRecord(h.sku, ctx);
          const m = opts.maxDims;
          if (m && ((m.w !== undefined && rec.dims.w > m.w) || (m.d !== undefined && rec.dims.d > m.d) || (m.h !== undefined && rec.dims.h > m.h))) continue;
          out.push(rec);
        } catch (e) {
          if (!(e instanceof ProviderError)) throw e;
          if (e.code === 'product_dims_missing' || e.code === 'product_not_found') {
            ctx.log('warn', `ikea-fr: skipped ${h.sku}: ${e.message}`);
            continue;
          }
          if (e.code === 'provider_parse_failed') {
            firstFailure ??= e;
            continue;
          }
          if (out.length === 0) throw e; // blocked / unavailable / robots: nothing to show
          break;
        }
      }
      if (out.length === 0 && firstFailure) throw firstFailure;
      return out;
    },

    get: getRecord,

    async fetchPhoto(rec: ProductRecord, ctx: ProviderContext): Promise<ModelStream> {
      const url = safeAssetUrl(rec.photoUrl);
      if (!url) throw new ProviderError('product_not_found', `IKEA ${rec.sku} has no photo on an IKEA host`);
      const res = await ctx.fetch(url, { headers: { accept: 'image/avif,image/webp,image/*' }, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError(res.status === 404 || res.status === 410 ? 'product_not_found' : 'provider_unavailable', `IKEA photo answered ${res.status}`);
      }
      const len = Number(res.headers.get('content-length'));
      return { stream: res.body, contentType: 'image/*', ...(Number.isFinite(len) && len > 0 ? { size: len } : {}) };
    },

    async fetchModel(sku: string, ctx: ProviderContext): Promise<ModelStream> {
      const rec = await getRecord(sku, ctx);
      const url = rec.modelRef ? modelUrlOf(rec.modelRef) : undefined;
      if (!url) throw new ProviderError('model_unavailable', `IKEA ${sku} has no 3D model on its page`);
      const res = await ctx.fetch(url, { headers: { accept: 'model/gltf-binary,*/*' }, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError('model_unavailable', `IKEA model for ${sku} answered ${res.status}`);
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError('provider_unavailable', `IKEA model download answered ${res.status}`);
      }
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > MODEL_MAX_BYTES) {
        await res.body.cancel().catch(() => undefined);
        throw new ProviderError('model_unavailable', `IKEA model for ${sku} is ${len} bytes (limit ${MODEL_MAX_BYTES})`);
      }
      return { stream: res.body, contentType: 'model/gltf-binary', ...(Number.isFinite(len) && len > 0 ? { size: len } : {}) };
    },
  };
}

export default createIkeaFrProvider;
