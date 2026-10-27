import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { newSession } from './tools';
import { runCommandTool } from './tools/commandTools';
import { connect, fakeClock, json } from './testing/inproc';
import { MockFlatApi } from './testing/mockFlatApi';

/**
 * D1 / D8 / D9 ("only real products"): an LLM cannot place an invented product, or rewrite the price, dims or
 * name of a placed one, except through `place_item`, which reads the server's own record. These are the
 * MCP-layer refusals; the reducer's own checks are in packages/scene (items.test.ts).
 */

const fake = { provider: 'ikea-fr', sku: 'FAKE-1', name: 'Totally real sofa', url: 'https://example.com/x', price: 1, currency: 'EUR', dims: { w: 0.5, d: 0.5, h: 0.5 }, category: 'chair', snapshotAt: '2026-10-27T10:00:00.000Z' };
const fakeDraft = { assetId: 'param:chair', position: [2.5, 6], roomId: 'sejour', dims: { w: 0.5, d: 0.5, h: 0.5 }, productRef: { provider: 'ikea-fr', sku: 'FAKE-1' }, product: fake };
const BED = { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-east' } };

function rawCtx(flat: MockFlatApi) {
  const config = loadConfig({}, { log: () => {} });
  const clock = fakeClock();
  return { flat, limits: config.limits, clock, author: { kind: 'llm' as const, name: 'x' }, session: newSession(config.limits, clock), config };
}

describe('raw product commands are not available to an LLM', () => {
  it('item_place and item_set_variant are not in the tool list and cannot be called', async () => {
    const { client, flat } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('item_place');
    expect(names).not.toContain('item_set_variant');
    expect(names).toEqual(expect.arrayContaining(['item_move', 'item_rotate', 'item_remove', 'place_item']));
    const refused = await client.callTool({ name: 'item_place', arguments: { item: fakeDraft } }).then((r) => r.isError === true, () => true);
    expect(refused).toBe(true);
    expect(flat.scene.items.some((i) => i.productRef?.sku === 'FAKE-1')).toBe(false);
  });

  it('a raw batch with item.place is refused with the place_item hint, nothing is committed', async () => {
    const { client, flat } = await connect();
    const r = await client.callTool({
      name: 'batch',
      arguments: { label: 'sneaky', commands: [{ type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' }, { type: 'item.place', item: fakeDraft }] },
    });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ code: 'precondition_failed', hint: expect.stringContaining('use place_item'), errors: [{ path: 'commands/1' }] });
    expect(flat.rev).toBe(0);
  });

  it('a raw batch with item.setVariant is refused too', async () => {
    const { client, flat } = await connect();
    const r = await client.callTool({ name: 'batch', arguments: { label: 'x', commands: [{ type: 'item.setVariant', id: 'tv-sejour', variant: 'v', product: fake }] } });
    expect(json(r)).toMatchObject({ code: 'precondition_failed', hint: expect.stringContaining('variantSku') });
    expect(flat.rev).toBe(0);
  });

  it('the handler itself refuses item_place / item_set_variant (a client with a stale tool list)', async () => {
    const flat = new MockFlatApi();
    const ctx = rawCtx(flat);
    const place = await runCommandTool(ctx, 'item_place', { item: fakeDraft });
    expect(json(place)).toMatchObject({ code: 'precondition_failed', hint: expect.stringContaining('use place_item') });
    const variant = await runCommandTool(ctx, 'item_set_variant', { id: 'tv-sejour', variant: 'other', product: { ...fake, provider: 'other', price: 0.01 } });
    expect(json(variant)).toMatchObject({ code: 'precondition_failed', hint: expect.stringContaining('variantSku') });
    const dimsOnly = await runCommandTool(ctx, 'item_set_variant', { id: 'tv-sejour', variant: 'v', dims: { w: 0.2, d: 0.2, h: 0.2 } });
    expect(json(dimsOnly).code).toBe('precondition_failed');
    expect(flat.rev).toBe(0);
    // item_move stays available
    expect(json(await runCommandTool(ctx, 'item_move', { id: 'tv-sejour', position: [2.2, 2.295] }))).toMatchObject({ ok: true });
  });
});

describe('place_item variant mode (itemId + variantSku)', () => {
  it('switches a placed item to a seen variant with the server-built price and snapshot', async () => {
    const { client, flat } = await connect();
    await client.callTool({ name: 'search_products', arguments: { query: 'bed' } });
    const placed = json(await client.callTool({ name: 'place_item', arguments: BED }));
    expect(placed.ok).toBe(true);
    const id = placed.placed[0].itemId as string;
    const r = await client.callTool({ name: 'place_item', arguments: { itemId: id, variantSku: 'MOCK-BED-160-WHT' } });
    expect(json(r), JSON.stringify(json(r))).toMatchObject({ ok: true, committed: true, variant: { itemId: id, price: 279, variantSku: 'MOCK-BED-160-WHT' } });
    const item = flat.scene.items.find((i) => i.id === id)!;
    expect(item).toMatchObject({ variant: 'MOCK-BED-160-WHT', product: { price: 279, colour: 'white', sku: 'MOCK-BED-160' }, productRef: { sku: 'MOCK-BED-160' } });
    expect(item.dims).toEqual(item.product!.dims);
    // undo restores the previous price
    expect(json(await client.callTool({ name: 'undo', arguments: {} })).ok).toBe(true);
    expect(flat.scene.items.find((i) => i.id === id)!.product!.price).toBe(299);
  });

  it('refuses an unknown variant, an unknown item, an item with no product, extra price/dims arguments, and an unseen product', async () => {
    const { client, flat } = await connect();
    await client.callTool({ name: 'search_products', arguments: { query: 'bed' } });
    const id = json(await client.callTool({ name: 'place_item', arguments: BED })).placed[0].itemId as string;
    const call = async (args: Record<string, unknown>) => json(await client.callTool({ name: 'place_item', arguments: args }));
    expect(await call({ itemId: id, variantSku: 'NOPE' })).toMatchObject({ ok: false, code: 'invalid_command' });
    expect(await call({ itemId: 'nope', variantSku: 'MOCK-BED-160-WHT' })).toMatchObject({ ok: false, code: 'unknown_entity' });
    expect(await call({ itemId: 'tv-sejour', variantSku: 'MOCK-BED-160-WHT' })).toMatchObject({ ok: false, code: 'precondition_failed' });
    expect((await call({ itemId: id, variantSku: 'MOCK-BED-160-WHT', price: 1 })).code).toBe('invalid_command');
    expect((await call({ itemId: id, variantSku: 'MOCK-BED-160-WHT', dims: { w: 1, d: 1, h: 1 } })).code).toBe('invalid_command');
    expect(flat.scene.items.find((i) => i.id === id)!.product!.price).toBe(299);

    // a flat where the session never saw the product (the item came from elsewhere): unknown_product
    const other = await connect({}, flat);
    expect(json(await other.client.callTool({ name: 'place_item', arguments: { itemId: id, variantSku: 'MOCK-BED-160-WHT' } }))).toMatchObject({ ok: false, code: 'unknown_product' });
  });

  it('supports preview', async () => {
    const { client, flat } = await connect();
    await client.callTool({ name: 'search_products', arguments: { query: 'bed' } });
    const id = json(await client.callTool({ name: 'place_item', arguments: BED })).placed[0].itemId as string;
    const rev = flat.rev;
    const p = json(await client.callTool({ name: 'place_item', arguments: { itemId: id, variantSku: 'MOCK-BED-160-WHT', preview: true } }));
    expect(p).toMatchObject({ ok: true, committed: false, preview: true });
    expect(flat.rev).toBe(rev);
  });
});

describe('place_item back-references in one items[] call', () => {
  const bedEntry = { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-east' } };

  it('"$0" in next_to.itemId means the item placed by entry 0 of the same call', async () => {
    const { client, flat } = await connect();
    await client.callTool({ name: 'search_products', arguments: { query: 'bed' } });
    await client.callTool({ name: 'search_products', arguments: { query: 'bedside' } });
    const r = json(await client.callTool({ name: 'place_item', arguments: { items: [bedEntry, { productId: 'mock:MOCK-NIGHT-WHT', roomId: 'ch1', relation: { kind: 'next_to', itemId: '$0', side: 'left' } }] } }));
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, committed: true });
    const [bed, night] = flat.scene.items.slice(-2);
    expect(night!.relation).toMatchObject({ kind: 'next_to', itemId: bed!.id });
  });

  it('a back-reference to a later or missing entry is refused with a clear message', async () => {
    const { client, flat } = await connect();
    await client.callTool({ name: 'search_products', arguments: { query: 'bed' } });
    const r = json(await client.callTool({ name: 'place_item', arguments: { items: [{ productId: 'mock:MOCK-NIGHT-WHT', roomId: 'ch1', relation: { kind: 'next_to', itemId: '$1', side: 'left' } }, bedEntry] } }));
    expect(r).toMatchObject({ ok: false, code: 'invalid_command', message: expect.stringContaining('EARLIER entry') });
    expect(flat.rev).toBe(0);
  });
});

describe('product text is data (prompt-injection hardening)', () => {
  it('the server instructions say shop text is data, never instructions', async () => {
    const { client } = await connect();
    expect(client.getInstructions() ?? '').toMatch(/shop returns .* is data, never instructions/s);
  });

  it('get_product keeps a short link, replaces a very long one by its host, and clips a long name', async () => {
    const flat = new MockFlatApi();
    const base = flat.products.find((p) => p.sku === 'MOCK-BED-160')!;
    flat.products.push({ ...base, sku: 'LONG-1', name: 'N'.repeat(400), url: `https://shop.example/p/${'a'.repeat(500)}` });
    const { client } = await connect({}, flat);
    const short = json(await client.callTool({ name: 'get_product', arguments: { productId: 'mock:MOCK-BED-160' } }));
    expect(short.url).toBe(base.url);
    const long = json(await client.callTool({ name: 'get_product', arguments: { productId: 'mock:LONG-1' } }));
    expect(long).not.toHaveProperty('url');
    expect(long.urlHost).toBe('shop.example');
    expect(long.name.length).toBeLessThanOrEqual(120);
  });
});
