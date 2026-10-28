import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetProductResponse, IsSeenResponse, ProductSearchResponse, ProvidersResponse } from '@flat/assets';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { loadConfig } from './config';
import { mockProducts } from './providers/mock';
import { createProviderRegistry } from './providers/registry';
import { fakeClock, fakeFetch, fixture, json, status, text, tinyGlb } from './providers/testkit';
import { SceneStore } from './store';

const ORIGIN = 'http://localhost:5173';
let dir: string;
let stores: SceneStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flat-products-'));
});
afterEach(async () => {
  for (const s of stores) await s.close();
  stores = [];
  await rm(dir, { recursive: true, force: true });
});

async function boot(enabled: string[] = [], routes: Parameters<typeof fakeFetch>[1] = []) {
  const config = loadConfig({}, { dataDir: dir, snapshotDebounceMs: 10, log: () => {}, rateLimitPerSec: 100000 });
  const store = await SceneStore.open(config);
  stores.push(store);
  const clock = fakeClock();
  const f = fakeFetch(clock, routes);
  const providers = await createProviderRegistry({
    enabled,
    clock,
    fetch: f.fetch,
    sleep: clock.sleep,
    random: () => 0,
    lookup: async () => ['93.184.216.34'],
  });
  const app = createApp(store, config, enabled.length === 0 && routes.length === 0 ? undefined : providers);
  const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, get, post, f, providers };
}

