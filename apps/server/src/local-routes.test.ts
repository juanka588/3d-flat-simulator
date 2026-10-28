import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetProductResponse, ProductSearchResponse, ProvidersResponse } from '@flat/scene';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { loadConfig } from './config';
import { openLocalCatalog } from './providers/local/catalog';
import { entryFor, makeGlb, tinyWebp, writeCatalog } from './providers/local/fixtures';
import { createProviderRegistry } from './providers/registry';
import { fakeClock, fakeFetch } from './providers/testkit';
import { SceneStore } from './store';

/** The product routes served from the local catalogue: offline, and with the same Origin / Sec-Fetch protections as the live ones. */

const ORIGIN = 'http://localhost:5173';
const NOW = Date.parse('2026-10-28T12:00:00Z');
let dir: string;
let catDir: string;
let stores: SceneStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flat-lroutes-'));
  catDir = await mkdtemp(join(tmpdir(), 'flat-lcat-'));
});
afterEach(async () => {
  for (const s of stores) await s.close();
  stores = [];
  await rm(dir, { recursive: true, force: true });
  await rm(catDir, { recursive: true, force: true });
});

async function boot() {
  const glb = await makeGlb({ size: [1, 0.5, 0.5] });
  await writeCatalog(
    catDir,
    [
      entryFor({ sku: '10000001', name: 'KIVIK Canapé 3 places', category: 'sofa', typeName: 'Canapé', has3d: true, photoUrl: 'https://www.ikea.com/p1.jpg', fetchedAt: '2026-10-27T10:00:00.000Z' }),
      entryFor({ sku: '10000002', name: 'GLOSTAD Canapé 2 places', category: 'sofa', typeName: 'Canapé', noModelReason: 'proportions do not match', fetchedAt: '2026-07-01T10:00:00.000Z' }),
    ],
    { models: { '10000001': glb }, photos: { '10000001': await tinyWebp() } },
  );
  const config = loadConfig({}, { dataDir: dir, snapshotDebounceMs: 10, log: () => {}, rateLimitPerSec: 100000 });
  const store = await SceneStore.open(config);
  stores.push(store);
  const clock = fakeClock(NOW);
  const net = fakeFetch(clock, []); // any request to a shop would be recorded here (and answer 599)
  const local = (await openLocalCatalog(catDir, { now: () => NOW }))!;
  const registry = await createProviderRegistry({ enabled: [], clock, fetch: net.fetch, sleep: clock.sleep, local });
  const app = createApp(store, config, registry);
  const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
  return { get, net };
}

describe('local catalogue routes', () => {
  it('lists the local tier and the catalogue summary; searches without any provider enabled and without a request to the shop', async () => {
    const { get, net } = await boot();
    const providers = ProvidersResponse.parse(await (await get('/api/providers')).json());
    expect(providers.providers.map((p) => [p.id, p.enabled])).toEqual([['ikea-fr-local', true], ['mock', false], ['ikea-fr', false], ['pasted-url', false]]);
    expect(providers.localCatalog).toMatchObject({ id: 'ikea-fr-local', count: 2, withModels: 1, stale: false });

    const t0 = performance.now();
    const res = await get('/api/products/search?q=canape&limit=5');
    const ms = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = ProductSearchResponse.parse(await res.json());
    expect(body.results.map((r) => [r.productId, r.source, r.has3d, r.stale ?? false])).toEqual([
      ['ikea-fr:10000001', 'local', true, false],
      ['ikea-fr:10000002', 'local', false, true], // a price older than 30 days is flagged
    ]);
    expect(body.results[0]!.fetchedAt).toBe('2026-10-27T10:00:00.000Z');
    expect(body.providers).toEqual([{ provider: 'ikea-fr-local', ok: true }]);
    expect(ms).toBeLessThan(250);
    expect(net.calls).toHaveLength(0);

    const none = await get('/api/products/search?q=live%20only&live=true');
    expect(none.status).toBe(200);
    expect(ProductSearchResponse.parse(await none.json()).providers).toContainEqual(expect.objectContaining({ provider: 'ikea-fr', ok: false, code: 'provider_disabled' }));
  });

  it('get_product: the local record, its source and staleness', async () => {
    const { get } = await boot();
    const a = GetProductResponse.parse(await (await get('/api/products/ikea-fr%3A10000001')).json());
    expect(a).toMatchObject({ source: 'local', product: { sku: '10000001', modelRef: 'local:10000001' } });
    expect(a.stale).toBeUndefined();
    const b = GetProductResponse.parse(await (await get('/api/products/ikea-fr%3A10000002')).json());
    expect(b).toMatchObject({ source: 'local', stale: true });
    expect(b.product.modelRef).toBeUndefined();
    expect((await get('/api/products/ikea-fr%3A99999999')).status).toBe(404);
  });

  it('streams the checked GLB; a product without one answers model_unavailable (404), never a live download', async () => {
    const { get, net } = await boot();
    const ok = await get('/api/assets/products/ikea-fr/10000001.glb');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('model/gltf-binary');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = new Uint8Array(await ok.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('glTF');
    const no = await get('/api/assets/products/ikea-fr/10000002.glb');
    expect(no.status).toBe(404);
    expect(((await no.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe('model_unavailable');
    expect(net.calls).toHaveLength(0);
  });

  it('serves the small local photo through the photo route', async () => {
    const { get, net } = await boot();
    const r = await get('/api/products/ikea-fr%3A10000001/photo');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/webp');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(10);
    expect((await get('/api/products/ikea-fr%3A10000002/photo')).status).toBe(404);
    expect(net.calls).toHaveLength(0);
  });

  it('keeps the Origin and Sec-Fetch protections on every local route (reads too)', async () => {
    const { get } = await boot();
    const paths = ['/api/providers', '/api/products/search?q=canape', '/api/products/ikea-fr%3A10000001', '/api/products/ikea-fr%3A10000001/photo', '/api/assets/products/ikea-fr/10000001.glb'];
    for (const path of paths) {
      expect([path, (await get(path, { origin: 'https://evil.example' })).status]).toEqual([path, 403]);
      expect([path, (await get(path, { origin: 'http://localhost:9999' })).status]).toEqual([path, 403]);
      expect([path, (await get(path, { 'sec-fetch-site': 'cross-site' })).status]).toEqual([path, 403]);
      expect([path, (await get(path, { 'sec-fetch-site': 'same-site' })).status]).toEqual([path, 403]);
      expect([path, (await get(path, { origin: ORIGIN })).status]).toEqual([path, 200]);
      expect([path, (await get(path, { 'sec-fetch-site': 'same-origin' })).status]).toEqual([path, 200]);
      expect([path, (await get(path, { host: 'evil.example' })).status]).toEqual([path, 403]);
    }
  });
});
