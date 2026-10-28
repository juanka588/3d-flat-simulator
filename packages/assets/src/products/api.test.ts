import { describe, expect, it } from 'vitest';
import products from '@flat/scene/fixtures/products.json';
import { ProviderInfo, matchProducts } from './api';
import { ProductRecord } from './records';

const records = (products as unknown[]).map((p) => ProductRecord.parse(p));

describe('ProviderInfo', () => {
  const info = {
    id: 'ikea-fr',
    label: 'IKEA France',
    capabilities: { search: true, model3d: true, dims: 'structured', resolveUrl: false },
    enabled: true,
    circuit: 'closed',
    personalUseOnly: true,
  };
  it('parses a valid entry and rejects bad circuit states', () => {
    expect(ProviderInfo.safeParse(info).success).toBe(true);
    expect(ProviderInfo.safeParse({ ...info, circuit: 'broken' }).success).toBe(false);
    expect(ProviderInfo.safeParse({ ...info, capabilities: { ...info.capabilities, dims: 'maybe' } }).success).toBe(false);
  });
});


describe('matchProducts', () => {
  const ids = (q: Parameters<typeof matchProducts>[1]) => matchProducts(records, q).matches.map((p) => p.sku);
  it('finds by name, tag, colour and category, accent-insensitively', () => {
    expect(ids({ q: 'bed' })).toContain('MOCK-BED-160');
    expect(ids({ q: 'BEDSIDE oak' })).toEqual(['MOCK-NIGHT-OAK']);
    expect(ids({ q: 'wall cabinet' })).toEqual(['MOCK-WCAB-80']);
    expect(ids({ q: 'zzz' })).toEqual([]);
  });
  it('filters and limits deterministically', () => {
    expect(ids({ q: '', category: 'sofa' })).toEqual(['MOCK-SOFA-3']);
    expect(ids({ q: '', maxPrice: 40 }).every((sku) => records.find((p) => p.sku === sku)!.price <= 40)).toBe(true);
    expect(ids({ q: '', maxW: 0.5, maxH: 0.6 })).toEqual(expect.arrayContaining(['MOCK-NIGHT-WHT']));
    const r = matchProducts(records, { q: '', limit: 3 });
    expect(r.matches).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(ids({ q: '', limit: 50 })).toEqual(ids({ q: '', limit: 50 }));
  });
});
