import { describe, expect, it } from 'vitest';
import { MockFlatApi, mockProductRecords } from '../testing/mockFlatApi';
import { renderTools } from '../tools/render';
import { placementTools } from '../tools/placement';
import { toolContext } from './harness';
import type { BrowserRenderer, RenderRequest } from './browserRenderer';
import { McpRenderer } from './service';

/** Fast: the render service tells which models are in view (attribution) and how the viewer reaches the server's models; no browser. */

const tool = renderTools()[0]!;
const data = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, any>;
const texts = (r: { content: unknown }) => (r.content as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text!);

function fakeBrowser() {
  const requests: RenderRequest[] = [];
  const browser = {
    async render(req: RenderRequest) {
      requests.push(req);
      return { data: Buffer.from('png'), mimeType: 'image/png' as const, width: 64, height: 48, sun: { available: false }, lampsLit: [], appliedPose: null, pixels: { stddev: 1, mean: 1, colors: 9, topShare: 0.1, pixels: 1 }, renderMs: 1, warm: true, sceneLoaded: true };
    },
  } as unknown as BrowserRenderer;
  return { browser, requests };
}

/** A flat with the mock bed placed in `ch1` as a product of `provider`. */
function flatWith(provider: string, personalUseOnly: boolean) {
  const flat = new MockFlatApi();
  flat.providers = [{ id: provider, label: provider === 'ikea-fr' ? 'IKEA France' : 'Mock catalog', capabilities: { search: true, model3d: true, dims: 'structured', resolveUrl: false }, enabled: true, circuit: 'closed', personalUseOnly }];
  const p = mockProductRecords().find((x) => x.sku === 'MOCK-BED-160')!;
  flat.scene = {
    ...flat.scene,
    items: [...flat.scene.items, { id: 'bed', assetId: `product:${provider}`, position: [9.05, 2.21], elevation: 0, rotation: 270, roomId: 'ch1', dims: p.dims, mount: 'floor', productRef: { provider, sku: p.sku }, product: { provider, sku: p.sku, name: p.name, url: p.url, price: p.price, currency: 'EUR', dims: p.dims, category: 'bed', snapshotAt: p.fetchedAt }, mesh: { kind: 'provider' } } as never],
  };
  return flat;
}

describe('attribution caption (IKEA models, personal use)', () => {
  it('render_view metadata and text carry the caption when a personal-use provider has items in view', async () => {
    const flat = flatWith('ikea-fr', true);
    const { browser } = fakeBrowser();
    const ctx = toolContext(flat, { renderer: new McpRenderer(flat, browser) });
    const r = await tool.handler(ctx, { view: 'orbit' });
    expect(data(r).caption).toBe('IKEA models, personal use');
    expect(texts(r)).toContain('IKEA models, personal use');
    expect((r.content as { type: string }[]).some((c) => c.type === 'image')).toBe(true);
  });

  it('room and walk views only count the items of that room', async () => {
    const flat = flatWith('ikea-fr', true);
    const { browser } = fakeBrowser();
    const ctx = toolContext(flat, { renderer: new McpRenderer(flat, browser) });
    expect(data(await tool.handler(ctx, { view: 'room', roomId: 'ch1' })).caption).toBe('IKEA models, personal use');
    const other = await tool.handler(ctx, { view: 'room', roomId: 'sejour' });
    expect(data(other).caption).toBeUndefined();
    expect(texts(other)).toHaveLength(1); // the JSON only
  });

  it('no caption for providers without the personal-use flag, or for flats without products', async () => {
    const { browser } = fakeBrowser();
    const mock = flatWith('mock', false);
    expect(data(await tool.handler(toolContext(mock, { renderer: new McpRenderer(mock, browser) }), { view: 'orbit' })).caption).toBeUndefined();
    const bare = new MockFlatApi();
    const r = await tool.handler(toolContext(bare, { renderer: new McpRenderer(bare, browser) }), { view: 'orbit' });
    expect(data(r).caption).toBeUndefined();
    expect(bare.calls).not.toContain('listProviders'); // only asked when the scene has products
  });

  it('the render argument of place_item carries it too', async () => {
    const flat = flatWith('ikea-fr', true);
    const { browser } = fakeBrowser();
    const ctx = toolContext(flat, { renderer: new McpRenderer(flat, browser) });
    await flat.markProductsSeen(ctx.session.id, ['ikea-fr:MOCK-DESK-120']);
    flat.products = mockProductRecords().map((p) => ({ ...p, provider: 'ikea-fr' }));
    const place = placementTools().find((t) => t.name === 'place_item')!;
    const r = await place.handler(ctx, { productId: 'ikea-fr:MOCK-DESK-120', roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-ch2-ch1' }, render: true });
    expect(data(r).ok, JSON.stringify(data(r))).toBe(true);
    expect(data(r).render.caption).toBe('IKEA models, personal use');
    expect(texts(r)).toContain('IKEA models, personal use');
  });
});

describe('how the viewer reaches the server models', () => {
  it('the render request names the scene server origin and serves its assets from Node, with the token', async () => {
    const flat = flatWith('mock', false);
    const url = flat.assetUrl({ kind: 'product-model', productId: 'mock:MOCK-BED-160' });
    flat.assets.set(url, { status: 200, contentType: 'model/gltf-binary', body: new Uint8Array([1, 2, 3]) });
    const { browser, requests } = fakeBrowser();
    const ctx = toolContext(flat, { renderer: new McpRenderer(flat, browser) });
    await tool.handler(ctx, { view: 'orbit' });
    const models = requests[0]!.models!;
    expect(models.origin).toBe('http://mock.flat');
    expect(await models.fetch(url)).toEqual({ status: 200, contentType: 'model/gltf-binary', body: new Uint8Array([1, 2, 3]) });
    expect(await models.fetch('http://mock.flat/api/assets/products/mock/NOPE.glb')).toBeUndefined();
  });
});
