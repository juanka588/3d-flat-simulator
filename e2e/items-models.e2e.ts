/**
 * M5.12 (viewer items and model loading): items drawn from GLB models. The model server is stubbed with
 * `page.route` (a synthetic sofa GLB at http://models.test, and a CC0 library file under /models/), and the
 * resolver is replaced by a small fake so the chain (provider -> lookalike -> parametric) is exercised
 * independently of the real catalog.
 */
import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import { sofaGlb } from '../apps/web/src/viewer/synthetic-glb';
import { charmeFlat, flat, loadScene, openApp, rendered } from './helpers';

const ORIGIN = 'http://models.test';
const DIMS = { w: 2.1, d: 0.95, h: 0.85 };
const LOOKALIKE = {
  id: 'test:sofa',
  name: 'Test sofa',
  source: 'cc0',
  licence: 'CC0-1.0',
  category: 'sofa',
  styleTags: [],
  nativeDims: { w: 2, d: 0.9, h: 0.9 },
  anchor: [0, 0, 0],
  front: '+z',
  file: 'test-sofa.glb',
};

function sofaItem(id: string, position: [number, number], rotation = 0, mesh: unknown = { kind: 'provider' }) {
  return {
    id,
    assetId: 'product:mock',
    position,
    elevation: 0,
    rotation,
    roomId: 'sejour',
    productRef: { provider: 'mock', sku: 'SOFA-1' },
    product: { provider: 'mock', sku: 'SOFA-1', name: 'Test sofa', url: 'https://example.com/sofa', price: 299, currency: 'EUR', dims: DIMS, category: 'sofa', snapshotAt: '2026-10-27T10:00:00Z' },
    mesh,
  };
}

function sceneWith(...items: unknown[]) {
  return { ...charmeFlat, items: [...(charmeFlat['items'] as unknown[]), ...items] };
}

interface Stub {
  requests: string[];
}

/** Serves the synthetic sofa as the provider model (or 404) and as the library lookalike (or 404), and the catalog. */
async function stub(page: Page, opts: { provider?: 'ok' | '404'; library?: 'ok' | '404'; catalog?: boolean } = {}): Promise<Stub> {
  const log: Stub = { requests: [] };
  const glb = Buffer.from(sofaGlb());
  page.on('request', (r: Request) => {
    if (/\/models\/|\/api\/assets\//.test(r.url())) log.requests.push(r.url());
  });
  await page.route(`${ORIGIN}/**`, (route) =>
    opts.provider === '404' ? route.fulfill({ status: 404, body: 'not found' }) : route.fulfill({ status: 200, contentType: 'model/gltf-binary', headers: { 'access-control-allow-origin': '*' }, body: glb }),
  );
  await page.route('**/models/test-sofa.glb', (route) => (opts.library === '404' ? route.fulfill({ status: 404, body: 'nope' }) : route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: glb })));
  await page.route('**/models/catalog.json', (route) =>
    opts.catalog === false ? route.fulfill({ status: 404, body: 'nope' }) : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([LOOKALIKE]) }),
  );
  return log;
}

/** provider (when the chain allows it) -> lookalike `test:sofa` (when in the catalog) -> parametric. */
async function fakeResolver(page: Page): Promise<void> {
  await flat(page, (f) =>
    f.setMeshResolver((item, ctx) => {
      const dims = item.dims ?? (item.product && item.product.dims);
      const pid = item.productRef ? `${item.productRef.provider}:${item.productRef.sku}` : null;
      if (item.mesh && item.mesh.kind === 'provider' && pid && ctx.providerModelAvailable && ctx.providerModelAvailable(pid)) {
        return { source: 'provider', dims, scale: [1, 1, 1], product: pid, reason: 'fake provider' };
      }
      const asset = ctx.catalog.get('test:sofa');
      if (asset) return { source: 'lookalike', dims, scale: [1, 1, 1], asset, reason: 'fake lookalike' };
      return { source: 'parametric', dims, scale: [1, 1, 1], generator: { id: 'sofa', params: {} }, reason: 'fake parametric' };
    }),
  );
}

const bounds = (page: Page, id: string) => page.evaluate((i) => window.__flat!.itemBounds(i), id);

