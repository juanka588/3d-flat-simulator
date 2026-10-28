import { describe, expect, it, vi } from 'vitest';
import { catalogFromAssets, catalogWithout, createCatalogLoader, fetchCatalogAssets, hdModelsBase, parseCatalogJson } from './catalog-loader';
import { libraryModelUrl, providerModelUrl, serverMeshUrl } from './urls';

const entry = (id: string, file: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, source: 'cc0', licence: 'CC-BY-4.0', credit: '"x" by y, Sketchfab, CC-BY-4.0 (https://sketchfab.com/3d-models/x)', category: 'sofa',
  styleTags: [], nativeDims: { w: 2, d: 0.9, h: 0.8 }, anchor: [0, 0, 0], front: '+z', file, ...extra,
});
const respond = (routes: Record<string, unknown>): typeof fetch =>
  vi.fn(async (url: string | URL | Request) => {
    const body = routes[String(url)];
    return body === undefined ? new Response('nope', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
const URLS = { url: () => '/models/catalog.json', hdUrl: () => '/models-hd/catalog.json' };

describe('HD tier URLs', () => {
  it('derives models-hd from the models base, under any base path', () => {
    expect(hdModelsBase('/models/')).toBe('/models-hd/');
    expect(hdModelsBase('/3d-flat-simulator/models/')).toBe('/3d-flat-simulator/models-hd/');
  });
  it('loads light assets from models/ and HD assets from models-hd/, never a retailer or CDN host', () => {
    const light = { id: 'polyhaven:a', source: 'cc0' as const, file: 'a.glb' };
    const hd = { id: 'sketchfab:b', source: 'cc0' as const, file: 'b.glb', tier: 'hd' as const };
    expect(libraryModelUrl(light, null, '/base/models/')).toBe('/base/models/a.glb');
    expect(libraryModelUrl(hd, null, '/base/models/')).toBe('/base/models-hd/b.glb');
  });
});

describe('catalog loader with the HD tier', () => {
  it('merges both catalogs and marks the second one as tier hd', async () => {
    const fetcher = respond({
      '/models/catalog.json': [entry('polyhaven:a', 'a.glb')],
      '/models-hd/catalog.json': [entry('sketchfab:b', 'b.glb')],
    });
    const catalog = await createCatalogLoader(fetcher, URLS)();
    expect(catalog.list().map((a) => [a.id, a.tier])).toEqual([['polyhaven:a', undefined], ['sketchfab:b', 'hd']]);
  });
  it('falls back to the light tier when the HD catalog is missing or broken', async () => {
    const missing = respond({ '/models/catalog.json': [entry('polyhaven:a', 'a.glb')] });
    expect((await createCatalogLoader(missing, URLS)()).list().map((a) => a.id)).toEqual(['polyhaven:a']);
    const broken = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('-hd') ? new Response('{not json', { status: 200 }) : new Response(JSON.stringify([entry('polyhaven:a', 'a.glb')]), { status: 200 })) as unknown as typeof fetch;
    expect((await createCatalogLoader(broken, URLS)()).list()).toHaveLength(1);
  });
  it('tells onLoaded about the fetched assets once', async () => {
    const onLoaded = vi.fn();
    const load = createCatalogLoader(respond({ '/models/catalog.json': [entry('polyhaven:a', 'a.glb')], '/models-hd/catalog.json': [entry('sketchfab:b', 'b.glb')] }), URLS, { onLoaded });
    await load();
    await load();
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded.mock.calls[0]![0].map((a: { id: string }) => a.id)).toEqual(['polyhaven:a', 'sketchfab:b']);
  });
  it('fetches the catalogs once', async () => {
    const fetcher = respond({ '/models/catalog.json': [], '/models-hd/catalog.json': [] });
    const load = createCatalogLoader(fetcher, URLS);
    await load();
    await load();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('catalog JSON', () => {
  it('keeps only MeshAsset keys, accepts the list shapes and skips invalid entries', () => {
    const a = { ...entry('polyhaven:a', 'a.glb'), thumb: 't.webp', sha256: 'abc' };
    expect(parseCatalogJson([a, { id: 'bad' }, null]).map((x) => x.id)).toEqual(['polyhaven:a']);
    expect(Object.keys(parseCatalogJson([a])[0]!)).not.toContain('sha256');
    expect(parseCatalogJson({ assets: [a] })).toHaveLength(1);
    expect(parseCatalogJson({ models: [a] })).toHaveLength(1);
    expect(parseCatalogJson('nope')).toEqual([]);
  });
  it('forces the tier of a fetched catalog and ignores a failing fetch', async () => {
    const fetcher = respond({ '/c.json': [entry('polyhaven:a', 'a.glb'), entry('x:b', 'b.glb', { source: '3dfuture' })] });
    expect((await fetchCatalogAssets(fetcher, '/c.json', 'hd')).map((x) => [x.id, x.tier])).toEqual([['polyhaven:a', 'hd']]);
    expect(await fetchCatalogAssets(fetcher, '/missing.json')).toEqual([]);
  });
  it('builds a catalog where the first of two equal ids wins, and drops excluded ids', () => {
    const [a1, a2, b] = [entry('a', 'one.glb'), entry('a', 'two.glb'), entry('b', 'b.glb')].map((e) => parseCatalogJson([e])[0]!);
    const catalog = catalogFromAssets([a1!, a2!, b!]);
    expect(catalog.list().map((x) => x.file)).toEqual(['one.glb', 'b.glb']);
    expect(catalogWithout(catalog, new Set(['a'])).list().map((x) => x.id)).toEqual(['b']);
    expect(catalogWithout(catalog, new Set())).toBe(catalog);
  });
});

describe('URL builders', () => {
  it('builds the provider and server mesh URLs; an invalid product id has none', () => {
    expect(providerModelUrl('http://h:1', 'mock:SOFA 1')).toBe('http://h:1/api/assets/products/mock/SOFA%201.glb');
    expect(providerModelUrl('http://h:1', 'not-a-product-id')).toBeUndefined();
    expect(serverMeshUrl('http://h:1', '3dfuture:abc')).toBe('http://h:1/api/assets/meshes/3dfuture%3Aabc.glb');
    expect(libraryModelUrl({ id: '3dfuture:abc', source: '3dfuture' }, 'http://h:1', '/models/')).toBe('http://h:1/api/assets/meshes/3dfuture%3Aabc.glb');
    expect(libraryModelUrl({ id: '3dfuture:abc', source: '3dfuture' }, null, '/models/')).toBeUndefined();
  });
});
