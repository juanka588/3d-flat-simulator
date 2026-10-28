import { describe, expect, it } from 'vitest';
import { ApiError, draftFromDimsError, fetchProviders, fetchProvidersFull, getProduct, recordWithUserDims, resolveUrl, searchProducts, fetchProductPhoto } from './api';

const ref = { origin: 'http://127.0.0.1:8787', token: 'tok' };
const reply = (status: number, body: unknown, log: { url: string; init: RequestInit }[] = []): typeof fetch =>
  (async (url: string, init: RequestInit) => {
    log.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

describe('product api', () => {
  it('reads providers and searches with the query', async () => {
    const log: { url: string; init: RequestInit }[] = [];
    const providers = await fetchProviders(ref, reply(200, { providers: [{ id: 'mock', label: 'Mock', capabilities: { search: true, model3d: false, dims: 'structured', resolveUrl: true }, enabled: true, circuit: 'closed', personalUseOnly: false }] }, log));
    expect(providers[0]!.id).toBe('mock');
    await searchProducts(ref, { q: 'bed', provider: 'mock' }, reply(200, { results: [], providers: [], truncated: false }, log));
    expect(log[1]!.url).toBe('http://127.0.0.1:8787/api/products/search?q=bed&limit=12&provider=mock');
    expect((log[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });
  it('asks for the live shop only when the toggle is on, and reads the local catalogue summary', async () => {
    const log: { url: string; init: RequestInit }[] = [];
    await searchProducts(ref, { q: 'canape' }, reply(200, { results: [], providers: [], truncated: false }, log));
    await searchProducts(ref, { q: 'canape', live: true }, reply(200, { results: [], providers: [], truncated: false }, log));
    expect(log[0]!.url).not.toContain('live');
    expect(log[1]!.url).toBe('http://127.0.0.1:8787/api/products/search?q=canape&limit=12&live=true');
    const local = { id: 'ikea-fr-local', count: 321, withModels: 250, builtAt: '2026-10-27T12:00:00.000Z', stale: false };
    const full = await fetchProvidersFull(ref, reply(200, { providers: [], localCatalog: local }));
    expect(full.localCatalog).toEqual(local);
    expect((await fetchProvidersFull(ref, reply(200, { providers: [] }))).localCatalog).toBeUndefined();
    const res = await searchProducts(ref, { q: 'x' }, reply(200, { results: [{ productId: 'ikea-fr:80275887', provider: 'ikea-fr', name: 'KALLAX', price: 59.99, currency: 'EUR', priceTtc: true, dims: { w: 0.77, d: 0.39, h: 1.47 }, dimsSource: 'structured', category: 'shelf', mount: 'floor', colours: [], has3d: true, personalUseOnly: true, source: 'local', fetchedAt: '2026-10-27T10:00:00.000Z', stale: true }], providers: [], truncated: false }));
    expect(res.results[0]).toMatchObject({ source: 'local', stale: true });
  });
  it('turns a server error into an ApiError with code, hint and details', async () => {
    const f = reply(422, { ok: false, errors: [{ code: 'product_dims_missing', message: 'no depth', hint: 'type it', details: { draft: { provider: 'pasted-url' } } }] });
    const err = await resolveUrl(ref, 'https://x.example/p', f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('product_dims_missing');
    expect(draftFromDimsError(err as ApiError)).toEqual({ provider: 'pasted-url' });
    const gone = await getProduct(ref, 'mock:X', (async () => { throw new Error('down'); }) as unknown as typeof fetch).catch((e: unknown) => e);
    expect((gone as ApiError).code).toBe('unreachable');
  });
  it('completes a draft with the sizes the user typed (cm), as user dims', () => {
    const draft = { provider: 'pasted-url', sku: 'abcdef0123456789', name: 'Canape', url: 'https://www.meubles-exemple.fr/p/canape', price: 450, currency: 'EUR', priceTtc: true, category: 'sofa' };
    const r = recordWithUserDims(draft, { w: 200, d: 90, h: 85 }, new Date('2026-10-27T10:00:00Z'));
    expect(r.dims).toEqual({ w: 2, d: 0.9, h: 0.85 });
    expect(r.dimsSource).toBe('user');
    expect(() => recordWithUserDims(draft, { w: 0, d: 90, h: 85 })).toThrow();
  });
  it('reads the photo through the local proxy with fetch (an Origin is sent), never from the retailer', async () => {
    const log: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => (log.push({ url, init }), new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 }))) as unknown as typeof fetch;
    const blob = await fetchProductPhoto(ref, 'mock:A B', f);
    expect(blob.type).toBe('image/png');
    expect(log[0]!.url).toBe('http://127.0.0.1:8787/api/products/mock%3AA%20B/photo');
    expect((log[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });
  it('rejects without a server, on a missing photo and on a non-image answer', async () => {
    const f404 = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
    const fHtml = (async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(fetchProductPhoto(null, 'mock:A')).rejects.toMatchObject({ code: 'no_server' });
    await expect(fetchProductPhoto(ref, 'mock:A', f404)).rejects.toMatchObject({ code: 'no_photo' });
    await expect(fetchProductPhoto(ref, 'mock:A', fHtml)).rejects.toMatchObject({ code: 'no_photo' });
  });

});
