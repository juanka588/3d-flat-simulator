import { describe, expect, it } from 'vitest';
import { HttpFlatApi } from './flatApi';
import { MockFlatApi } from './testing/mockFlatApi';

describe('MockFlatApi products', () => {
  it('lists the mock provider and searches the fixture products', async () => {
    const api = new MockFlatApi();
    const providers = await api.listProviders();
    expect(providers.ok && providers.data.providers.map((p) => p.id)).toEqual(['mock']);
    const r = await api.searchProducts({ q: 'sofa' });
    expect(r.ok && r.data.results.map((p) => p.productId)).toEqual(['mock:MOCK-SOFA-3']);
    const all = await api.searchProducts({ q: '', limit: 5 });
    expect(all.ok && [all.data.results.length, all.data.truncated]).toEqual([5, true]);
    const none = await api.searchProducts({ q: 'sofa', provider: 'ikea-fr' });
    expect(!none.ok && none.kind === 'http' && none.errors[0]!.code).toBe('unknown_provider');
  });

  it('gets a product, resolves a URL and reports unknown ones', async () => {
    const api = new MockFlatApi();
    const g = await api.getProduct('mock:MOCK-DESK-120');
    expect(g.ok && g.data.product.dims).toEqual({ w: 1.2, d: 0.6, h: 0.75 });
    const miss = await api.getProduct('mock:NOPE');
    expect(!miss.ok && miss.kind === 'http' && [miss.status, miss.errors[0]!.code]).toEqual([404, 'product_not_found']);
    const bad = await api.getProduct('nonsense');
    expect(!bad.ok && bad.kind === 'http' && bad.status).toBe(422);
    const url = g.ok ? g.data.product.url : '';
    const res = await api.resolveProductUrl(url);
    expect(res.ok && res.data.product.sku).toBe('MOCK-DESK-120');
    const blocked = await api.resolveProductUrl('https://www.leroymerlin.fr/x');
    expect(!blocked.ok && blocked.kind === 'http' && blocked.errors[0]!.code).toBe('url_not_allowed');
  });

  it('keeps a per-session seen registry', async () => {
    const api = new MockFlatApi();
    expect((await api.isProductSeen('s1', 'mock:MOCK-BED-160')).ok && true).toBe(true);
    const before = await api.isProductSeen('s1', 'mock:MOCK-BED-160');
    expect(before.ok && before.data.seen).toBe(false);
    const marked = await api.markProductsSeen('s1', ['mock:MOCK-BED-160', 'mock:MOCK-DESK-120']);
    expect(marked.ok && marked.data.seen).toBe(2);
    const after = await api.isProductSeen('s1', 'mock:MOCK-BED-160');
    const other = await api.isProductSeen('s2', 'mock:MOCK-BED-160');
    expect([after.ok && after.data.seen, other.ok && other.data.seen]).toEqual([true, false]);
  });

  it('builds asset URLs without a request, and honours down / failNext like the other methods', async () => {
    const api = new MockFlatApi();
    expect(api.assetUrl({ kind: 'product-model', productId: 'mock:MOCK-BED-160' })).toBe('http://mock.flat/api/assets/products/mock/MOCK-BED-160.glb');
    expect(api.assetUrl({ kind: 'mesh', assetId: 'polyhaven:sofa_03' })).toBe('http://mock.flat/api/assets/meshes/polyhaven%3Asofa_03.glb');
    expect(() => api.assetUrl({ kind: 'product-model', productId: 'bad' })).toThrow(RangeError);
    api.down = true;
    const r = await api.searchProducts({ q: 'bed' });
    expect(!r.ok && r.kind).toBe('unreachable');
  });
});

describe('HttpFlatApi product routes', () => {
  function recorder(body: unknown = {}) {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const impl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const api = new HttpFlatApi({ serverUrl: 'http://127.0.0.1:8787', token: undefined, requestTimeoutMs: 1000 }, impl, { retryDelayMs: 0 });
    return { api, calls };
  }

  it('targets the planned routes', async () => {
    const { api, calls } = recorder();
    await api.listProviders();
    await api.searchProducts({ q: 'lit 160', category: 'bed', maxPrice: 400, limit: 5 });
    await api.getProduct('ikea-fr:80275887');
    await api.resolveProductUrl('https://shop.example/p/1');
    await api.markProductsSeen('sess', ['mock:A']);
    await api.isProductSeen('sess', 'mock:A');
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:8787/api/providers', method: 'GET' },
      { url: 'http://127.0.0.1:8787/api/products/search?q=lit+160&category=bed&maxPrice=400&limit=5', method: 'GET' },
      { url: 'http://127.0.0.1:8787/api/products/ikea-fr%3A80275887', method: 'GET' },
      { url: 'http://127.0.0.1:8787/api/products/resolve', method: 'POST', body: { url: 'https://shop.example/p/1' } },
      { url: 'http://127.0.0.1:8787/api/products/seen', method: 'POST', body: { session: 'sess', productIds: ['mock:A'] } },
      { url: 'http://127.0.0.1:8787/api/products/seen?session=sess&id=mock%3AA', method: 'GET' },
    ]);
  });

  it('assetUrl is the same-origin /api/assets path', () => {
    const { api } = recorder();
    expect(api.assetUrl({ kind: 'product-model', productId: 'ikea-fr:80275887' })).toBe('http://127.0.0.1:8787/api/assets/products/ikea-fr/80275887.glb');
    expect(api.assetUrl({ kind: 'mesh', assetId: 'param:bed' })).toBe('http://127.0.0.1:8787/api/assets/meshes/param%3Abed.glb');
  });

  it('fetchAsset reads only the server\'s own /api/assets/ routes, with the token', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const impl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return new Response(new Uint8Array([7, 8]), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
    };
    const api = new HttpFlatApi({ serverUrl: 'http://127.0.0.1:8787', token: 'tok', requestTimeoutMs: 1000 }, impl);
    const ok = await api.fetchAsset('http://127.0.0.1:8787/api/assets/products/mock/A.glb');
    expect(ok.ok && [ok.data.status, ok.data.contentType, [...ok.data.body]]).toEqual([200, 'model/gltf-binary', [7, 8]]);
    expect(seen).toEqual([{ url: 'http://127.0.0.1:8787/api/assets/products/mock/A.glb', auth: 'Bearer tok' }]);
    for (const url of ['http://127.0.0.1:8787/api/scene', 'http://evil.example/api/assets/x.glb', 'http://127.0.0.1:8787/api/assets/../scene']) {
      const r = await api.fetchAsset(url);
      expect(r.ok, url).toBe(false);
    }
    expect(seen).toHaveLength(1);
  });
});
