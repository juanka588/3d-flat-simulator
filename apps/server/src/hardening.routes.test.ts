import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshAsset } from '@flat/scene';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, foreignProductRequest } from './app';
import { loadConfig } from './config';
import { localModelId } from './local-assets';
import { createProviderRegistry } from './providers/registry';
import { fakeClock, fakeFetch, fixture, json, text, tinyGlb } from './providers/testkit';
import { SceneStore } from './store';

const ORIGIN = 'http://localhost:5173';
let dir: string;
let assets: string;
let stores: SceneStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flat-hardening-'));
  assets = join(dir, 'local-assets', '3d-future');
  await mkdir(assets, { recursive: true });
});
afterEach(async () => {
  for (const s of stores) await s.close();
  stores = [];
  await rm(dir, { recursive: true, force: true });
});

const entry = (model: string, extra: Record<string, unknown> = {}) => ({
  id: `local:3dfuture:${model}`,
  name: `Sofa ${model}`,
  source: '3dfuture',
  licence: 'LicenseRef-3D-FUTURE',
  credit: '3D-FUTURE dataset (Alibaba), non-commercial research use only',
  category: 'sofa',
  styleTags: ['modern'],
  nativeDims: { w: 2, d: 0.9, h: 0.8 },
  anchor: [0, 0, 0],
  front: '+z',
  file: `${model}.glb`,
  thumb: `thumbs/${model}.webp`,
  sha256: 'abc',
  bytes: 100,
  ...extra,
});

async function boot(opts: { enabled?: string[]; token?: string; logs?: string[] } = {}, routes: Parameters<typeof fakeFetch>[1] = []) {
  const logs = opts.logs ?? [];
  const config = loadConfig({}, { dataDir: dir, snapshotDebounceMs: 10, log: (_l, m) => void logs.push(m), rateLimitPerSec: 100000, localAssetsDir: assets, ...(opts.token ? { token: opts.token } : {}) });
  const store = await SceneStore.open(config);
  stores.push(store);
  const clock = fakeClock();
  const f = fakeFetch(clock, routes);
  const providers = await createProviderRegistry({ enabled: opts.enabled ?? [], clock, fetch: f.fetch, sleep: clock.sleep, random: () => 0, lookup: async () => ['93.184.216.34'] });
  const app = createApp(store, config, providers, { redact: (t) => t.replaceAll('s3cret-key', '[redacted]') });
  const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
  return { app, get, f, logs };
}

