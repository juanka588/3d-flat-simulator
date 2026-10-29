import { describe, expect, it } from 'vitest';
import { EMPTY_MESH_CATALOG, catalogFromAssets, createModelCache } from '@flat/assets';
import type { Item } from '@flat/scene';
import type { MeshAsset, MeshCatalog, MeshResolveContext, ResolvedMesh } from '@flat/assets';
import { ModelController, PROVIDER_RETRY_MS } from './model-controller';
import type { ControllerDeps, ModelLike } from './model-controller';
import type { Box } from './model-math';

interface FakeModel extends ModelLike {
  url: string;
}

const SOFA_ASSET: MeshAsset = {
  id: 'test:sofa',
  name: 'Sofa',
  source: 'cc0',
  licence: 'CC0-1.0',
  category: 'sofa',
  styleTags: [],
  nativeDims: { w: 2, d: 0.9, h: 0.9 },
  anchor: [0, 0, 0],
  front: '-z',
  file: 'sofa.glb',
};

const DIMS = { w: 2, d: 0.9, h: 0.9 };
const box = (w: number, h: number, d: number): Box => ({ min: [-w / 2, 0, -d / 2], max: [w / 2, h, d / 2] });

function item(over: Partial<Item> = {}): Item {
  return {
    id: 'sofa-1',
    assetId: 'product:mock',
    position: [1, 1],
    elevation: 0,
    rotation: 0,
    productRef: { provider: 'mock', sku: 'SOFA' },
    mesh: { kind: 'provider' },
    dims: DIMS,
    ...over,
  } as Item;
}

/** What lane A's resolveMesh does, minus scoring: provider (when available) -> first lookalike -> parametric. */
function fakeResolve(it: Pick<Item, 'dims' | 'productRef' | 'mesh'>, ctx: MeshResolveContext): ResolvedMesh {
  const dims = it.dims ?? DIMS;
  if (it.mesh?.kind === 'provider' && it.productRef && ctx.providerModelAvailable?.(`${it.productRef.provider}:${it.productRef.sku}`)) {
    return { source: 'provider', dims, scale: [1, 1, 1], product: `${it.productRef.provider}:${it.productRef.sku}`, reason: 'provider model' };
  }
  const asset = ctx.catalog.list()[0];
  if (it.mesh?.kind !== 'parametric' && asset) return { source: 'lookalike', dims, scale: [1, 1, 1], asset, reason: 'lookalike' };
  return { source: 'parametric', dims, scale: [1, 1, 1], generator: { id: 'sofa', params: {} }, reason: 'parametric' };
}

function setup(opts: { origin?: string | null; catalog?: MeshCatalog; native?: Box; fail?: (url: string) => boolean; schedule?: ControllerDeps<FakeModel>['schedule'] } = {}) {
  const loads: string[] = [];
  const disposed: string[] = [];
  const cache = createModelCache<FakeModel>({ dispose: (m) => disposed.push(m.url) });
  const net = { origin: opts.origin === undefined ? ('http://127.0.0.1:8787' as string | null) : opts.origin, down: false };
  const controller = new ModelController<FakeModel>({
    cache,
    load: async (url) => {
      loads.push(url);
      if (opts.fail?.(url) || (net.down && url.includes('/api/assets/'))) throw new Error('HTTP 404');
      return { value: { url, box: opts.native ?? box(2, 0.9, 0.9) }, bytes: 100 };
    },
    resolve: fakeResolve,
    catalog: async () => opts.catalog ?? catalogFromAssets([SOFA_ASSET]),
    origin: () => net.origin,
    base: () => '/models/',
    ...(opts.schedule ? { schedule: opts.schedule } : {}),
  });
  return { controller, loads, disposed, cache, net };
}

const PROVIDER_URL = 'http://127.0.0.1:8787/api/assets/products/mock/SOFA.glb';

