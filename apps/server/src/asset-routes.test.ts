import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSET_ROUTES, providerModelUrl, serverMeshUrl } from '@flat/assets';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { loadConfig } from './config';
import { createProviderRegistry } from './providers/registry';
import { fakeClock, fakeFetch, tinyGlb } from './providers/testkit';
import { SceneStore } from './store';

// Contract: the URL builders of @flat/assets (used by the web viewer and by MCP) address exactly the routes the server
// declares from ASSET_ROUTES. If either side changes alone, this fails.

const ORIGIN = 'http://127.0.0.1:8787';
const PRODUCT_IDS = ['ikea-fr:80275887', 'mock:MOCK-BED-160', 'pasted-url:a b/c'];
const MESH_IDS = ['local:3dfuture:abc123', 'polyhaven:sofa_03', '3dfuture:abc'];

/** A router that declares the routes from ASSET_ROUTES only and echoes what it captured. */
function echoRouter() {
  const app = new Hono();
  app.get(ASSET_ROUTES.productModel, (c) => c.json({ route: 'product', provider: c.req.param('provider'), file: c.req.param('file') }));
  app.get(ASSET_ROUTES.meshCatalog, (c) => c.json({ route: 'catalog' }));
  app.get(ASSET_ROUTES.meshModel, (c) => c.json({ route: 'mesh', file: c.req.param('file') }));
  return app;
}

describe('URL builders vs ASSET_ROUTES', () => {
  it('providerModelUrl matches the product route, with provider and sku recoverable', async () => {
    const app = echoRouter();
    for (const id of PRODUCT_IDS) {
      const url = providerModelUrl(ORIGIN, id);
      expect(url, id).toBeDefined();
      const res = await app.request(new URL(url!).pathname);
      expect(res.status, id).toBe(200);
      const body = (await res.json()) as { route: string; provider: string; file: string };
      const sep = id.indexOf(':');
      expect(body).toEqual({ route: 'product', provider: id.slice(0, sep), file: `${id.slice(sep + 1)}.glb` });
    }
  });

  it('serverMeshUrl matches the mesh route (never the catalog route), with the asset id recoverable', async () => {
    const app = echoRouter();
    for (const id of MESH_IDS) {
      const res = await app.request(new URL(serverMeshUrl(ORIGIN, id)).pathname);
      expect(res.status, id).toBe(200);
      expect(await res.json()).toEqual({ route: 'mesh', file: `${id}.glb` });
    }
    expect(await (await app.request('/api/assets/meshes/catalog.json')).json()).toEqual({ route: 'catalog' });
  });

  it('the builders only produce paths under /api/assets/', () => {
    for (const url of [providerModelUrl(ORIGIN, PRODUCT_IDS[0]!)!, serverMeshUrl(ORIGIN, MESH_IDS[0]!)]) expect(new URL(url).pathname.startsWith('/api/assets/')).toBe(true);
  });
});

describe('the server declares ASSET_ROUTES', () => {
  let dir: string;
  let store: SceneStore | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flat-asset-routes-'));
    await mkdir(join(dir, 'pack'), { recursive: true });
  });
  afterEach(async () => {
    await store?.close();
    store = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function boot() {
    const config = loadConfig({}, { dataDir: dir, snapshotDebounceMs: 10, log: () => undefined, rateLimitPerSec: 100000, localAssetsDir: join(dir, 'pack') });
    store = await SceneStore.open(config);
    const clock = fakeClock();
    const providers = await createProviderRegistry({ enabled: [], clock, fetch: fakeFetch(clock, []).fetch, sleep: clock.sleep, random: () => 0, lookup: async () => ['93.184.216.34'] });
    return createApp(store, config, providers);
  }

  it('registers every route of the constant', async () => {
    const app = await boot();
    const declared = app.routes.filter((r) => r.method === 'GET').map((r) => r.path);
    for (const path of Object.values(ASSET_ROUTES)) expect(declared, path).toContain(path);
  });

  it('answers the URL that serverMeshUrl builds', async () => {
    const entry = {
      id: 'local:3dfuture:abc123', name: 'Sofa', source: '3dfuture', licence: 'LicenseRef-3D-FUTURE', credit: '3D-FUTURE dataset (Alibaba), non-commercial research use only',
      category: 'sofa', styleTags: [], nativeDims: { w: 2, d: 0.9, h: 0.8 }, anchor: [0, 0, 0], front: '+z', file: 'abc123.glb',
    };
    await writeFile(join(dir, 'pack', 'catalog.json'), JSON.stringify([entry]));
    await writeFile(join(dir, 'pack', 'abc123.glb'), tinyGlb());
    const app = await boot();
    const res = await app.request(new URL(serverMeshUrl(ORIGIN, 'local:3dfuture:abc123')).pathname, { headers: { origin: 'http://localhost:5173' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('model/gltf-binary');
  });
});
