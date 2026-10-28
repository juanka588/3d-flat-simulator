import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderInfo, type ProductRecord } from '@flat/scene';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IKEA_FR_META } from './catalog';
import { openLocalCatalog } from './local/catalog';
import { entryFor, makeGlb, recordFor, tinyWebp, writeCatalog } from './local/fixtures';
import { createProviderRegistry } from './registry';
import { collect, fakeClock } from './testkit';
import type { LocalCatalogSource, ProductProvider } from './types';

/** Priority: the local catalogue answers first and offline; the live IKEA provider is a fallback (fewer results than the limit) or on request (`live`). */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flat-priority-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-28T12:00:00Z');

async function localWith(n: number): Promise<LocalCatalogSource> {
  const glb = await makeGlb({ size: [1, 0.5, 0.5] });
  const entries = Array.from({ length: n }, (_, i) => entryFor({ sku: `1000000${i}`, name: `LOCALSOFA${i} Canapé ${i} places`, category: 'sofa', typeName: 'Canapé', price: 100 + i, has3d: i % 2 === 0 }));
  const models: Record<string, Uint8Array> = {};
  for (const e of entries) if (e.has3d) models[e.record.sku] = glb;
  await writeCatalog(dir, entries, { models, photos: { '10000000': await tinyWebp() } });
  return (await openLocalCatalog(dir, { now: () => NOW }))!;
}

/** A live IKEA stand-in that records what it was asked. */
function liveStub(records: ProductRecord[] = []) {
  const calls = { search: 0, get: 0, model: 0, photo: 0 };
  const provider: ProductProvider = {
    id: 'ikea-fr',
    label: IKEA_FR_META.label,
    capabilities: IKEA_FR_META.capabilities,
    personalUseOnly: true,
    async search(_q, opts) {
      calls.search++;
      return records.slice(0, opts.limit);
    },
    async get(sku) {
      calls.get++;
      const r = records.find((x) => x.sku === sku);
      if (!r) throw Object.assign(new Error('x'), { code: 'product_not_found' });
      return r;
    },
    async fetchModel() {
      calls.model++;
      return { stream: new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0, 0, 0, 0, 0, 0, 0, 0])).body!, contentType: 'model/gltf-binary' };
    },
    async fetchPhoto() {
      calls.photo++;
      throw new Error('live photo must not be fetched');
    },
  };
  return { provider, calls };
}

const liveRecords = (...skus: string[]) => skus.map((sku) => recordFor({ sku, name: `LIVESOFA${sku} Canapé`, category: 'sofa', fetchedAt: '2026-10-28T11:00:00.000Z' }));

async function registry(local: LocalCatalogSource | undefined, live?: ReturnType<typeof liveStub>) {
  const clock = fakeClock(NOW);
  return createProviderRegistry({ enabled: live ? ['ikea-fr'] : [], clock, ...(local ? { local } : {}), ...(live ? { factories: { 'ikea-fr': async () => live.provider } } : {}) });
}

