import { ProductRecord } from '@flat/assets';
import { describe, expect, it } from 'vitest';
import { IKEA_FR_META } from './catalog';
import { categoryOf } from './category';
import { createIkeaFrProvider, modelUrlOf, parsePackageWeightKg, parseProductPage, parseSearchResponse, pickModelRef } from './ikea-fr';
import { collect, fixture, hang, json, status, testContext, text, tinyGlb, type Handler } from './testkit';
import { ProviderError } from './types';

const SEARCH = 'https://sik.search.blue.cdtapps.com/fr/fr/search-result-page*';
const PAGE = fixture('ikea-fr/product-kallax-80275887.html');
const searchJson = JSON.parse(fixture('ikea-fr/search-kallax.json'));
const GLB = /^https:\/\/web-api\.ikea\.com\/dimma\/assets\/1\.2\/80275887\/PS01_S01_NV01\/iqp1\/glb_draco\//;

function routes(over: [string | RegExp, Parameters<typeof text>[0] | Handler][] = []) {
  return [
    ...over.map(([p, r]) => [p, typeof r === 'string' ? text(r) : r] as [string | RegExp, Handler]),
    [SEARCH, json(searchJson)],
    [/^https:\/\/www\.ikea\.com\/fr\/fr\/p\//, text(PAGE)],
    [GLB, new Response(tinyGlb(), { headers: { 'content-type': 'model/gltf-binary', 'content-length': String(tinyGlb().length) } })],
  ] as [string | RegExp, Handler][];
}

describe('IKEA FR parsing (recorded fixtures)', () => {
  it('reads the search response: price = salesPrice.numeral (EUR), measure text, variants with colours', () => {
    const hits = parseSearchResponse(searchJson);
    expect(hits.map((h) => [h.sku, h.price, h.currency, h.measureText])).toEqual([
      ['80275887', 59.99, 'EUR', '77x147 cm'],
      ['20275814', 34.99, 'EUR', '77x77 cm'],
      ['00275848', 54.99, 'EUR', '42x147 cm'],
    ]);
    expect(hits[0]!.variants[0]).toMatchObject({ sku: '00324518', colour: 'effet chêne blanchi', price: 69.99 });
  });

  it('reads the product page: assembled dims (not the package), TTC EUR price, package weight, smallest Draco GLB', () => {
    const rec = parseProductPage(PAGE, { sku: '80275887', pageUrl: 'https://www.ikea.com/fr/fr/p/x/', fetchedAt: '2026-10-27T10:00:00.000Z', hit: parseSearchResponse(searchJson)[0]! });
    expect(ProductRecord.safeParse(rec).success).toBe(true);
    expect(rec).toMatchObject({
      provider: 'ikea-fr',
      sku: '80275887',
      price: 59.99,
      currency: 'EUR',
      priceTtc: true,
      dims: { w: 0.765, d: 0.39, h: 1.465 },
      dimsSource: 'structured',
      category: 'shelf',
      weightKg: 20.3,
      weightKind: 'package',
      personalUseOnly: true,
    });
    expect(rec.dims.d).not.toBe(1.5); // the 150 cm package length is not the item depth
    expect(rec.modelRef).toMatch(/^1\.2\/80275887\/PS01_S01_NV01\/iqp1\/glb_draco\//);
    expect(rec.colours).toEqual(['blanc']);
    expect(rec.variants.length).toBeGreaterThan(0);
  });

  it('falls back to the dimension rows when the JSON-LD has no dims', () => {
    const html = PAGE.replace(/"(width|depth|height)":\s*"[^"]*"/g, '"$1": "n/a"');
    const rec = parseProductPage(html, { sku: '80275887', pageUrl: 'https://www.ikea.com/x', fetchedAt: '2026-10-27T10:00:00.000Z' });
    expect(rec.dims).toEqual({ w: 0.765, d: 0.39, h: 1.465 });
  });

  it('only 2 of 3 dims known: product_dims_missing with a clear hint and the partial dims', () => {
    const html = PAGE.replace(/"depth":\s*"[^"]*"/, '"depth": "n/a"').replace(/<li class="pipf-measurements-tab__measurement-row"><span class="pipf-measurements-tab__measurement-name">Profondeur.*?<\/li>/, '');
    let err: unknown;
    try {
      parseProductPage(html, { sku: '80275887', pageUrl: 'https://www.ikea.com/x', fetchedAt: '2026-10-27T10:00:00.000Z', hit: parseSearchResponse(searchJson)[0]! });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.code).toBe('product_dims_missing');
    expect(pe.message).toMatch(/depth unknown/);
    expect(pe.hint).toMatch(/ask the user/);
    expect(pe.details).toMatchObject({ dimsSource: 'text', missing: ['depth'], measureText: '77x147 cm' });
  });

  it('structure changed: provider_parse_failed names the failing selector', () => {
    expect(() => parseProductPage('<html></html>', { sku: '1', pageUrl: 'https://x', fetchedAt: '2026-10-27T10:00:00.000Z' })).toThrow(/script\[type="application\/ld\+json"\]/);
    expect(() => parseProductPage(PAGE.replace(/"@type":\s*"Product"/, '"@type":"Thing"'), { sku: '80275887', pageUrl: 'https://x', fetchedAt: '2026-10-27T10:00:00.000Z' })).toThrow(/@type=Product/);
    expect(() => parseSearchResponse({ searchResultPage: {} })).toThrow(/searchResultPage\.products\.main\.items/);
    try {
      parseSearchResponse({ searchResultPage: { products: { main: { items: [{ product: { id: '80275887', pipUrl: 'https://x/', salesPrice: {} } }] } } } });
    } catch (e) {
      expect((e as ProviderError).code).toBe('provider_parse_failed');
      expect((e as ProviderError).message).toMatch(/salesPrice\.numeral/);
    }
  });

  it('helpers: model choice, weight, model URL guard, categories', () => {
    expect(pickModelRef(undefined)).toBeUndefined();
    expect(parsePackageWeightKg('no packages')).toBeUndefined();
    expect(modelUrlOf('1.2/80275887/a/iqp1/glb_draco/h-x.glb?cn=pip')).toBe('https://web-api.ikea.com/dimma/assets/1.2/80275887/a/iqp1/glb_draco/h-x.glb?cn=pip');
    expect(modelUrlOf('../../etc/passwd.glb')).toBeUndefined();
    expect(modelUrlOf('1.2/x.glb?evil=1')).toBeUndefined();
    expect(categoryOf('Table de chevet')).toBe('bedside');
    expect(categoryOf('Lit avec rangement')).toBe('bed');
    expect(categoryOf('Canapé 3 places')).toBe('sofa');
    expect(categoryOf('Bloc porte', ['Rangements'])).toBe('other');
  });

  it('declares the static catalog entry', () => {
    const p = createIkeaFrProvider();
    expect([p.id, p.label, p.capabilities, p.personalUseOnly]).toEqual([IKEA_FR_META.id, IKEA_FR_META.label, IKEA_FR_META.capabilities, true]);
  });
});

describe('IKEA FR provider (fake fetch)', () => {
  it('search: GET only, enriches with product pages, filters, caches', async () => {
    const t = testContext(routes(), { id: 'ikea-fr' });
    const p = createIkeaFrProvider({ enrichMax: 1 });
    const out = await p.search('kallax', { limit: 5 }, t.ctx);
    expect(out.map((r) => r.sku)).toEqual(['80275887']);
    const urls = t.fetch.pages().map((c) => c.url);
    expect(urls[0]).toMatch(/^https:\/\/sik\.search\.blue\.cdtapps\.com\/fr\/fr\/search-result-page\?q=kallax/);
    expect(urls[1]).toMatch(/\/fr\/fr\/p\/kallax-etagere-blanc-80275887\/$/);
    expect(t.fetch.pages().every((c) => c.method === 'GET')).toBe(true);
    const n = t.fetch.pages().length;
    await p.search('kallax', { limit: 1 }, t.ctx);
    expect(t.fetch.pages()).toHaveLength(n); // search + product cached
    expect(await p.search('kallax', { limit: 5, maxPrice: 10 }, t.ctx)).toEqual([]);
  });

  it('get: not found (404) and bad sku', async () => {
    const t = testContext(routes([[/\/p\/-11111111\//, status(404)]]), { id: 'ikea-fr' });
    const p = createIkeaFrProvider();
    await expect(p.get('11111111', t.ctx)).rejects.toMatchObject({ code: 'product_not_found' });
    await expect(p.get('abc', t.ctx)).rejects.toMatchObject({ code: 'product_not_found' });
    expect((await p.get('80275887', t.ctx)).name).toMatch(/KALLAX/);
  });

  it('get: changed page structure -> provider_parse_failed', async () => {
    const t = testContext(routes([[/\/p\//, '<html><body>redesigned</body></html>']]), { id: 'ikea-fr' });
    await expect(createIkeaFrProvider().get('80275887', t.ctx)).rejects.toMatchObject({ code: 'provider_parse_failed' });
  });

  it('403 opens the circuit; later calls do not reach the network', async () => {
    const t = testContext(routes([[SEARCH, status(403)]]), { id: 'ikea-fr' });
    const p = createIkeaFrProvider();
    await expect(p.search('kallax', { limit: 3 }, t.ctx)).rejects.toMatchObject({ code: 'provider_blocked' });
    expect(t.net.circuit().state).toBe('open');
    const n = t.fetch.calls.length;
    await expect(p.get('80275887', t.ctx)).rejects.toMatchObject({ code: 'provider_blocked' });
    expect(t.fetch.calls).toHaveLength(n);
  });

  it('429 opens the circuit', async () => {
    const t = testContext(routes([[SEARCH, status(429)]]), { id: 'ikea-fr' });
    await expect(createIkeaFrProvider().search('kallax', { limit: 3 }, t.ctx)).rejects.toMatchObject({ code: 'provider_blocked' });
    expect(t.net.circuit().state).toBe('open');
  });

  it('timeout -> provider_unavailable', async () => {
    const t = testContext(routes([[SEARCH, hang]]), { id: 'ikea-fr', network: { timeoutMs: 20, maxRetries: 0 } });
    await expect(createIkeaFrProvider().search('kallax', { limit: 3 }, t.ctx)).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('fetchModel streams the lowest interactive Draco GLB', async () => {
    const t = testContext(routes(), { id: 'ikea-fr' });
    const m = await createIkeaFrProvider().fetchModel!('80275887', t.ctx);
    expect(m.contentType).toBe('model/gltf-binary');
    const bytes = await collect(m.stream);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('glTF');
    expect(t.fetch.pages().at(-1)!.url).toMatch(GLB);
    expect(t.fetch.pages().every((c) => c.method === 'GET')).toBe(true);
  });

  it('fetchModel: 404 -> model_unavailable; page without 3DModel -> model_unavailable; oversize refused', async () => {
    const t = testContext(routes([[GLB, status(404)]]), { id: 'ikea-fr' });
    await expect(createIkeaFrProvider().fetchModel!('80275887', t.ctx)).rejects.toMatchObject({ code: 'model_unavailable' });
    const noModel = PAGE.replace(/<script type="application\/ld\+json">\{"@context": "http:\/\/schema\.org\/", "@type": "3DModel".*?<\/script>\n?/s, '').replace(/<script type="application\/ld\+json">\{"@context":"http:\/\/schema\.org\/","@type":"3DModel".*?<\/script>\n?/s, '');
    const t2 = testContext(routes([[/\/p\//, noModel]]), { id: 'ikea-fr' });
    await expect(createIkeaFrProvider().fetchModel!('80275887', t2.ctx)).rejects.toMatchObject({ code: 'model_unavailable' });
    const t3 = testContext(routes([[GLB, new Response(tinyGlb(), { headers: { 'content-length': String(25 * 1024 * 1024) } })]]), { id: 'ikea-fr' });
    await expect(createIkeaFrProvider().fetchModel!('80275887', t3.ctx)).rejects.toMatchObject({ code: 'model_unavailable' });
  });
});