function expectBox(b: { min: number[]; max: number[] } | null, w: number, h: number, d: number, cx: number, cz: number, elevation = 0): void {
  expect(b).not.toBeNull();
  const tol = 0.01;
  expect(Math.abs(b!.max[0]! - b!.min[0]! - w)).toBeLessThanOrEqual(tol);
  expect(Math.abs(b!.max[1]! - b!.min[1]! - h)).toBeLessThanOrEqual(tol);
  expect(Math.abs(b!.max[2]! - b!.min[2]! - d)).toBeLessThanOrEqual(tol);
  expect(Math.abs(b!.min[1]! - elevation)).toBeLessThanOrEqual(tol);
  expect(Math.abs((b!.min[0]! + b!.max[0]!) / 2 - cx)).toBeLessThanOrEqual(tol);
  expect(Math.abs((b!.min[2]! + b!.max[2]!) / 2 - cz)).toBeLessThanOrEqual(tol);
}

test('the default Charme load makes zero model requests', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => {
    if (/\/models\/|\/api\/assets\/|\.glb|draco|meshopt/i.test(r.url())) requests.push(r.url());
  });
  await openApp(page);
  expect(requests).toEqual([]);
  const stats = await flat(page, (f) => f.modelStats());
  expect(stats).toMatchObject({ loaded: 0, pending: 0, failed: 0, requests: [] });
  expect(await flat(page, (f) => f.stats().meshes)).toContain('items');
});

test('a provider model is fitted to product.dims, in the item frame, at any rotation', async ({ page }) => {
  await openApp(page);
  const log = await stub(page);
  await fakeResolver(page);
  await flat(page, (f) => f.setModelOrigin('http://models.test'));
  expect(await loadScene(page, sceneWith(sofaItem('sofa-1', [2.45, 4.2])))).toBe(true);
  const stats = await flat(page, (f) => f.modelStats());
  expect(stats).toMatchObject({ loaded: 1, pending: 0, failed: 0, sources: { 'sofa-1': 'provider', 'tv-sejour': 'parametric' } });
  expect(stats.requests).toEqual([`${ORIGIN}/api/assets/products/mock/SOFA-1.glb`]);
  expect(stats.warnings).toEqual([]);
  expectBox(await bounds(page, 'sofa-1'), DIMS.w, DIMS.h, DIMS.d, 2.45, 4.2);
  // The default Charme TV still comes from the shell mesh.
  expect(await flat(page, (f) => f.stats().meshes)).toEqual(expect.arrayContaining(['items', 'items-glb']));

  expect(await loadScene(page, sceneWith({ ...sofaItem('sofa-1', [2.45, 4.2], 90), elevation: 0 }))).toBe(true);
  expectBox(await bounds(page, 'sofa-1'), DIMS.d, DIMS.h, DIMS.w, 2.45, 4.2);
  expect(log.requests.filter((u) => u.startsWith(ORIGIN))).toHaveLength(1); // the second scene reused the cached model
});

