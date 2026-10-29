import { afterEach, describe, expect, it } from 'vitest';
import { FakeImageMatcher, ImageMatchError, SidecarMatcher, setImageMatcher } from './imagegen';
import { setImageShrinker } from './imageContent';
import type { ImageShrinker } from './render/shrink';
import { connect, json } from './testing/inproc';
import { MockFlatApi } from './testing/mockFlatApi';

/** CG3: product / asset pictures for the model and `match_crop`, with a fake shrinker (no Chromium) and a fake matcher (no CLIP). */

const JPEG_B64 = 'AAECAw==';
class FakeShrinker implements ImageShrinker {
  readonly calls: { n: number; maxSide: number }[] = [];
  async shrinkAll(images: readonly { data: Uint8Array; contentType: string }[], maxSide: number) {
    this.calls.push({ n: images.length, maxSide });
    return images.map((i) => (i.data.length === 0 || i.contentType === 'image/x-broken' ? undefined : { data: JPEG_B64, mimeType: 'image/jpeg' as const, width: 100, height: 80 }));
  }
}

afterEach(() => {
  setImageShrinker(undefined);
  setImageMatcher(undefined);
});

type Content = { type: string; text?: string; data?: string; mimeType?: string };
const content = (r: unknown) => (r as { content: Content[] }).content;
const images = (r: unknown) => content(r).filter((c) => c.type === 'image');

async function setup() {
  const flat = new MockFlatApi();
  const shrinker = new FakeShrinker();
  setImageShrinker(shrinker);
  const c = await connect({}, flat);
  const ids = flat.products.map((p) => `${p.provider}:${p.sku}`);
  for (const id of ids) flat.photos.set(id, { status: 200, contentType: 'image/webp', body: new Uint8Array([1, 2, 3]) });
  return { ...c, flat, shrinker, ids };
}

describe('get_product photo', () => {
  it('returns one JPEG capped at 384 px, only when asked', async () => {
    const { client, shrinker, ids, flat } = await setup();
    const plain = await client.callTool({ name: 'get_product', arguments: { productId: ids[0] } });
    expect(images(plain)).toHaveLength(0);
    expect(flat.photoCalls).toEqual([]);
    const r = await client.callTool({ name: 'get_product', arguments: { productId: ids[0], photo: true } });
    expect(images(r)).toEqual([{ type: 'image', data: JPEG_B64, mimeType: 'image/jpeg' }]);
    expect(shrinker.calls).toEqual([{ n: 1, maxSide: 384 }]);
    expect(json(r as never).ok).toBe(true);
  });

  it('says so when there is no photo, and still returns the facts', async () => {
    const { client, flat, ids } = await setup();
    flat.photos.clear();
    const r = await client.callTool({ name: 'get_product', arguments: { productId: ids[0], photo: true } });
    expect(images(r)).toHaveLength(0);
    expect(json(r as never).photo).toBe('unavailable');
  });
});

describe('search thumbnails', () => {
  it('search_products {thumbs} returns at most 8 thumbnails of 160 px, labelled, opt-in', async () => {
    const { client, shrinker, flat } = await setup();
    const none = await client.callTool({ name: 'search_products', arguments: { query: '', limit: 12 } });
    expect(images(none)).toHaveLength(0);
    const r = await client.callTool({ name: 'search_products', arguments: { query: '', limit: 12, thumbs: true } });
    const j = json(r as never) as { count: number; thumbs: number };
    expect(j.count).toBeGreaterThan(8);
    expect(images(r)).toHaveLength(8);
    expect(j.thumbs).toBe(8);
    expect(shrinker.calls.at(-1)).toEqual({ n: 8, maxSide: 160 });
    expect(flat.photoCalls).toHaveLength(8);
    expect(content(r).filter((c) => c.type === 'text' && c.text?.startsWith('photo ')).length).toBe(8);
  });

  it('search_assets {thumbs} returns the committed library thumbnails, at most 8', async () => {
    const { client, shrinker } = await setup();
    const r = await client.callTool({ name: 'search_assets', arguments: { limit: 12, thumbs: true } });
    expect(images(r).length).toBeGreaterThan(0);
    expect(images(r).length).toBeLessThanOrEqual(8);
    expect(shrinker.calls.at(-1)!.maxSide).toBe(160);
    const plain = await client.callTool({ name: 'search_assets', arguments: {} });
    expect(images(plain)).toHaveLength(0);
  });
});