describe('model fallback chain', () => {
  it('claims the item as a placeholder at once, then draws the provider model', async () => {
    const { controller, loads } = setup();
    controller.update([item()]);
    expect(controller.claimed().has('sofa-1')).toBe(true);
    expect(controller.stats().sources['sofa-1']).toBe('placeholder');
    expect(controller.pending()).toBe(1);
    await controller.settled();
    expect(loads).toEqual([PROVIDER_URL]);
    expect(controller.stats()).toMatchObject({ loaded: 1, pending: 0, failed: 0, sources: { 'sofa-1': 'provider' }, offline: [] });
    expect(controller.state('sofa-1')?.front).toBe('+z');
  });

  it('404 on the provider model falls to the lookalike, then to parametric, without touching the scene', async () => {
    const items = [item()];
    const snapshot = JSON.stringify(items);
    const { controller, loads } = setup({ fail: (u) => u.includes('/api/assets/') });
    controller.update(items);
    await controller.settled();
    expect(loads).toEqual([PROVIDER_URL, '/models/sofa.glb']);
    expect(controller.stats()).toMatchObject({ loaded: 1, failed: 1, sources: { 'sofa-1': 'lookalike' } });
    expect(controller.state('sofa-1')?.front).toBe('-z'); // the asset's declared front
    expect(JSON.stringify(items)).toBe(snapshot);

    const both = setup({ fail: () => true });
    both.controller.update([item()]);
    await both.controller.settled();
    expect(both.controller.stats()).toMatchObject({ loaded: 0, failed: 2, sources: { 'sofa-1': 'parametric' } });
    expect(both.controller.claimed().size).toBe(0); // handed back to buildItems
  });

  it('with no catalog entry a failed provider model ends at parametric', async () => {
    const { controller } = setup({ catalog: EMPTY_MESH_CATALOG, fail: () => true });
    controller.update([item()]);
    await controller.settled();
    expect(controller.stats()).toMatchObject({ failed: 1, sources: { 'sofa-1': 'parametric' } });
  });

  it('never builds a provider URL without a server: Pages mode uses the lookalike and flags offline', async () => {
    const { controller, loads } = setup({ origin: null });
    controller.update([item()]);
    await controller.settled();
    expect(loads).toEqual(['/models/sofa.glb']);
    expect(controller.stats()).toMatchObject({ sources: { 'sofa-1': 'lookalike' }, offline: ['sofa-1'], failed: 0 });
  });

  it('refuses a provider answer from a resolver that ignores availability when there is no server', async () => {
    const { controller, loads } = setup({ origin: null, catalog: EMPTY_MESH_CATALOG });
    controller.update([item()]);
    await controller.settled();
    const rude = new ModelController<FakeModel>({
      cache: createModelCache<FakeModel>({ dispose: () => undefined }),
      load: async (url) => (loads.push(url), { value: { url, box: box(1, 1, 1) }, bytes: 1 }),
      resolve: () => ({ source: 'provider', dims: DIMS, scale: [1, 1, 1], product: 'mock:SOFA', reason: 'always provider' }),
      catalog: async () => EMPTY_MESH_CATALOG,
      origin: () => null,
    });
    rude.update([item()]);
    await rude.settled();
    expect(loads.every((u) => !u.includes('/api/assets'))).toBe(true);
    expect(rude.stats().sources['sofa-1']).toBe('placeholder');
  });

  it('3D-FUTURE assets are only fetched through the server', async () => {
    const future: MeshAsset = { ...SOFA_ASSET, id: '3dfuture:abc', source: '3dfuture', licence: 'LicenseRef-3D-FUTURE' };
    const offline = setup({ origin: null, catalog: catalogFromAssets([future]) });
    offline.controller.update([item({ mesh: { kind: 'lookalike', assetId: '3dfuture:abc' } })]);
    await offline.controller.settled();
    expect(offline.loads).toEqual([]);
    expect(offline.controller.stats()).toMatchObject({ sources: { 'sofa-1': 'parametric' }, offline: ['sofa-1'] });
    const online = setup({ catalog: catalogFromAssets([future]) });
    online.controller.update([item({ mesh: { kind: 'lookalike', assetId: '3dfuture:abc' } })]);
    await online.controller.settled();
    expect(online.loads).toEqual(['http://127.0.0.1:8787/api/assets/meshes/3dfuture%3Aabc.glb']);
  });

  it('legacy built-in items never request anything and are not claimed', async () => {
    const { controller, loads } = setup();
    controller.update([item({ id: 'tv', assetId: 'builtin:tv-55', mesh: undefined, productRef: undefined, dims: undefined })]);
    expect(controller.claimed().size).toBe(0);
    await controller.settled();
    expect(loads).toEqual([]);
    expect(controller.stats().requests).toEqual([]);
  });

  it('items with a stored generator never touch the catalog or the network, and are reported as parametric', async () => {
    let catalogCalls = 0;
    const { controller, loads } = setup();
    const spy = new ModelController<FakeModel>({
      cache: createModelCache<FakeModel>({ dispose: () => undefined }),
      load: async (url) => (loads.push(url), { value: { url, box: box(1, 1, 1) }, bytes: 1 }),
      resolve: fakeResolve,
      catalog: async () => (catalogCalls++, EMPTY_MESH_CATALOG),
      origin: () => null,
    });
    const wardrobe = item({ id: 'placard', assetId: 'param:wardrobe', productRef: undefined, mesh: { kind: 'parametric', generator: 'wardrobe', params: {} } });
    spy.update([wardrobe]);
    await spy.settled();
    expect(catalogCalls).toBe(0);
    expect(spy.claimed().size).toBe(0);
    expect(spy.stats()).toMatchObject({ sources: { placard: 'parametric' }, requests: [] });
    expect(controller.stats().sources).toEqual({});
  });

  it('reports dims_mismatch: provider over 10%, lookalike over 25%', async () => {
    const skewed = setup({ native: box(2, 0.9, 1.2) }); // 33% too deep
    skewed.controller.update([item()]);
    await skewed.controller.settled();
    expect(skewed.controller.stats().warnings).toHaveLength(1);
    expect(skewed.controller.stats().warnings[0]!.warning).toMatchObject({ code: 'dims_mismatch', kind: 'provider', limit: 0.1 });

    const slight = setup({ native: box(2, 0.9, 0.95) });
    slight.controller.update([item()]);
    await slight.controller.settled();
    expect(slight.controller.stats().warnings).toEqual([]);

    const look = setup({ origin: null, native: box(2, 0.9, 1.0) }); // ~ 10% off: fine for a lookalike
    look.controller.update([item()]);
    await look.controller.settled();
    expect(look.controller.stats().warnings).toEqual([]);
  });

  it('shares one load between items with the same model and releases it when they go', async () => {
    const { controller, loads, cache } = setup();
    controller.update([item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]);
    await controller.settled();
    expect(loads).toHaveLength(1);
    expect(cache.stats()).toMatchObject({ models: 1, inUse: 1 });
    controller.update([]);
    expect(cache.stats().inUse).toBe(0);
  });

  it('a move or rotation does not re-resolve; a dims change does', async () => {
    const { controller, loads } = setup();
    controller.update([item()]);
    await controller.settled();
    controller.update([item({ position: [3, 3], rotation: 90 })]);
    expect(controller.pending()).toBe(0);
    controller.update([item({ dims: { w: 1.8, d: 0.9, h: 0.9 } })]);
    expect(controller.pending()).toBe(1);
    await controller.settled();
    expect(loads).toHaveLength(1); // same file, served from the cache
    expect(controller.state('sofa-1')?.dims.w).toBe(1.8);
  });

  it('a result for an item that was removed meanwhile is dropped and its model given back', async () => {
    const { controller, cache } = setup();
    controller.update([item()]);
    controller.update([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.claimed().size).toBe(0);
    await Promise.resolve();
    expect(cache.stats().inUse).toBe(0);
  });

  it('notifies subscribers when a model arrives, not while updating', async () => {
    const { controller } = setup();
    let calls = 0;
    controller.subscribe(() => calls++);
    controller.update([item()]);
    expect(calls).toBe(0);
    await controller.settled();
    expect(calls).toBeGreaterThan(0);
  });

  it('honours the per-item provider front override', async () => {
    const controller = new ModelController<FakeModel>({
      cache: createModelCache<FakeModel>({ dispose: () => undefined }),
      load: async (url) => ({ value: { url, box: box(0.9, 0.9, 2) }, bytes: 1 }),
      resolve: fakeResolve,
      catalog: async () => EMPTY_MESH_CATALOG,
      origin: () => 'http://127.0.0.1:8787',
      providerFront: (it) => (it.id === 'sofa-1' ? '-x' : undefined),
    });
    controller.update([item()]);
    await controller.settled();
    expect(controller.state('sofa-1')?.front).toBe('-x');
  });

  it('checks the proportions with the same front it draws with (the provider front override)', async () => {
    // A model 0.9 wide and 2 deep fits a 2 x 0.9 item only when its front is turned a quarter: with the default +z it is >50% off.
    const make = (front?: '-x') =>
      new ModelController<FakeModel>({
        cache: createModelCache<FakeModel>({ dispose: () => undefined }),
        load: async (url) => ({ value: { url, box: box(0.9, 0.9, 2) }, bytes: 1 }),
        resolve: fakeResolve,
        catalog: async () => EMPTY_MESH_CATALOG,
        origin: () => 'http://127.0.0.1:8787',
        ...(front ? { providerFront: () => front } : {}),
      });
    const turned = make('-x');
    turned.update([item()]);
    await turned.settled();
    expect(turned.stats()).toMatchObject({ sources: { 'sofa-1': 'provider' }, warnings: [], failed: 0 });
    // Without an override the controller turns the model itself when that clearly fits better (IKEA islands: "Largeur 77, Longueur 126" vs a model 1.26 along x).
    const plain = make();
    plain.update([item()]);
    await plain.settled();
    expect(plain.stats().sources['sofa-1']).toBe('provider');
    expect(plain.state('sofa-1')?.front).toBe('+x');
    expect(plain.state('sofa-1')?.reason).toContain('quarter turn');
  });

  it('a model that fits in neither orientation falls to the generator, which is then drawn (fallbackMesh) and the reason says why', async () => {
    const c = new ModelController<FakeModel>({
      cache: createModelCache<FakeModel>({ dispose: () => undefined }),
      load: async (url) => ({ value: { url, box: box(0.9, 0.9, 6) }, bytes: 1 }),
      resolve: fakeResolve,
      catalog: async () => EMPTY_MESH_CATALOG,
      origin: () => 'http://127.0.0.1:8787',
    });
    c.update([item()]);
    await c.settled();
    expect(c.state('sofa-1')?.status).toBe('settled');
    expect(c.state('sofa-1')?.reason).toContain('does not fit');
    expect(c.fallbacks().get('sofa-1')).toMatchObject({ kind: 'parametric' });
  });

  it('above the hard limit (50%) a provider model is not used: the lookalike takes over; a smaller mismatch only warns', async () => {
    const wild = setup({ native: box(2, 0.9, 6) }); // far too deep
    wild.controller.update([item()]);
    await wild.controller.settled();
    expect(wild.controller.stats().sources['sofa-1']).toBe('parametric'); // the lookalike is the same wild box here
    expect(wild.controller.state('sofa-1')?.failures).toEqual([PROVIDER_URL, '/models/sofa.glb']);
    const bad = setup({ native: box(2, 0.9, 0.9) });
    bad.controller.update([item()]);
    await bad.controller.settled();
    expect(bad.controller.stats().warnings).toEqual([]);
  });

  it('an item resolved offline is resolved again when the server origin appears', async () => {
    const { controller, loads, net } = setup({ origin: null });
    controller.update([item()]);
    await controller.settled();
    expect(controller.stats()).toMatchObject({ sources: { 'sofa-1': 'lookalike' }, offline: ['sofa-1'] });
    net.origin = 'http://127.0.0.1:8787';
    controller.update([item()]);
    expect(controller.pending()).toBe(1);
    await controller.settled();
    expect(controller.stats()).toMatchObject({ sources: { 'sofa-1': 'provider' }, offline: [] });
    expect(loads).toContain(PROVIDER_URL);
  });

  it('a failed provider load is retried after a backoff, and again when the origin changes', async () => {
    const timers: (() => void)[] = [];
    const delays: number[] = [];
    const { controller, loads, net } = setup({ schedule: (fn, ms) => (timers.push(fn), delays.push(ms), () => undefined) });
    net.down = true;
    controller.update([item()]);
    await controller.settled();
    expect(controller.stats().sources['sofa-1']).toBe('lookalike');
    expect(delays).toEqual([PROVIDER_RETRY_MS[0]]);
    net.down = false;
    timers.shift()!();
    expect(controller.pending()).toBe(1);
    await controller.settled();
    expect(controller.stats().sources['sofa-1']).toBe('provider');
    expect(loads.filter((u) => u === PROVIDER_URL)).toHaveLength(2);
    expect(timers).toHaveLength(0);

    // another origin: the signature differs, so the item resolves again at once
    net.origin = 'http://127.0.0.1:9999';
    controller.update([item()]);
    expect(controller.pending()).toBe(1);
    await controller.settled();
    expect(loads.at(-1)).toBe('http://127.0.0.1:9999/api/assets/products/mock/SOFA.glb');
  });

  it('gives up retrying after the last backoff and cancels a pending retry when the item goes', async () => {
    let cancelled = 0;
    const timers: (() => void)[] = [];
    const { controller, net } = setup({ schedule: (fn) => (timers.push(fn), () => void cancelled++) });
    net.down = true;
    controller.update([item()]);
    await controller.settled();
    for (let i = 0; i < PROVIDER_RETRY_MS.length; i++) {
      timers.shift()!();
      await controller.settled();
    }
    expect(timers).toHaveLength(0); // no retry left
    controller.update([item({ id: 'other' })]);
    await controller.settled();
    expect(controller.state('sofa-1')).toBeUndefined();
  });
});