test('a placeholder box with the final dims shows while the model loads', async ({ page }) => {
  await openApp(page);
  await stub(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(`${ORIGIN}/**`, async (route) => {
    await gate;
    await route.fulfill({ status: 200, contentType: 'model/gltf-binary', headers: { 'access-control-allow-origin': '*' }, body: Buffer.from(sofaGlb()) });
  });
  await fakeResolver(page);
  await flat(page, (f) => f.setModelOrigin('http://models.test'));
  // Not awaited: loadScene would wait for the model.
  await page.evaluate((j) => void window.__flat!.loadScene(j), sceneWith(sofaItem('sofa-1', [2.45, 4.2])));
  await expect.poll(() => flat(page, (f) => f.stats().meshes.includes('item-placeholder'))).toBe(true);
  expect((await flat(page, (f) => f.modelStats())).sources['sofa-1']).toBe('placeholder');
  const placeholder = await page.evaluate(() => {
    const s = window.__flat!;
    return { pending: s.modelStats().pending };
  });
  expect(placeholder.pending).toBe(1);
  release();
  await rendered(page);
  expect((await flat(page, (f) => f.modelStats())).sources['sofa-1']).toBe('provider');
  expect(await flat(page, (f) => f.stats().meshes.includes('item-placeholder'))).toBe(false);
  expectBox(await bounds(page, 'sofa-1'), DIMS.w, DIMS.h, DIMS.d, 2.45, 4.2);
});

test('a 404 on the provider model falls to the lookalike, then to parametric, and the scene is untouched', async ({ page }) => {
  await openApp(page);
  await stub(page, { provider: '404' });
  await fakeResolver(page);
  await flat(page, (f) => f.setModelOrigin('http://models.test'));
  const scene = sceneWith(sofaItem('sofa-1', [2.45, 4.2]));
  expect(await loadScene(page, scene)).toBe(true);
  expect(await flat(page, (f) => f.modelStats())).toMatchObject({ loaded: 1, failed: 1, sources: { 'sofa-1': 'lookalike' } });
  expectBox(await bounds(page, 'sofa-1'), DIMS.w, DIMS.h, DIMS.d, 2.45, 4.2);
  const items = await flat(page, (f) => f.getScene().items);
  expect(items.find((i) => i.id === 'sofa-1')?.mesh).toEqual({ kind: 'provider' });
});

test('when the library file is gone too, the item ends parametric and the shell draws it', async ({ page }) => {
  await openApp(page);
  await stub(page, { provider: '404', library: '404' });
  await fakeResolver(page);
  await flat(page, (f) => f.setModelOrigin('http://models.test'));
  expect(await loadScene(page, sceneWith(sofaItem('sofa-1', [2.45, 4.2])))).toBe(true);
  const stats = await flat(page, (f) => f.modelStats());
  expect(stats).toMatchObject({ loaded: 0, failed: 2, sources: { 'sofa-1': 'parametric' } });
  expect(await flat(page, (f) => f.itemBounds('sofa-1'))).toBeNull();
  expect((await flat(page, (f) => f.getScene().items)).find((i) => i.id === 'sofa-1')?.mesh).toEqual({ kind: 'provider' });
});

test('Pages mode (no server) makes zero provider requests: the lookalike shows and the item is flagged offline', async ({ page }) => {
  await openApp(page);
  const log = await stub(page);
  await fakeResolver(page); // a resolver that offers the provider whenever it is asked
  expect(await flat(page, (f) => f.connection().mode)).toBe('local');
  expect(await loadScene(page, sceneWith(sofaItem('sofa-1', [2.45, 4.2])))).toBe(true);
  const stats = await flat(page, (f) => f.modelStats());
  expect(stats).toMatchObject({ loaded: 1, failed: 0, sources: { 'sofa-1': 'lookalike' }, offline: ['sofa-1'] });
  expect(log.requests.filter((u) => u.includes('/api/assets') || u.startsWith(ORIGIN))).toEqual([]);
  expect(log.requests.some((u) => u.endsWith('/models/test-sofa.glb'))).toBe(true);
  expectBox(await bounds(page, 'sofa-1'), DIMS.w, DIMS.h, DIMS.d, 2.45, 4.2);
  // A resolver that wrongly insists on the provider is still refused.
  await flat(page, (f) => f.setMeshResolver((item) => ({ source: 'provider', dims: item.product.dims, scale: [1, 1, 1], product: 'mock:SOFA-1', reason: 'insists' })));
  expect(await loadScene(page, sceneWith(sofaItem('sofa-2', [1.5, 4.2])))).toBe(true);
  expect(log.requests.filter((u) => u.includes('/api/assets') || u.startsWith(ORIGIN))).toEqual([]);
});

test('model items are pickable, cast shadows, and stay within the draw-call budget (instanced when repeated)', async ({ page }) => {
  await openApp(page);
  await stub(page);
  await fakeResolver(page);
  await flat(page, (f) => f.setModelOrigin('http://models.test'));
  const sofas = [sofaItem('sofa-1', [1.4, 4.4]), sofaItem('sofa-2', [3.6, 4.4], 180), sofaItem('sofa-3', [2.5, 5.4], 90)];
  expect(await loadScene(page, sceneWith(...sofas))).toBe(true);
  const stats = await flat(page, (f) => f.modelStats());
  expect(stats).toMatchObject({ loaded: 3, sources: { 'sofa-1': 'provider', 'sofa-2': 'provider', 'sofa-3': 'provider' } });
  expect(stats.requests).toHaveLength(1); // one fetch for three items
  expect(stats.cache.models).toBe(1);
  expectBox(await bounds(page, 'sofa-1'), DIMS.w, DIMS.h, DIMS.d, 1.4, 4.4);
  expectBox(await bounds(page, 'sofa-2'), DIMS.w, DIMS.h, DIMS.d, 3.6, 4.4);
  expectBox(await bounds(page, 'sofa-3'), DIMS.d, DIMS.h, DIMS.w, 2.5, 5.4);

  expect((await flat(page, (f) => f.stats())).shadowCasterMeshes).toContain('items-glb');
  await page.evaluate(() => window.__flat!.clearFrameCalls());
  await rendered(page);
  await page.evaluate(() => window.__flat!.setLighting({ sunOn: true } as never));
  await rendered(page);
  const calls = await page.evaluate(() => window.__flat!.frameCalls());
  // The model has two materials (fabric, legs): at most 3 extra draw calls per distinct model on top of the 70 steady budget.
  expect(Math.max(...calls)).toBeLessThanOrEqual(70 + 3);

  // Picking: click the middle of the first sofa (orbit, from above its seat).
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  await rendered(page);
  const p = await page.evaluate(() => window.__flat!.project([1.4, 0.5, 4.4]));
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId('properties')).toContainText('sofa-1');
});

