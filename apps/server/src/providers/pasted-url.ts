import { createHash } from 'node:crypto';
import { ProductRecord } from '@flat/assets';
import { PASTED_URL_META } from './catalog';
import { categoryOf, mountOf } from './category';
import { readTextCapped } from './http';
import { asArray, asPrice, extractJsonLd, hasType, isObj, str, type Json } from './jsonld';
import { checkPublicHost, dnsAll } from './ssrf';
import { ProviderError, type ModelStream, type ProductProvider, type ProviderContext } from './types';
import { lengthOf, parseLength } from './units';

/**
 * "Paste a product URL" provider (M5.8). One page, fetched on the user's request through the local server,
 * read as schema.org JSON-LD (`Product`, `3DModel`). No search; sites with bot protection fail clearly.
 *
 * SSRF guard (every hop, including redirects): https only, port 443, no credentials in the URL, a public
 * host (every DNS answer public; local names and private / loopback / link-local literals refused), no
 * redirect off the host (a `www.` swap is the only change allowed), at most 2 MB, no cookies.
 * The check is repeated on the connection itself: the registry gives this provider a DNS-pinned transport
 * (`pinned.ts`) whose `lookup` hook vets the address the socket actually connects to, so a rebinding answer
 * between the pre-check and the connect is refused (M6).
 */

export const PASTED_URL_ID = PASTED_URL_META.id;
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const MODEL_MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TTL_MS = 24 * 60 * 60_000;
export const BLOCKED_MESSAGE = 'This site blocks automated reads; enter the details by hand or pick another product';

const CAPABILITIES = PASTED_URL_META.capabilities;

const notAllowed = (message: string) => new ProviderError('url_not_allowed', message);
const blocked = (message = BLOCKED_MESSAGE, retryAt?: number) =>
  new ProviderError('provider_blocked', message, { hint: BLOCKED_MESSAGE, ...(retryAt !== undefined ? { retryAt } : {}) });

/** Stable key of a pasted URL (fragment dropped): the product sku `pasted-url:<hash>`. */
export function urlHash(url: string): string {
  const u = new URL(url);
  u.hash = '';
  return createHash('sha256').update(u.href).digest('hex').slice(0, 16);
}

/** Syntax rules of a pasted URL (before any DNS or network). Returns the parsed URL or throws `url_not_allowed`. */
export function validatePastedUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw notAllowed('not a valid URL');
  }
  if (u.protocol !== 'https:') throw notAllowed(`only https URLs can be read (got ${u.protocol.replace(':', '')})`);
  if (u.port !== '' && u.port !== '443') throw notAllowed(`only port 443 is allowed (got ${u.port})`);
  if (u.username !== '' || u.password !== '') throw notAllowed('URLs with credentials are refused');
  if (u.href.length > 2048) throw notAllowed('URL is longer than 2048 characters');
  u.hash = '';
  return u;
}

const stripWww = (h: string) => h.toLowerCase().replace(/^www\./, '');

// ---------------------------------------------------------------------------------------------
// Guarded GET (manual redirects, every hop checked)
// ---------------------------------------------------------------------------------------------

