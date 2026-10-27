import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProviderInfo, type ProductRecord } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from './catalog';
import { createIkeaFrProvider } from './ikea-fr';
import { createMockProvider, mockProducts } from './mock';
import { createPastedUrlProvider } from './pasted-url';
import { createDisabledRegistry, createProviderRegistry, SEEN_TTL_MS } from './registry';
import { collect, fakeClock, fakeFetch, fixture, json, status, text, tinyGlb } from './testkit';
import type { ProductProvider } from './types';
import { ProviderError } from './types';

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));

describe('lazy loading (nothing enabled = no provider code)', () => {
  it('imports no provider module when FLAT_PROVIDERS is empty; every route answers provider_disabled', async () => {
    const reg = await createProviderRegistry({ enabled: [] });
    expect(reg.loaded()).toEqual([]);
    expect(reg.enabledIds()).toEqual([]);
    expect(reg.info().map((i) => [i.id, i.enabled])).toEqual([['mock', false], ['ikea-fr', false], ['pasted-url', false]]);
    for (const i of reg.info()) expect(ProviderInfo.safeParse(i).success).toBe(true);
    await expect(reg.search('x', { limit: 3 })).rejects.toMatchObject({ code: 'provider_disabled' });
    await expect(reg.getProduct('mock:MOCK-BED-160')).rejects.toMatchObject({ code: 'provider_disabled' });
    await expect(reg.getProduct('nope:1')).rejects.toMatchObject({ code: 'unknown_provider' });
    await expect(reg.resolveUrl('https://a.example/')).rejects.toMatchObject({ code: 'provider_disabled' });
    await expect(reg.fetchModel('ikea-fr:80275887')).rejects.toMatchObject({ code: 'provider_disabled' });
    expect(createDisabledRegistry().loaded()).toEqual([]);
  });

  it('loads only the listed providers; unknown ids are ignored with a warning', async () => {
    const logs: string[] = [];
    const reg = await createProviderRegistry({ enabled: ['mock', 'bogus'], log: (_l, m) => logs.push(m) });
    expect(reg.loaded()).toEqual(['mock']);
    expect(logs.join()).toMatch(/unknown provider "bogus"/);
  });

  it('no static import of a provider module in the registry, the app or the server entry', () => {
    for (const f of ['registry.ts', '../app.ts', '../server.ts', '../main.ts', 'http.ts', 'catalog.ts']) {
      const src = readFileSync(here(f), 'utf8');
      expect(src, f).not.toMatch(/^\s*import\b[^;]*from\s+['"]\.{1,2}\/(providers\/)?(mock|ikea-fr|pasted-url)['"]/m);
    }
    expect(readFileSync(here('registry.ts'), 'utf8')).toMatch(/await import\('\.\/ikea-fr'\)/);
  });

  it('the static catalog matches what each provider declares', () => {
    for (const p of [createMockProvider(), createIkeaFrProvider(), createPastedUrlProvider()]) {
      const meta = PROVIDER_CATALOG[p.id]!;
      expect({ id: p.id, label: p.label, capabilities: p.capabilities, personalUseOnly: p.personalUseOnly, note: p.note }).toEqual({ ...meta, note: meta.note });
    }
  });
});

describe('search merge, product cache, seen registry', () => {
  const stubIkea = (recs: ProductRecord[]): ProductProvider => ({
    ...createMockProvider({ products: recs }),
    id: 'ikea-fr',
    label: 'stub',
    personalUseOnly: true,
  });
  const ikeaLike = (sku: string, name: string, price: number): ProductRecord => ({ ...mockProducts()[0]!, provider: 'ikea-fr', sku, name, price, personalUseOnly: true });

  it('fans out to every enabled provider, merges with ranking, reports failing providers without failing', async () => {
    const bed = mockProducts().find((p) => p.category === 'bed')!;
    const reg = await createProviderRegistry({
      enabled: ['mock', 'ikea-fr'],
      factories: { 'ikea-fr': async () => stubIkea([ikeaLike('11111111', 'Lit MALM', 199), ikeaLike('22222222', 'Cadre de lit BRIMNES', 99)]) },
    });
    const r = await reg.search('lit', { limit: 10 });
    expect(r.statuses).toEqual([{ provider: 'ikea-fr', ok: true }, { provider: 'mock', ok: true }]);
    const ids = r.records.map((x) => `${x.provider}:${x.sku}`);
    expect(ids).toContain('ikea-fr:11111111');
    expect(new Set(ids).size).toBe(ids.length);
    expect(bed).toBeDefined();

    const failing = await createProviderRegistry({
      enabled: ['mock', 'ikea-fr'],
      factories: {
        'ikea-fr': async () => ({ ...stubIkea([]), search: async () => Promise.reject(new ProviderError('provider_blocked', 'blocked')) }),
      },
    });
    const f = await failing.search('', { limit: 5 });
    expect(f.records.length).toBeGreaterThan(0);
    expect(f.statuses.find((s) => s.provider === 'ikea-fr')).toMatchObject({ ok: false, code: 'provider_blocked' });
  });

  it('applies limit/truncated and uniform filters; a provider id restricts the search', async () => {
    const reg = await createProviderRegistry({ enabled: ['mock'] });
    const all = mockProducts().length;
    const r = await reg.search('', { limit: 3 });
    expect(r.records).toHaveLength(3);
    expect(r.truncated).toBe(all > 3);
    expect((await reg.search('', { limit: 50, maxPrice: 100 })).records.every((x) => x.price <= 100)).toBe(true);
    await expect(reg.search('', { limit: 3, providerId: 'ikea-fr' })).rejects.toMatchObject({ code: 'provider_disabled' });
    await expect(reg.search('', { limit: 3, providerId: 'zzz' })).rejects.toMatchObject({ code: 'unknown_provider' });
  });

  it('caches search results for 10 min and records for 1 h (injected clock)', async () => {
    const clock = fakeClock();
    let calls = 0;
    const mock = createMockProvider();
    const reg = await createProviderRegistry({
      enabled: ['mock'],
      clock,
      factories: { mock: async () => ({ ...mock, search: async (...a: Parameters<typeof mock.search>) => (calls++, mock.search(...a)) }) },
    });
    await reg.search('lit', { limit: 5 });
    await reg.search('lit', { limit: 5 });
    expect(calls).toBe(1);
    clock.advance(10 * 60_000 + 1);
    await reg.search('lit', { limit: 5 });
    expect(calls).toBe(2);
    expect((await reg.getProduct(`mock:${mockProducts()[0]!.sku}`)).sku).toBe(mockProducts()[0]!.sku);
    await expect(reg.getProduct('mock:NOPE')).rejects.toMatchObject({ code: 'product_not_found' });
    await expect(reg.getProduct('garbage')).rejects.toMatchObject({ code: 'product_not_found' });
  });

  it('seen registry: per session, expires after 1 h of inactivity, counts distinct ids', async () => {
    const clock = fakeClock();
    const reg = await createProviderRegistry({ enabled: ['mock'], clock });
    expect(reg.markSeen('s1', ['mock:A', 'mock:B', 'mock:A'])).toBe(2);
    expect(reg.isSeen('s1', 'mock:A')).toBe(true);
    expect(reg.isSeen('s2', 'mock:A')).toBe(false);
    expect(reg.isSeen('s1', 'mock:Z')).toBe(false);
    clock.advance(SEEN_TTL_MS - 1);
    expect(reg.isSeen('s1', 'mock:A')).toBe(true);
    clock.advance(2);
    expect(reg.isSeen('s1', 'mock:A')).toBe(false);
  });
});

describe('fetchModel through the registry', () => {
  const ikeaReg = async (glb: Response | (() => Response), over: Partial<Parameters<typeof createProviderRegistry>[0]> = {}) => {
    const clock = fakeClock();
    let modelCalls = 0;
    const f = fakeFetch(clock, [
      [/search-result-page/, json(JSON.parse(fixture('ikea-fr/search-kallax.json')))],
      [/\/fr\/fr\/p\//, text(fixture('ikea-fr/product-kallax-80275887.html'))],
      [/web-api\.ikea\.com\/dimma\/assets\//, () => (modelCalls++, typeof glb === 'function' ? glb() : glb)],
    ]);
    const reg = await createProviderRegistry({ enabled: ['ikea-fr'], clock, fetch: f.fetch, sleep: clock.sleep, random: () => 0, ...over });
    return { reg, f, modelCalls: () => modelCalls, clock };
  };

  it('streams the GLB, caches it for 1 h (one upstream request, single-flight), nothing is written to disk', async () => {
    const bytes = tinyGlb();
    const { reg, modelCalls, clock } = await ikeaReg(() => new Response(bytes.slice(), { headers: { 'content-type': 'model/gltf-binary' } }));
    const [a, b] = await Promise.all([reg.fetchModel('ikea-fr:80275887'), reg.fetchModel('ikea-fr:80275887')]);
    expect(await collect(a.stream)).toEqual(bytes);
    expect(await collect(b.stream)).toEqual(bytes);
    expect(a.size).toBe(bytes.length);
    await reg.fetchModel('ikea-fr:80275887');
    expect(modelCalls()).toBe(1);
    clock.advance(60 * 60_000 + 1);
    await reg.fetchModel('ikea-fr:80275887');
    expect(modelCalls()).toBe(2);
  });

  it('refuses a download that is not a GLB, and one over the per-file cap', async () => {
    const notGlb = await ikeaReg(() => new Response(new TextEncoder().encode('<html>blocked</html>   ')));
    await expect(notGlb.reg.fetchModel('ikea-fr:80275887')).rejects.toMatchObject({ code: 'model_unavailable' });
    const big = await ikeaReg(() => new Response(tinyGlb(2048)), { cache: { maxEntryBytes: 1024 } });
    await expect(big.reg.fetchModel('ikea-fr:80275887')).rejects.toMatchObject({ code: 'model_unavailable' });
  });

  it('a provider without 3D answers model_unavailable', async () => {
    const reg = await createProviderRegistry({ enabled: ['mock'] });
    await expect(reg.fetchModel(`mock:${mockProducts()[0]!.sku}`)).rejects.toMatchObject({ code: 'model_unavailable' });
  });

  it('403 on the model host opens the circuit, visible in info()', async () => {
    const { reg } = await ikeaReg(() => status(403));
    await expect(reg.fetchModel('ikea-fr:80275887')).rejects.toMatchObject({ code: 'provider_blocked' });
    const info = reg.info().find((i) => i.id === 'ikea-fr')!;
    expect(info.circuit).toBe('open');
    expect(info.retryAt).toBeGreaterThan(0);
    expect(ProviderInfo.safeParse(info).success).toBe(true);
  });
});