test('a model that fails to decode behaves like a 404', async ({ page }) => {
  await openApp(page);
  await stub(page);
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', headers: { 'access-control-allow-origin': '*' }, body: 'this is not a glb' }));
  await fakeResolver(page);
  await flat(page, (f) => f.setModelOrigin('http://models.test'));
  expect(await loadScene(page, sceneWith(sofaItem('sofa-1', [2.45, 4.2])))).toBe(true);
  expect(await flat(page, (f) => f.modelStats())).toMatchObject({ failed: 1, sources: { 'sofa-1': 'lookalike' } });
});

test('real catalog and resolver, Pages mode: a bed product shows the committed CC0 lookalike at its exact dims', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => {
    if (/\/models\/|\/api\/assets\//.test(r.url())) requests.push(r.url());
  });
  await openApp(page);
  const dims = { w: 1.7, d: 2.0, h: 0.7 };
  const bed = {
    ...sofaItem('bed-1', [8.7, 6.0]),
    productRef: { provider: 'mock', sku: 'BED-1' },
    product: { provider: 'mock', sku: 'BED-1', name: 'Test bed', url: 'https://example.com/bed', price: 399, currency: 'EUR', dims, category: 'bed', snapshotAt: '2026-10-27T10:00:00Z' },
    mesh: undefined,
  };
  expect(await loadScene(page, sceneWith(bed))).toBe(true);
  const stats = await flat(page, (f) => f.modelStats());
  expect(stats.sources['bed-1']).toBe('lookalike');
  expect(stats.failed).toBe(0);
  expect(stats.warnings).toEqual([]);
  expect(requests.filter((u) => u.includes('/api/assets'))).toEqual([]);
  expect(requests.some((u) => u.endsWith('/models/catalog.json'))).toBe(true);
  expectBox(await bounds(page, 'bed-1'), dims.w, dims.h, dims.d, 8.7, 6.0);
});

// ---- HD tier (M5R step 2): the real catalog, the real resolver ----

const HD_DIMS = { w: 2.6, d: 1.2, h: 0.85 };
function hdSofa(id: string, position: [number, number]) {
  const item = sofaItem(id, position);
  return { ...item, dims: HD_DIMS, product: { ...item.product, dims: HD_DIMS } };
}

test('an item whose product fits an HD hero model loads it lazily from models-hd, at the exact dims', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => {
    if (/\/models-hd\/.*\.glb/.test(r.url())) requests.push(new URL(r.url()).pathname);
  });
  await openApp(page);
  expect(requests).toEqual([]);
  expect(await loadScene(page, sceneWith(hdSofa('sofa-hd', [2.45, 4.2])))).toBe(true);
  const stats = await flat(page, (f) => f.modelStats());
  expect(stats.sources['sofa-hd']).toBe('lookalike');
  expect(stats.failed).toBe(0);
  expect(requests).toEqual(['/models-hd/sofa_curved.glb']);
  expect(stats.warnings).toEqual([]);
  expectBox(await bounds(page, 'sofa-hd'), HD_DIMS.w, HD_DIMS.h, HD_DIMS.d, 2.45, 4.2);
});

test('when the HD file cannot be loaded the item falls back to the light tier or a generator, never a hole', async ({ page }) => {
  await page.route('**/models-hd/*.glb', (route) => route.fulfill({ status: 404, body: 'nope' }));
  await openApp(page);
  expect(await loadScene(page, sceneWith(hdSofa('sofa-hd', [2.45, 4.2])))).toBe(true);
  await flat(page, (f) => f.whenRendered());
  const stats = await flat(page, (f) => f.modelStats());
  // The only light sofa distorts more than 25% at these dims, so the chain ends at the generator (still a real, exact-size sofa).
  expect(['lookalike', 'parametric']).toContain(stats.sources['sofa-hd']);
  expect(stats.sources['sofa-hd']).not.toBe('placeholder');
  expect(stats.requests.some((u) => u.endsWith('/models-hd/sofa_curved.glb'))).toBe(true);
  expect(stats.pending).toBe(0);
});
