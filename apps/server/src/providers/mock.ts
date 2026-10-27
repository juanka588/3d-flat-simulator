import { matchProducts, ProductRecord, type ProviderCapabilities } from '@flat/scene';
import productsFixture from '@flat/scene/fixtures/products.json';
import { ProviderError, type ProductProvider, type ProviderContext, type SearchOptions } from './types';

/** Id of the in-memory provider used by tests, demos and the early-checkpoint furnishing. */
export const MOCK_PROVIDER_ID = 'mock';

/** The fixture products (`packages/scene/fixtures/products.json`) parsed as `ProductRecord`s; throws if any is invalid. */
export function mockProducts(): ProductRecord[] {
  return (productsFixture as unknown[]).map((p, i) => {
    const r = ProductRecord.safeParse(p);
    if (!r.success) throw new Error(`products.json[${i}] is not a valid ProductRecord: ${r.error.message}`);
    return r.data;
  });
}

export interface MockProviderOptions {
  /** Replace the fixture products (tests). */
  products?: readonly ProductRecord[];
}

const CAPABILITIES: ProviderCapabilities = { search: true, model3d: false, dims: 'structured', resolveUrl: true };

/**
 * In-memory provider over the fixture products: deterministic, no network. `resolveUrl` matches a
 * product page URL of the fixture. It has no 3D model (`capabilities.model3d` is false), so the mesh
 * chain falls to lookalike / parametric, which is exactly what lanes A, D and F need to test.
 */
export function createMockProvider(options: MockProviderOptions = {}): ProductProvider {
  const products = options.products ?? mockProducts();
  const bySku = new Map(products.map((p) => [p.sku, p]));
  return {
    id: MOCK_PROVIDER_ID,
    label: 'Mock catalog (offline fixtures)',
    capabilities: CAPABILITIES,
    personalUseOnly: false,
    note: 'Fictional products for tests and demos.',
    async search(query: string, opts: SearchOptions, _ctx: ProviderContext) {
      void _ctx;
      return matchProducts(products, {
        q: query,
        limit: opts.limit,
        ...(opts.category !== undefined ? { category: opts.category } : {}),
        ...(opts.minPrice !== undefined ? { minPrice: opts.minPrice } : {}),
        ...(opts.maxPrice !== undefined ? { maxPrice: opts.maxPrice } : {}),
        ...(opts.maxDims?.w !== undefined ? { maxW: opts.maxDims.w } : {}),
        ...(opts.maxDims?.d !== undefined ? { maxD: opts.maxDims.d } : {}),
        ...(opts.maxDims?.h !== undefined ? { maxH: opts.maxDims.h } : {}),
      }).matches;
    },
    async get(sku: string) {
      const p = bySku.get(sku);
      if (!p) throw new ProviderError('product_not_found', `mock provider has no product "${sku}"`);
      return p;
    },
    async resolveUrl(url: string) {
      const p = products.find((x) => x.url === url);
      if (!p) throw new ProviderError('url_not_allowed', `mock provider does not know the URL ${url}`);
      return p;
    },
  };
}