async function guardedGet(start: URL, ctx: ProviderContext, accept: string): Promise<{ res: Response; finalUrl: URL }> {
  const resolve = ctx.lookup ?? dnsAll;
  let url = start;
  const origin = start;
  for (let hop = 0; ; hop++) {
    const checked = validatePastedUrl(url.href);
    if (stripWww(checked.hostname) !== stripWww(origin.hostname) ) throw notAllowed(`redirect off ${origin.hostname} to ${checked.hostname} refused`);
    const verdict = await checkPublicHost(checked.hostname, resolve);
    if (!verdict.ok) throw notAllowed(verdict.reason);
    const res = await ctx.fetch(checked, { redirect: 'manual', headers: { accept }, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      await res.body?.cancel().catch(() => undefined);
      const loc = res.headers.get('location');
      if (!loc) throw new ProviderError('provider_unavailable', `${checked.hostname} redirected without a location`);
      if (hop >= MAX_REDIRECTS) throw new ProviderError('provider_unavailable', `${checked.hostname}: too many redirects`);
      let next: URL;
      try {
        next = new URL(loc, checked);
      } catch {
        throw notAllowed('redirect to an invalid URL refused');
      }
      if (stripWww(next.hostname) !== stripWww(origin.hostname)) throw notAllowed(`redirect off ${origin.hostname} to ${next.hostname} refused`);
      url = next;
      continue;
    }
    return { res, finalUrl: checked };
  }
}

/** Bot-protection interstitials that answer 200 with a challenge instead of the page. */
const CHALLENGE_RE = /captcha-delivery\.com|datadome|cf-chl-|Just a moment\.\.\.|px-captcha|Access Denied|_Incapsula_Resource/i;

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

type DimKey = 'w' | 'd' | 'h';
const DIM_NAMES: Record<string, DimKey> = {
  width: 'w',
  largeur: 'w',
  breite: 'w',
  ancho: 'w',
  depth: 'd',
  profondeur: 'd',
  tiefe: 'd',
  length: 'd',
  longueur: 'd',
  height: 'h',
  hauteur: 'h',
  hohe: 'h',
  'höhe': 'h',
  altura: 'h',
};

/** schema.org `QuantitativeValue` / `Distance` / `"160 cm"` / `{value, unitCode}` -> metres. A bare number has no unit and is refused. */
export function quantityToMetres(v: unknown): number | undefined {
  if (typeof v === 'string') return parseLength(v);
  if (isObj(v)) {
    const unit = str(v['unitCode']) ?? str(v['unitText']);
    const raw = v['value'] ?? v['maxValue'] ?? v['minValue'];
    if (typeof raw === 'number') return lengthOf(raw, unit);
    if (typeof raw === 'string') return parseLength(raw, unit);
  }
  return undefined;
}

function readDims(product: Json): Partial<Record<DimKey, number>> {
  const out: Partial<Record<DimKey, number>> = {};
  for (const [field, key] of [['width', 'w'], ['depth', 'd'], ['height', 'h']] as const) {
    const v = quantityToMetres(product[field]);
    if (v !== undefined && v > 0) out[key] = v;
  }
  for (const prop of asArray(product['additionalProperty'] as unknown[])) {
    if (!isObj(prop)) continue;
    const key = DIM_NAMES[(str(prop['name']) ?? '').toLowerCase()];
    if (!key || out[key] !== undefined) continue;
    const v = quantityToMetres({ value: prop['value'], unitCode: prop['unitCode'], unitText: prop['unitText'] });
    if (v !== undefined && v > 0) out[key] = v;
  }
  return out;
}

interface OfferInfo {
  price?: number;
  currency?: string;
  ttc: boolean;
}

function readOffer(product: Json): OfferInfo {
  const info: OfferInfo = { ttc: true };
  for (const offer of asArray(product['offers'] as unknown[])) {
    if (!isObj(offer)) continue;
    const specs = [offer, ...asArray(offer['priceSpecification'] as unknown[]).filter(isObj)];
    for (const s of specs) {
      info.price ??= asPrice(s['price']) ?? asPrice(s['lowPrice']);
      info.currency ??= str(s['priceCurrency']);
      if (s['valueAddedTaxIncluded'] === false) info.ttc = false;
    }
    if (info.price !== undefined) break;
  }
  return info;
}

function findProduct(nodes: Json[]): Json | undefined {
  const direct = nodes.find((n) => hasType(n, 'Product'));
  if (direct) return direct;
  const group = nodes.find((n) => hasType(n, 'ProductGroup'));
  if (group) {
    const variant = asArray(group['hasVariant'] as unknown[]).find(isObj);
    return { ...group, ...(variant ?? {}), '@type': 'Product' };
  }
  return undefined;
}

function pickGlb(nodes: Json[]): string | undefined {
  for (const n of nodes) {
    if (!hasType(n, '3DModel')) continue;
    const encs = [...asArray(n['encoding'] as unknown[]), ...asArray(n['contentUrl'] as unknown[]).map((u) => ({ contentUrl: u }))];
    for (const e of encs) {
      const url = isObj(e) ? str(e['contentUrl']) : undefined;
      const fmt = isObj(e) ? (str(e['encodingFormat']) ?? '') : '';
      if (url && url.length <= 512 && /^https:\/\//i.test(url) && (/\.glb(\?|$)/i.test(url) || fmt === 'model/gltf-binary')) return url;
    }
  }
  return undefined;
}

export function parsePastedPage(html: string, pageUrl: string, fetchedAt: string): ProductRecord {
  if (CHALLENGE_RE.test(html.slice(0, 20_000)) && !/application\/ld\+json/i.test(html)) throw blocked();
  const { nodes, blocks } = extractJsonLd(html);
  if (blocks === 0) {
    throw new ProviderError('provider_parse_failed', 'No schema.org data (JSON-LD) on this page', {
      hint: 'This page has no machine-readable product data; enter the details by hand or pick another product.',
      details: { selector: 'script[type="application/ld+json"]' },
    });
  }
  const product = findProduct(nodes);
  if (!product) {
    throw new ProviderError('provider_parse_failed', 'No schema.org Product in the JSON-LD of this page', {
      hint: 'This page has no product data; enter the details by hand or pick another product.',
      details: { selector: 'script[type="application/ld+json"] @type=Product' },
    });
  }
  const name = str(product['name']);
  if (!name) throw new ProviderError('provider_parse_failed', 'Product.name is missing', { details: { selector: 'Product.name' } });
  const offer = readOffer(product);
  if (offer.price === undefined || offer.currency === undefined) {
    throw new ProviderError('provider_parse_failed', 'Product.offers has no price or currency', {
      hint: 'The page does not publish a price; enter the details by hand or pick another product.',
      details: { selector: 'Product.offers.price|priceCurrency', name },
    });
  }
  const category = categoryOf(str(product['category']) ?? '', [name]);
  const first = asArray(product['image'] as unknown[])[0];
  const image = typeof first === 'string' ? first : isObj(first) ? (str(first['contentUrl']) ?? str(first['url'])) : undefined;
  const modelRef = pickGlb(nodes);
  const sku = urlHash(pageUrl);
  const dims = readDims(product);
  const draft = {
    provider: PASTED_URL_ID,
    sku,
    name: name.slice(0, 200),
    url: pageUrl,
    price: offer.price,
    currency: offer.currency.toUpperCase(),
    priceTtc: offer.ttc,
    category,
    ...(image && /^https:\/\//i.test(image) && image.length <= 2048 ? { photoUrl: image } : {}),
  };
  if (dims.w === undefined || dims.d === undefined || dims.h === undefined) {
    const labels = { w: 'width', d: 'depth', h: 'height' } as const;
    const missing = (['w', 'd', 'h'] as const).filter((k) => dims[k] === undefined).map((k) => labels[k]);
    throw new ProviderError('product_dims_missing', `"${name}" has no ${missing.join(' / ')} in its schema.org data`, {
      hint: `The page does not give the ${missing.join(', ')}; ask the user to type the width, depth and height (cm).`,
      details: { knownDims: dims, missing, draft },
    });
  }
  const parsed = ProductRecord.safeParse({
    ...draft,
    dims: { w: dims.w, d: dims.d, h: dims.h },
    dimsSource: 'structured',
    mount: mountOf(name, category),
    styleTags: [],
    colours: str(product['color']) ? [str(product['color'])!.slice(0, 40)] : [],
    variants: [],
    ...(modelRef ? { modelRef } : {}),
    fetchedAt,
    personalUseOnly: true,
  });
  if (!parsed.success) {
    throw new ProviderError('provider_parse_failed', `Product data is not usable: ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`, {
      details: { selector: 'ProductRecord' },
    });
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

export function createPastedUrlProvider(): ProductProvider {
  return {
    id: PASTED_URL_ID,
    label: PASTED_URL_META.label,
    capabilities: CAPABILITIES,
    personalUseOnly: PASTED_URL_META.personalUseOnly,
    ...(PASTED_URL_META.note ? { note: PASTED_URL_META.note } : {}),

    async search() {
      return [];
    },

    async get(sku: string, ctx: ProviderContext) {
      const rec = ctx.cache.get<ProductRecord>(`product:${sku}`);
      if (!rec) throw new ProviderError('product_not_found', `no pasted product "${sku}" in this session`, { hint: 'Paste the product URL again.' });
      return rec;
    },

    async resolveUrl(raw: string, ctx: ProviderContext): Promise<ProductRecord> {
      const url = validatePastedUrl(raw);
      const key = `product:${urlHash(url.href)}`;
      const cached = ctx.cache.get<ProductRecord>(key);
      if (cached) return cached;
      let got: { res: Response; finalUrl: URL };
      try {
        got = await guardedGet(url, ctx, 'text/html,application/xhtml+xml');
      } catch (e) {
        if (e instanceof ProviderError && e.code === 'provider_blocked') throw blocked(BLOCKED_MESSAGE, e.retryAt);
        throw e;
      }
      const { res, finalUrl } = got;
      if (res.status === 401 || res.status === 451) {
        await res.body?.cancel().catch(() => undefined);
        throw blocked();
      }
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError('product_not_found', 'The page was not found (404)', { hint: 'Check the URL.' });
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError('provider_unavailable', `${finalUrl.hostname} answered ${res.status}`);
      }
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      if (type !== '' && !/html|xml/.test(type)) {
        await res.body?.cancel().catch(() => undefined);
        throw notAllowed(`not a web page (${type.split(';')[0]})`);
      }
      const html = await readTextCapped(res, PAGE_MAX_BYTES, () => notAllowed('the page is larger than 2 MB'));
      const record = parsePastedPage(html, url.href, new Date(ctx.clock.now()).toISOString());
      ctx.cache.set(key, record, TTL_MS, 4096);
      return record;
    },

    async fetchPhoto(rec: ProductRecord, ctx: ProviderContext): Promise<ModelStream> {
      if (!rec.photoUrl) throw new ProviderError('product_not_found', 'this page publishes no photo');
      const { res } = await guardedGet(validatePastedUrl(rec.photoUrl), ctx, 'image/avif,image/webp,image/*');
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError('product_not_found', `photo download answered ${res.status}`);
      }
      const len = Number(res.headers.get('content-length'));
      return { stream: res.body, contentType: 'image/*', ...(Number.isFinite(len) && len > 0 ? { size: len } : {}) };
    },

    async fetchModel(sku: string, ctx: ProviderContext): Promise<ModelStream> {
      const rec = ctx.cache.get<ProductRecord>(`product:${sku}`);
      if (!rec?.modelRef) throw new ProviderError('model_unavailable', 'this page publishes no GLB model');
      const modelUrl = validatePastedUrl(rec.modelRef);
      const { res } = await guardedGet(modelUrl, ctx, 'model/gltf-binary,*/*');
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError('model_unavailable', `model download answered ${res.status}`);
      }
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > MODEL_MAX_BYTES) {
        await res.body.cancel().catch(() => undefined);
        throw new ProviderError('model_unavailable', `model is ${len} bytes (limit ${MODEL_MAX_BYTES})`);
      }
      return { stream: res.body, contentType: 'model/gltf-binary', ...(Number.isFinite(len) && len > 0 ? { size: len } : {}) };
    },
  };
}

export default createPastedUrlProvider;