describe('GET /api/assets/meshes (local 3D-FUTURE pack)', () => {
  it('serves the catalog (MeshAsset fields only) and the GLB, no-store, nosniff', async () => {
    await writeFile(join(assets, 'catalog.json'), JSON.stringify([entry('abc123'), entry('def-456_x')]));
    await writeFile(join(assets, 'abc123.glb'), tinyGlb());
    const { get } = await boot();
    const cat = await get('/api/assets/meshes/catalog.json', { origin: ORIGIN });
    expect(cat.status).toBe(200);
    expect(cat.headers.get('cache-control')).toBe('no-store');
    expect(cat.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const list = (await cat.json()) as Record<string, unknown>[];
    expect(list.map((a) => a['id'])).toEqual(['local:3dfuture:abc123', 'local:3dfuture:def-456_x']);
    for (const a of list) {
      expect(MeshAsset.safeParse(a).success).toBe(true); // strict schema: no sha256 / thumb / bytes leaked
      expect(a).not.toHaveProperty('sha256');
    }

    for (const id of ['local%3A3dfuture%3Aabc123', 'abc123']) {
      const r = await get(`/api/assets/meshes/${id}.glb`, { origin: ORIGIN });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('model/gltf-binary');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      const bytes = new Uint8Array(await r.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('glTF');
    }
  });

  it('an absent pack = empty catalog and 404 models', async () => {
    const { get } = await boot();
    expect(await (await get('/api/assets/meshes/catalog.json')).json()).toEqual([]);
    expect((await get('/api/assets/meshes/abc123.glb')).status).toBe(404);
  });

  it('404 for unlisted ids, a listed id without a file, non-GLB bytes, and every traversal attempt', async () => {
    await writeFile(join(assets, 'catalog.json'), JSON.stringify([entry('abc123'), entry('nofile'), entry('notglb')]));
    await writeFile(join(assets, 'abc123.glb'), tinyGlb());
    await writeFile(join(assets, 'notglb.glb'), 'not a glb at all, just text');
    await writeFile(join(dir, 'secret.glb'), tinyGlb());
    await writeFile(join(assets, 'unlisted.glb'), tinyGlb());
    await symlink(join(dir, 'secret.glb'), join(assets, 'link.glb')).catch(() => undefined);
    const { get } = await boot();
    for (const id of ['unlisted', 'nofile', 'notglb', 'link', '..%2Fsecret', '..%2F..%2Fsecret', '%2e%2e%2fsecret', 'abc123%2F..%2Fsecret', 'abc%00123', 'ABC%20', 'local%3A3dfuture%3A..%2Fsecret', 'polyhaven%3Asofa_03', 'a'.repeat(80)]) {
      const r = await get(`/api/assets/meshes/${id}.glb`);
      expect([id, r.status]).toEqual([id, 404]);
    }
    expect((await get('/api/assets/meshes/..%2Fsecret.glb')).status).toBe(404);
    expect((await get('/api/assets/meshes/abc123.gltf')).status).toBe(404);
    expect((await get('/api/assets/meshes/thumbs/abc123.webp')).status).toBe(404);
  });

  it('id validation: model ids are [A-Za-z0-9][A-Za-z0-9_-]*, optionally prefixed local:3dfuture:', () => {
    expect(localModelId('local:3dfuture:abc-1_X')).toBe('abc-1_X');
    expect(localModelId('abc')).toBe('abc');
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a.b', '-abc', '_abc', 'local:3dfuture:', 'local:3dfuture:../x', 'other:abc', 'a b', 'a'.repeat(42)]) {
      expect([bad, localModelId(bad)]).toEqual([bad, undefined]);
    }
  });

  it('loopback Host, allowed Origin and Sec-Fetch-Site are enforced like the product routes', async () => {
    await writeFile(join(assets, 'catalog.json'), JSON.stringify([entry('abc123')]));
    await writeFile(join(assets, 'abc123.glb'), tinyGlb());
    const { get } = await boot();
    for (const path of ['/api/assets/meshes/catalog.json', '/api/assets/meshes/abc123.glb']) {
      expect((await get(path, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await get(path, { host: 'evil.example' })).status).toBe(403);
      expect((await get(path, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect((await get(path, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
      expect((await get(path, { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
      expect((await get(path, { 'sec-fetch-site': 'none' })).status).toBe(200);
      expect((await get(path, { 'sec-fetch-site': 'same-site', origin: ORIGIN })).status).toBe(200);
      expect((await get(path)).status).toBe(200); // no browser headers: curl, the MCP
    }
  });
});

describe('Sec-Fetch-Site on product routes', () => {
  it('same-site from another localhost port is refused unless the Origin is allowed', () => {
    const allowed = [ORIGIN];
    expect(foreignProductRequest(undefined, 'same-site', allowed)).toBe(true);
    expect(foreignProductRequest(undefined, 'cross-site', allowed)).toBe(true);
    expect(foreignProductRequest(undefined, 'same-origin', allowed)).toBe(false);
    expect(foreignProductRequest(undefined, 'none', allowed)).toBe(false);
    expect(foreignProductRequest(undefined, undefined, allowed)).toBe(false);
    expect(foreignProductRequest(ORIGIN, 'same-site', allowed)).toBe(false);
    expect(foreignProductRequest('http://localhost:3000', 'same-site', allowed)).toBe(true);
  });

  it('through the app: a page on http://localhost:9999 cannot read provider data', async () => {
    const { get } = await boot({ enabled: ['mock'] });
    expect((await get('/api/providers', { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await get('/api/providers', { 'sec-fetch-site': 'same-site', origin: 'http://localhost:9999' })).status).toBe(403);
    expect((await get('/api/providers', { 'sec-fetch-site': 'same-site', origin: ORIGIN })).status).toBe(200);
  });
});

describe('GET /api/products/:id/photo', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const routes = (photo: Response) =>
    [
      [/search-result-page/, json(JSON.parse(fixture('ikea-fr/search-kallax.json')))],
      [/^https:\/\/www\.ikea\.com\/fr\/fr\/p\//, text(fixture('ikea-fr/product-kallax-80275887.html'))],
      [/^https:\/\/www\.ikea\.com\/fr\/fr\/images\//, photo],
    ] as Parameters<typeof fakeFetch>[1];

  it('proxies the image with sniffed MIME, no-store, a locked-down CSP, and guards Origin', async () => {
    const { get, f } = await boot({ enabled: ['ikea-fr'] }, routes(new Response(JPEG, { headers: { 'content-type': 'text/html' } })));
    const r = await get('/api/products/ikea-fr%3A80275887/photo', { origin: ORIGIN });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(JPEG);
    await get('/api/products/ikea-fr%3A80275887/photo');
    expect(f.calls.filter((c) => /images\//.test(c.url))).toHaveLength(1); // memory-cached
    expect((await get('/api/products/ikea-fr%3A80275887/photo', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await get('/api/products/ikea-fr%3A80275887/photo', { 'sec-fetch-site': 'same-site' })).status).toBe(403);
  });

  it('an SVG or HTML "photo" is refused; a provider without photos answers 404', async () => {
    const { get } = await boot({ enabled: ['ikea-fr', 'mock'] }, routes(new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } })));
    expect((await get('/api/products/ikea-fr%3A80275887/photo')).status).toBe(404);
    expect((await get('/api/products/mock%3AMOCK-BED-160/photo')).status).toBe(404);
    expect((await get('/api/products/garbage/photo')).status).toBe(404);
  });
});

describe('redaction', () => {
  it('provider error messages are redacted in the response and in the log', async () => {
    const logs: string[] = [];
    const { get } = await boot({ enabled: ['pasted-url'], logs });
    // the URL carries a secret-looking token; the refusal message must not echo it anywhere
    const r = await get('/api/products/search?q=x&provider=nope-s3cret-key');
    const body = JSON.stringify(await r.json());
    expect(body).not.toContain('s3cret-key');
    expect(logs.join('\n')).not.toContain('s3cret-key');
  });
});

describe('/api/commands author.kind (documented trust)', () => {
  it('with FLAT_TOKEN set every write, whatever the author, needs the bearer token', async () => {
    const { app } = await boot({ token: 'tok-123' });
    const send = (headers: Record<string, string>) =>
      app.request('/api/commands', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ id: 'x1', author: { kind: 'llm' }, commands: [] }) });
    expect((await send({})).status).toBe(401);
    expect((await send({ authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await send({ authorization: 'Bearer tok-123' })).status).not.toBe(401);
  });
});