describe('match_crop', () => {
  const hit = (id: string, kind: 'product' | 'asset', score: number) => ({ id, kind, score, name: `n ${id}`, category: 'sofa', price: kind === 'product' ? 99 : undefined, dims: { w: 1, d: 1, h: 1 }, has3d: true });

  it('returns matches with thumbnails, passes the request to the matcher and marks products as seen', async () => {
    const { client, ids, flat, session } = await setup2();
    void session;
    const m = new FakeImageMatcher([hit(ids[0]!, 'product', 0.31), hit('sketchfab:armchair_midcentury', 'asset', 0.29)]);
    setImageMatcher(m);
    const r = await client.callTool({ name: 'match_crop', arguments: { image: { jobId: 'abc', index: 0 }, box: [10, 20, 200, 300], category: 'sofa', topK: 2 } });
    const j = json(r as never) as { results: Record<string, unknown>[] };
    expect(m.requests[0]).toMatchObject({ image: { jobId: 'abc', index: 0 }, box: [10, 20, 200, 300], category: 'sofa', topK: 2 });
    expect(j.results.map((x) => x.productId ?? x.assetId)).toEqual([ids[0], 'sketchfab:armchair_midcentury']);
    expect(images(r)).toHaveLength(2);
    expect([...flat.seenProducts.values()].some((s) => s.has(ids[0]!))).toBe(true);
  });

  it('works with text only, and refuses a call with neither image nor text or a bad box', async () => {
    const { client, ids } = await setup2();
    const m = new FakeImageMatcher([hit(ids[0]!, 'product', 0.3)]);
    setImageMatcher(m);
    const t = await client.callTool({ name: 'match_crop', arguments: { text: 'freestanding bathtub', thumbs: false } });
    expect(images(t)).toHaveLength(0);
    expect(m.requests[0]!.text).toBe('freestanding bathtub');
    expect(((await client.callTool({ name: 'match_crop', arguments: {} })) as { isError?: boolean }).isError).toBe(true);
    expect(((await client.callTool({ name: 'match_crop', arguments: { image: { path: 'a.png' }, box: [5, 5, 2, 9] } })) as { isError?: boolean }).isError).toBe(true);
  });

  it('maps a missing index and an unreachable service to actionable errors', async () => {
    const { client } = await setup2();
    setImageMatcher(new FakeImageMatcher([], new ImageMatchError('index_missing', 'no index')));
    const a = json((await client.callTool({ name: 'match_crop', arguments: { text: 'x' } })) as never) as { ok: boolean; hint: string };
    expect(a.ok).toBe(false);
    expect(a.hint).toContain('imagegen:index');
    setImageMatcher(new FakeImageMatcher([], new ImageMatchError('unavailable', 'down')));
    const b = json((await client.callTool({ name: 'match_crop', arguments: { text: 'x' } })) as never) as { hint: string };
    expect(b.hint).toContain('pnpm imagegen');
  });

  async function setup2() {
    const s = await setup();
    return { ...s, session: undefined };
  }
});

describe('SidecarMatcher', () => {
  it('posts the crop request with the bearer token and maps errors', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true, model: 'm', results: [], prep: ['plain'] }), { status: 200 });
    }) as unknown as typeof fetch;
    const m = new SidecarMatcher('http://127.0.0.1:8790/', 'tok', f);
    await m.query({ image: { jobId: 'j', index: 1 }, box: [1, 2, 30, 40], topK: 3, category: 'bath', maxPrice: 500, source: 'catalog' });
    expect(seen[0]!.url).toBe('http://127.0.0.1:8790/index/query');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ image: { jobId: 'j', index: 1 }, box: [1, 2, 30, 40], topK: 3, source: 'catalog', filters: { category: 'bath', maxPrice: 500 } });
    const bad = (async () => new Response(JSON.stringify({ ok: false, code: 'index_missing', message: 'no index' }), { status: 409 })) as unknown as typeof fetch;
    await expect(new SidecarMatcher('http://x', undefined, bad).query({ text: 'a', topK: 1 })).rejects.toMatchObject({ code: 'index_missing' });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(new SidecarMatcher('http://x', undefined, down).query({ text: 'a', topK: 1 })).rejects.toMatchObject({ code: 'unavailable' });
  });
});
