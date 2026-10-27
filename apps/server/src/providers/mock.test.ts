import { PROVIDER_ERROR_HINTS, ProductRecord, ProviderInfo } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { MOCK_PROVIDER_ID, createMockProvider, mockProducts } from './mock';
import { ProviderError, type ProviderContext } from './types';

const ctx: ProviderContext = {
  fetch: () => {
    throw new Error('the mock provider must not touch the network');
  },
  cache: { get: () => undefined, set: () => undefined, delete: () => undefined },
  clock: { now: () => 0 },
  log: () => undefined,
};

describe('mock provider', () => {
  const provider = createMockProvider();

  it('serves 12+ valid fictional EUR products', () => {
    const all = mockProducts();
    expect(all.length).toBeGreaterThanOrEqual(12);
    for (const p of all) {
      expect(ProductRecord.safeParse(p).success).toBe(true);
      expect([p.provider, p.currency, p.personalUseOnly]).toEqual(['mock', 'EUR', false]);
      expect(p.sku.startsWith('MOCK-')).toBe(true);
    }
  });

  it('declares its capabilities as a valid ProviderInfo', () => {
    const info = { id: provider.id, label: provider.label, capabilities: provider.capabilities, enabled: true, circuit: 'closed', personalUseOnly: provider.personalUseOnly };
    expect(ProviderInfo.safeParse(info).success).toBe(true);
    expect(provider.id).toBe(MOCK_PROVIDER_ID);
    expect(provider.fetchModel).toBeUndefined();
  });

  it('searches by text and filters', async () => {
    expect((await provider.search('wardrobe', { limit: 5 }, ctx)).map((p) => p.sku)).toEqual(['MOCK-WARD-SL100']);
    expect((await provider.search('', { limit: 50, category: 'bedside' }, ctx)).map((p) => p.sku).sort()).toEqual(['MOCK-NIGHT-OAK', 'MOCK-NIGHT-WHT']);
    expect((await provider.search('', { limit: 50, maxPrice: 50, maxDims: { h: 0.6 } }, ctx)).every((p) => p.price <= 50 && p.dims.h <= 0.6)).toBe(true);
    expect(await provider.search('spaceship', { limit: 5 }, ctx)).toEqual([]);
  });

  it('gets by sku and resolves a known URL', async () => {
    const bed = await provider.get('MOCK-BED-160', ctx);
    expect(bed.dims).toEqual({ w: 1.6, d: 2.0, h: 0.9 });
    expect((await provider.resolveUrl!(bed.url, ctx)).sku).toBe('MOCK-BED-160');
  });

  it('fails with ProviderError codes and default hints', async () => {
    const e1 = await provider.get('NOPE', ctx).catch((e) => e);
    expect(e1).toBeInstanceOf(ProviderError);
    expect([e1.code, e1.hint]).toEqual(['product_not_found', PROVIDER_ERROR_HINTS.product_not_found]);
    const e2 = await provider.resolveUrl!('https://elsewhere.example/x', ctx).catch((e) => e);
    expect(e2.code).toBe('url_not_allowed');
  });
});