describe('search: local first, live as a fallback', () => {
  it('answers from the local catalogue alone when it has enough results; the live provider is not touched', async () => {
    const live = liveStub(liveRecords('80000001'));
    const reg = await registry(await localWith(6), live);
    const r = await reg.search('canapé', { limit: 4 });
    expect(r.records.map((x) => x.sku)).toEqual(['10000000', '10000002', '10000004', '10000001']); // products with a checked 3D model rank first
    expect([...r.sources!.values()]).toEqual(['local', 'local', 'local', 'local']);
    expect(live.calls.search).toBe(0);
    expect(r.statuses).toEqual([{ provider: 'ikea-fr-local', ok: true }]);
    expect(r.truncated).toBe(true);
  });

  it('works with no live provider enabled at all (offline)', async () => {
    const reg = await registry(await localWith(3));
    const r = await reg.search('canape', { limit: 8 });
    expect(r.records).toHaveLength(3);
    expect(r.truncated).toBe(false);
    expect(reg.enabledIds()).toEqual([]);
    expect(reg.localInfo?.()).toMatchObject({ count: 3 });
    const none = await reg.search('zzz', { limit: 8 });
    expect(none.records).toEqual([]); // no error: the catalogue simply has none
  });

  it('falls back to the live provider when the local results are fewer than the limit, local ones first', async () => {
    const live = liveStub(liveRecords('80000001', '80000002', '10000001' /* also local: not repeated */));
    const reg = await registry(await localWith(2), live);
    const r = await reg.search('canapé', { limit: 5 });
    expect(live.calls.search).toBe(1);
    expect(r.records.map((x) => x.sku)).toEqual(['10000000', '10000001', '80000001', '80000002']);
    expect(r.sources!.get('ikea-fr:10000000')).toBe('local');
    expect(r.sources!.get('ikea-fr:80000001')).toBe('live');
    expect(r.sources!.get('ikea-fr:10000001')).toBe('local');
    expect(r.statuses.map((s) => s.provider).sort()).toEqual(['ikea-fr', 'ikea-fr-local']);
  });

  it('asks the live provider as well when live: true, even with enough local results', async () => {
    const live = liveStub(liveRecords('80000001'));
    const reg = await registry(await localWith(6), live);
    const r = await reg.search('canapé', { limit: 4, live: true });
    expect(live.calls.search).toBe(1);
    expect(r.records.map((x) => x.sku).slice(0, 4)).toEqual(['10000000', '10000002', '10000004', '10000001']);
  });

  it('reports live: true on a server without live IKEA instead of failing', async () => {
    const reg = await registry(await localWith(2));
    const r = await reg.search('canapé', { limit: 4, live: true });
    expect(r.records).toHaveLength(2);
    expect(r.statuses).toContainEqual(expect.objectContaining({ provider: 'ikea-fr', ok: false, code: 'provider_disabled' }));
  });

  it('a live failure keeps the local results (the circuit of the shop never blocks the catalogue)', async () => {
    const live = liveStub();
    live.provider.search = async () => {
      throw Object.assign(new Error('blocked'), { code: 'provider_blocked' });
    };
    const reg = await registry(await localWith(2), live);
    const r = await reg.search('canapé', { limit: 6 });
    expect(r.records).toHaveLength(2);
    expect(r.statuses.find((s) => s.provider === 'ikea-fr')).toMatchObject({ ok: false });
  });

  it('provider filters: ikea-fr-local never goes live; ikea-fr is local first then live', async () => {
    const live = liveStub(liveRecords('80000001'));
    const reg = await registry(await localWith(2), live);
    const only = await reg.search('canapé', { limit: 6, providerId: 'ikea-fr-local' });
    expect(only.records).toHaveLength(2);
    expect(live.calls.search).toBe(0);
    const both = await reg.search('canapé', { limit: 6, providerId: 'ikea-fr' });
    expect(both.records.map((x) => x.sku)).toEqual(['10000000', '10000001', '80000001']);
  });

  it('lists the local tier in the provider list as one more provider', async () => {
    const reg = await registry(await localWith(1));
    const infos = reg.info();
    expect(infos[0]).toMatchObject({ id: 'ikea-fr-local', enabled: true, circuit: 'closed', personalUseOnly: true });
    for (const i of infos) expect(ProviderInfo.safeParse(i).success).toBe(true);
    expect((await registry(undefined)).info().some((i) => i.id === 'ikea-fr-local')).toBe(false);
  });
});

describe('get, model and photo: local records first (same ikea-fr:<sku> ids)', () => {
  it('get_product reads the local record, with its snapshot date and staleness', async () => {
    const live = liveStub(liveRecords('80000001'));
    const reg = await registry(await localWith(2), live);
    const rec = await reg.getProduct('ikea-fr:10000001');
    expect(rec).toMatchObject({ sku: '10000001', fetchedAt: '2026-10-27T10:00:00.000Z' });
    expect(live.calls.get).toBe(0);
    expect(reg.productSource?.('ikea-fr:10000001')).toEqual({ source: 'local', stale: false });
    expect(reg.productSource?.('ikea-fr:80000001')).toEqual({ source: 'live', stale: false });
    expect((await reg.getProduct('ikea-fr:80000001')).sku).toBe('80000001'); // not in the catalogue: live
    expect(live.calls.get).toBe(1);
  });

  it('an unknown ikea-fr product with no live provider is product_not_found, not provider_disabled', async () => {
    const reg = await registry(await localWith(1));
    await expect(reg.getProduct('ikea-fr:80000001')).rejects.toMatchObject({ code: 'product_not_found' });
  });

  it('streams the local GLB first; a product listed without a model is model_unavailable and never downloaded live', async () => {
    const live = liveStub(liveRecords('10000001'));
    const reg = await registry(await localWith(2), live);
    const ok = await reg.fetchModel('ikea-fr:10000000');
    expect((await collect(ok.stream)).byteLength).toBeGreaterThan(100);
    expect(ok.contentType).toBe('model/gltf-binary');
    await expect(reg.fetchModel('ikea-fr:10000001')).rejects.toMatchObject({ code: 'model_unavailable' });
    expect(live.calls.model).toBe(0);
    await reg.fetchModel('ikea-fr:80000001').catch(() => undefined); // not in the catalogue: the live provider is asked
    expect(live.calls.model + live.calls.get).toBeGreaterThan(0);
  });

  it('serves the local photo and does not prefetch local models', async () => {
    const live = liveStub();
    const reg = await registry(await localWith(1), live);
    const photo = await reg.fetchPhoto('ikea-fr:10000000');
    expect(photo.contentType).toBe('image/webp');
    expect(live.calls.photo).toBe(0);
    reg.prefetchModels?.(['ikea-fr:10000000']);
    expect(live.calls.model).toBe(0);
  });

  it('without a local catalogue everything behaves as before', async () => {
    const live = liveStub(liveRecords('80000001'));
    const reg = await registry(undefined, live);
    const r = await reg.search('canapé', { limit: 4 });
    expect(r.records.map((x) => x.sku)).toEqual(['80000001']);
    expect(live.calls.search).toBe(1);
    expect(reg.localInfo?.()).toBeUndefined();
  });
});
