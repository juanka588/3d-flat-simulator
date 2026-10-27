import { describe, expect, it } from 'vitest';
import { ApiError, draftFromDimsError, fetchProviders, getProduct, recordWithUserDims, resolveUrl, searchProducts, thumbnailUrl } from './api';

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
  it('shows a photo only in server mode', () => {
    expect(thumbnailUrl('https://x/p.jpg', null)).toBeUndefined();
    expect(thumbnailUrl('https://x/p.jpg', ref)).toBe('https://x/p.jpg');
  });
});