const ikeaRoutes = (modelCalls: { n: number } = { n: 0 }): NonNullable<Parameters<typeof fakeFetch>[1]> => [
  [/search-result-page/, json(JSON.parse(fixture('ikea-fr/search-kallax.json')))],
  [/\/fr\/fr\/p\//, text(fixture('ikea-fr/product-kallax-80275887.html'))],
  [/web-api\.ikea\.com\/dimma\/assets\//, () => (modelCalls.n++, new Response(tinyGlb(), { headers: { 'content-type': 'model/gltf-binary' } }))],
];

describe('product routes with nothing enabled (default)', () => {
  it('lists the providers as disabled and answers provider_disabled elsewhere, never cached', async () => {
    const { get, post } = await boot();
    const p = await get('/api/providers');
    expect(p.status).toBe(200);
    expect(p.headers.get('cache-control')).toBe('no-store');
    const body = ProvidersResponse.parse(await p.json());
    expect(body.providers.map((x) => [x.id, x.enabled, x.circuit])).toEqual([['mock', false, 'closed'], ['ikea-fr', false, 'closed'], ['pasted-url', false, 'closed']]);
    for (const path of ['/api/products/search?q=lit', '/api/products/mock%3AMOCK-BED-160', '/api/assets/products/ikea-fr/80275887.glb']) {
      const r = await get(path);
      expect([path, r.status, ((await r.json()) as { errors: { code: string }[] }).errors[0]!.code]).toEqual([path, 409, 'provider_disabled']);
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    const r = await post('/api/products/resolve', { url: 'https://a.example/p' });
    expect(r.status).toBe(409);
  });
});

describe('product routes with the mock provider', () => {
  it('search, get, seen', async () => {
    const { get, post } = await boot(['mock'], [['https://never.example/', text('x')]]);
    const s = ProductSearchResponse.parse(await (await get(`/api/products/search?q=${encodeURIComponent(mockProducts()[0]!.name.split(' ')[0]!)}&limit=3`)).json());
    expect(s.results.length).toBeGreaterThan(0);
    expect(s.providers).toEqual([{ provider: 'mock', ok: true }]);
    const id = s.results[0]!.productId;
    const g = await get(`/api/products/${encodeURIComponent(id)}`);
    expect(GetProductResponse.parse(await g.json()).product.sku).toBe(id.split(':')[1]);
    expect((await get('/api/products/mock%3ANOPE')).status).toBe(404);
    expect((await get('/api/products/search?bogus=1')).status).toBe(422);
    expect((await get('/api/products/search?provider=zzz')).status).toBe(404);

    expect(IsSeenResponse.parse(await (await get(`/api/products/seen?session=s1&id=${encodeURIComponent(id)}`)).json()).seen).toBe(false);
    const m = await post('/api/products/seen', { session: 's1', productIds: [id] });
    expect(await m.json()).toEqual({ ok: true, seen: 1 });
    expect(IsSeenResponse.parse(await (await get(`/api/products/seen?session=s1&id=${encodeURIComponent(id)}`)).json()).seen).toBe(true);
    expect((await get('/api/products/seen?session=&id=x')).status).toBe(422);
    expect((await post('/api/products/seen', { session: 's1', productIds: [] })).status).toBe(422);
    const first = mockProducts()[0]!;
    const resolved = await post('/api/products/resolve', { url: first.url });
    expect(resolved.status).toBe(200);
  });
});

describe('Origin and Host guards on the new routes', () => {
  const paths = ['/api/providers', '/api/products/search?q=lit', '/api/products/mock%3AMOCK-BED-160', '/api/products/seen?session=a&id=mock%3Ax', '/api/assets/products/ikea-fr/80275887.glb'];

  it('403 for a foreign Origin (reads and writes), a cross-site fetch without Origin, and a foreign Host', async () => {
    const { get, post } = await boot(['mock', 'ikea-fr'], ikeaRoutes());
    for (const path of paths) {
      expect([path, (await get(path, { origin: 'https://evil.example' })).status]).toEqual([path, 403]);
      expect([path, (await get(path, { 'sec-fetch-site': 'cross-site' })).status]).toEqual([path, 403]);
      expect([path, (await get(path, { host: 'evil.example' })).status]).toEqual([path, 403]);
    }
    for (const path of ['/api/products/resolve', '/api/products/seen']) {
      expect([path, (await post(path, { url: 'https://a.example/', session: 's', productIds: ['mock:a'] }, { origin: 'https://evil.example' })).status]).toEqual([path, 403]);
      expect([path, (await post(path, { url: 'https://a.example/' }, { host: 'evil.example' })).status]).toEqual([path, 403]);
    }
  });

  it('an allowed Origin and loopback Hosts pass; CORS echoes only the allowed origin', async () => {
    const { get } = await boot(['mock']);
    const ok = await get('/api/providers', { origin: ORIGIN, host: 'localhost:8787' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect((await get('/api/providers', { host: '127.0.0.1:8787' })).status).toBe(200);
    expect((await get('/api/providers', { 'sec-fetch-site': 'same-site', origin: ORIGIN })).status).toBe(200);
  });

  it('foreign requests never reach a retailer', async () => {
    const { get, f } = await boot(['ikea-fr'], ikeaRoutes());
    await get('/api/products/search?q=kallax', { origin: 'https://evil.example' });
    await get('/api/assets/products/ikea-fr/80275887.glb', { host: 'evil.example' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('IKEA through the routes (fixtures only)', () => {
  it('search returns exact assembled dims and TTC prices; GLB is streamed with no-store and cached', async () => {
    const calls = { n: 0 };
    const { get, f } = await boot(['ikea-fr'], ikeaRoutes(calls));
    const r = await get('/api/products/search?q=kallax&limit=1');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const s = ProductSearchResponse.parse(await r.json());
    expect(s.results[0]).toMatchObject({ productId: 'ikea-fr:80275887', price: 59.99, currency: 'EUR', priceTtc: true, dims: { w: 0.765, d: 0.39, h: 1.465 }, has3d: true, personalUseOnly: true, category: 'shelf' });

    const glb = await get('/api/assets/products/ikea-fr/80275887.glb', { origin: ORIGIN });
    expect(glb.status).toBe(200);
    expect(glb.headers.get('cache-control')).toBe('no-store');
    expect(glb.headers.get('content-type')).toBe('model/gltf-binary');
    expect(glb.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = new Uint8Array(await glb.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('glTF');
    expect(glb.headers.get('content-length')).toBe(String(bytes.length));
    await get('/api/assets/products/ikea-fr/80275887.glb');
    expect(calls.n).toBe(1);
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true);
    expect((await get('/api/assets/products/ikea-fr/80275887.txt')).status).toBe(404);
  });

  it('a 403 shows up as an open circuit in /api/providers and as provider_blocked', async () => {
    const { get } = await boot(['ikea-fr'], [[/search-result-page/, status(403)]]);
    const r = await get('/api/products/search?q=kallax');
    const s = ProductSearchResponse.parse(await r.json());
    expect(s.providers[0]).toMatchObject({ provider: 'ikea-fr', ok: false, code: 'provider_blocked' });
    const info = ProvidersResponse.parse(await (await get('/api/providers')).json());
    expect(info.providers.find((p) => p.id === 'ikea-fr')).toMatchObject({ enabled: true, circuit: 'open' });
    const direct = await get('/api/products/ikea-fr%3A80275887');
    expect(direct.status).toBe(502);
    expect(direct.headers.get('retry-after')).toBeTruthy();
  });

  it('model 404 -> 404 model_unavailable', async () => {
    const { get } = await boot(['ikea-fr'], [[/web-api\.ikea\.com\/dimma\//, status(404)], ...ikeaRoutes()]);
    const r = await get('/api/assets/products/ikea-fr/80275887.glb');
    expect(r.status).toBe(404);
    expect(((await r.json()) as { errors: { code: string; hint: string }[] }).errors[0]).toMatchObject({ code: 'model_unavailable' });
  });
});

describe('paste URL through the routes', () => {
  it('resolves a JSON-LD page, refuses file:// and private hosts, reports missing dims and blocked sites', async () => {
    const { post } = await boot(['pasted-url'], [
      ['https://www.meubles-exemple.fr/p/lit', text(fixture('pasted-url/with-dims.html'))],
      ['https://www.meubles-exemple.fr/p/canape', text(fixture('pasted-url/without-dims.html'))],
      ['https://blocked.example/p', status(403)],
    ]);
    const ok = await post('/api/products/resolve', { url: 'https://www.meubles-exemple.fr/p/lit' });
    expect(ok.status).toBe(200);
    expect(GetProductResponse.parse(await ok.json()).product.sku).toMatch(/^[0-9a-f]{16}$/);
    const code = async (u: unknown) => {
      const r = await post('/api/products/resolve', { url: u });
      return [r.status, ((await r.json()) as { errors: { code: string }[] }).errors[0]!.code];
    };
    expect(await code('file:///etc/passwd')).toEqual([422, 'url_not_allowed']);
    expect(await code('https://127.0.0.1/p')).toEqual([422, 'url_not_allowed']);
    expect(await code('https://www.meubles-exemple.fr/p/canape')).toEqual([422, 'product_dims_missing']);
    expect(await code('https://blocked.example/p')).toEqual([502, 'provider_blocked']);
    expect(await code(42)).toEqual([422, 'invalid_command']);
  });
});
