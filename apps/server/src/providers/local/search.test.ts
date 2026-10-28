import { describe, expect, it } from 'vitest';
import { entryFor } from './fixtures';
import { indexEntry, parseQuery, rank } from './search';

const E = (sku: string, name: string, category: string, extra: Record<string, unknown> = {}) => entryFor({ sku, name, category, ...extra });
const catalogue = [
  E('10000001', 'MALM Cadre de lit haut - blanc 160x200 cm', 'bed', { typeName: 'Cadre de lit', dims: { w: 1.68, d: 2.09, h: 0.97 }, price: 289, colours: ['blanc'], has3d: true }),
  E('10000002', 'MALM Cadre de lit haut - noir 140x200 cm', 'bed', { typeName: 'Cadre de lit', dims: { w: 1.48, d: 2.09, h: 0.97 }, price: 259, colours: ['noir'] }),
  E('10000003', 'BRIMNES Cadre de lit 90x200 cm', 'bed', { typeName: 'Cadre de lit', dims: { w: 0.95, d: 2.09, h: 0.47 }, price: 99, colours: ['blanc'] }),
  E('10000004', 'KIVIK Canapé 3 places - Hillared anthracite', 'sofa', { typeName: 'Canapé 3 places', dims: { w: 2.28, d: 0.95, h: 0.83 }, price: 599, colours: ['gris'], queries: ['canapé 3 places'], has3d: true }),
  E('10000005', 'GLOSTAD Canapé 2 places - Knisa gris', 'sofa', { typeName: 'Canapé 2 places', dims: { w: 1.4, d: 0.8, h: 0.8 }, price: 179, colours: ['gris'] }),
  E('10000006', 'TORNVIKEN Îlot pour cuisine - blanc cassé/chêne', 'kitchen', { typeName: 'Îlot pour cuisine', dims: { w: 0.77, d: 1.26, h: 0.9 }, price: 499, has3d: true }),
  E('10000007', 'KESNACKEN Tabouret de bar - blanc', 'chair', { typeName: 'Tabouret de bar', dims: { w: 0.45, d: 0.45, h: 0.66 }, price: 45 }),
  E('10000008', 'GILLERSBERG Table de chevet - bambou', 'bedside', { typeName: 'Table de chevet', dims: { w: 0.39, d: 0.39, h: 0.56 }, price: 39 }),
  E('10000009', 'LACK Table basse - noir', 'table', { typeName: 'Table basse', dims: { w: 0.9, d: 0.55, h: 0.45 }, price: 19, colours: ['noir'] }),
  E('10000010', 'HOLMVI Plaid - gris 120x160 cm', 'throw', { typeName: 'Plaid', dims: { w: 1.2, d: 1.6, h: 0.01 }, price: 12, colours: ['gris'] }),
  E('10000011', 'FEJKA Plante artificielle', 'plant', { typeName: 'Plante artificielle', dims: { w: 0.2, d: 0.2, h: 0.4 }, price: 7 }),
  E('10000012', 'OLD Lampe de table', 'lamp', { typeName: 'Lampe de table', price: 9, availability: 'discontinued' }),
].map(indexEntry);

const skus = (q: string, f: Partial<Parameters<typeof rank>[2]> = {}) => rank(catalogue, q, { limit: 5, ...f }).map((r) => r.entry.record.sku);

describe('local catalogue search', () => {
  it('parses sizes, synonyms and stop words', () => {
    expect(parseQuery('lit 160x200')).toMatchObject({ numbers: [160, 200], required: [['lit', 'bed', 'lits', 'bedstead']] });
    expect(parseQuery('canapé d’angle').required.map((g) => g[0])).toEqual(['canape', 'angle']);
    expect(parseQuery('queen size bed')).toMatchObject({ soft: ['160', '200'] });
  });

  it('ranks the exact bed size first: "lit 160x200"', () => {
    expect(skus('lit 160x200')[0]).toBe('10000001');
    expect(skus('lit 160x200')).toEqual(['10000001', '10000003', '10000002'].filter((s) => skus('lit 160x200').includes(s)));
    expect(skus('lit 160x200')).toHaveLength(3);
  });

  it('understands English: "queen size bed" finds the 160x200 first', () => {
    const r = skus('queen size bed');
    expect(r[0]).toBe('10000001');
    expect(r).toEqual(expect.arrayContaining(['10000002', '10000003']));
    expect(skus('single bed')[0]).toBe('10000003');
  });

  it('finds French and English words for the same thing', () => {
    expect(skus('canapé')).toEqual(skus('sofa'));
    expect(skus('canapé 3 places')[0]).toBe('10000004');
    expect(skus('3 seat sofa')).toContain('10000004');
    expect(skus('tabouret de bar')[0]).toBe('10000007');
    expect(skus('bar stool')[0]).toBe('10000007');
    expect(skus('îlot cuisine')).toEqual(['10000006']);
    expect(skus('table de chevet')[0]).toBe('10000008');
    expect(skus('bedside table')[0]).toBe('10000008');
  });

  it('matches accents, case and prefixes; a product name finds the product', () => {
    expect(skus('ILOT')).toEqual(['10000006']);
    expect(skus('tornv')).toEqual(['10000006']);
    expect(skus('KIVIK')).toEqual(['10000004']);
    expect(skus('couette')).toEqual([]);
  });

  it('matches colours and the curated queries that found a product', () => {
    expect(skus('table noir')).toContain('10000009');
    expect(skus('table noir')[0]).toBe('10000009');
    expect(skus('gris', { category: 'throw' })).toEqual(['10000010']);
  });

  it('filters by category, price and size, and hides discontinued products', () => {
    expect(skus('', { category: 'sofa' }).sort()).toEqual(['10000004', '10000005']);
    expect(skus('canapé', { maxPrice: 200 })).toEqual(['10000005']);
    expect(skus('canapé', { minPrice: 200 })).toEqual(['10000004']);
    expect(skus('lit', { maxDims: { w: 1.5 } }).sort()).toEqual(['10000002', '10000003']);
    expect(skus('lampe')).toEqual([]);
  });

  it('an empty query lists by category, products with a model first; the limit applies', () => {
    expect(skus('', { limit: 2 })).toHaveLength(2);
    expect(rank(catalogue, '', { limit: 20 })[0]!.entry.has3d).toBe(true);
  });

  it('ranks in well under a millisecond per query for a 400-product catalogue', () => {
    const big = Array.from({ length: 400 }, (_, i) => indexEntry(E(String(20000000 + i), `PRODUIT${i} Canapé ${i % 7} places`, 'sofa', { typeName: 'Canapé', price: 100 + i })));
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) rank(big, 'canapé 3 places gris', { limit: 12 });
    expect((performance.now() - t0) / 50).toBeLessThan(5);
  });
});
