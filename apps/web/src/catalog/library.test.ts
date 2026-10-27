import { describe, expect, it, vi } from 'vitest';
import { loadLibraryModels, splitCredit } from './library';

const entry = (id: string, file: string, thumb: string) => ({
  id, name: id, source: 'cc0', licence: 'CC-BY-4.0', credit: '"x" by y, Sketchfab, CC-BY-4.0 (https://sketchfab.com/3d-models/x)', category: 'sofa',
  styleTags: [], nativeDims: { w: 2, d: 0.9, h: 0.8 }, anchor: [0, 0, 0], front: '+z', file, thumb,
});
const respond = (routes: Record<string, unknown>): typeof fetch =>
  vi.fn(async (url: string | URL | Request) => {
    const body = routes[String(url)];
    return body === undefined ? new Response('nope', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

describe('loadLibraryModels', () => {
  it('lists the light tier then the HD tier, each with its own thumbnail folder', async () => {
    const fetcher = respond({
      '/models/catalog.json': [entry('polyhaven:a', 'a.glb', 'thumbs/a.webp')],
      '/models-hd/catalog.json': [entry('sketchfab:b', 'b.glb', 'thumbs/b.webp')],
    });
    const models = await loadLibraryModels(fetcher, '/models/');
    expect(models.map((m) => [m.asset.id, m.asset.tier, m.thumb])).toEqual([
      ['polyhaven:a', undefined, '/models/thumbs/a.webp'],
      ['sketchfab:b', 'hd', '/models-hd/thumbs/b.webp'],
    ]);
  });
  it('still lists the light tier when there is no HD tier', async () => {
    const models = await loadLibraryModels(respond({ '/models/catalog.json': [entry('polyhaven:a', 'a.glb', 'thumbs/a.webp')] }), '/models/');
    expect(models.map((m) => m.asset.id)).toEqual(['polyhaven:a']);
  });
});

describe('splitCredit', () => {
  it('separates the source URL from the credit text', () => {
    expect(splitCredit('"Sofa" by Ann, Sketchfab, CC-BY-4.0 (https://sketchfab.com/3d-models/sofa-1)')).toEqual({ text: '"Sofa" by Ann, Sketchfab, CC-BY-4.0', url: 'https://sketchfab.com/3d-models/sofa-1' });
    expect(splitCredit('"Chair" by Bo, Poly Haven, CC0-1.0')).toEqual({ text: '"Chair" by Bo, Poly Haven, CC0-1.0' });
  });
});
