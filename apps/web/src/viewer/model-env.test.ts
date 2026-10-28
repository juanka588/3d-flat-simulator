import { describe, expect, it, vi } from 'vitest';
import { createCatalogLoader, hdModelsBase, libraryModelUrl } from './model-env';

const entry = (id: string, file: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, source: 'cc0', licence: 'CC-BY-4.0', credit: '"x" by y, Sketchfab, CC-BY-4.0 (https://sketchfab.com/3d-models/x)', category: 'sofa',
  styleTags: [], nativeDims: { w: 2, d: 0.9, h: 0.8 }, anchor: [0, 0, 0], front: '+z', file, ...extra,
});
const respond = (routes: Record<string, unknown>): typeof fetch =>
  vi.fn(async (url: string | URL | Request) => {
    const body = routes[String(url)];
    return body === undefined ? new Response('nope', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

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
    const catalog = await createCatalogLoader({ fetcher, url: () => '/models/catalog.json', hdUrl: () => '/models-hd/catalog.json' })();
    expect(catalog.list().map((a) => [a.id, a.tier])).toEqual([['polyhaven:a', undefined], ['sketchfab:b', 'hd']]);
  });
  it('falls back to the light tier when the HD catalog is missing or broken', async () => {
    const missing = respond({ '/models/catalog.json': [entry('polyhaven:a', 'a.glb')] });
    expect((await createCatalogLoader({ fetcher: missing, url: () => '/models/catalog.json', hdUrl: () => '/models-hd/catalog.json' })()).list().map((a) => a.id)).toEqual(['polyhaven:a']);
    const broken = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('-hd') ? new Response('{not json', { status: 200 }) : new Response(JSON.stringify([entry('polyhaven:a', 'a.glb')]), { status: 200 })) as unknown as typeof fetch;
    expect((await createCatalogLoader({ fetcher: broken, url: () => '/models/catalog.json', hdUrl: () => '/models-hd/catalog.json' })()).list()).toHaveLength(1);
  });
  it('tells onLoaded about the fetched assets once', async () => {
    const onLoaded = vi.fn();
    const load = createCatalogLoader({ fetcher: respond({ '/models/catalog.json': [entry('polyhaven:a', 'a.glb')], '/models-hd/catalog.json': [entry('sketchfab:b', 'b.glb')] }), url: () => '/models/catalog.json', hdUrl: () => '/models-hd/catalog.json', onLoaded });
    await load();
    await load();
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded.mock.calls[0]![0].map((a: { id: string }) => a.id)).toEqual(['polyhaven:a', 'sketchfab:b']);
  });
  it('fetches the catalogs once', async () => {
    const fetcher = respond({ '/models/catalog.json': [], '/models-hd/catalog.json': [] });
    const load = createCatalogLoader({ fetcher, url: () => '/models/catalog.json', hdUrl: () => '/models-hd/catalog.json' });
    await load();
    await load();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
