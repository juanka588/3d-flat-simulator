import { diffScenes, ProductRecord, type Scene } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { cc0Assets } from './assetCatalog';
import { MockFlatApi, mockProductRecords } from './testing/mockFlatApi';
import { connect, json, textChars } from './testing/inproc';
import { loadConfig } from './config';
import { toolContext } from './render/harness';
import { placementTools } from './tools/placement';

/** M5.11: the product and layout tools, in process over the in-memory FlatApi (real reducer, real solver). */

type Client = Awaited<ReturnType<typeof connect>>['client'];
const tokens = (r: { content: unknown }) => Math.ceil(textChars(r) / 4);
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { r, j: json(r as never) as Record<string, any> };
};
const EAST = { kind: 'against_wall', wallId: 'w-east' } as const;

async function setup(over: Parameters<typeof connect>[0] = {}, flat = new MockFlatApi()) {
  const c = await connect(over, flat);
  const search = (query: string, extra: Record<string, unknown> = {}) => call(c.client, 'search_products', { query, ...extra });
  return { ...c, search, call: (name: string, args?: Record<string, unknown>) => call(c.client, name, args) };
}

describe('registry', () => {
  it('lists the eight M5.11 tools with read-only annotations on the reads', async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const by = new Map(tools.map((t) => [t.name, t]));
    for (const n of ['list_providers', 'search_products', 'get_product', 'search_assets', 'get_placement_options', 'validate_layout', 'get_bill_of_materials']) {
      expect(by.get(n), n).toBeDefined();
      expect(by.get(n)!.annotations?.readOnlyHint, n).toBe(true);
    }
    expect(by.get('place_item')!.annotations?.readOnlyHint).toBe(false);
    expect(tools).toHaveLength(38);
  });

  it('place_item has NO price, name, link or dims field, and unknown keys are rejected', async () => {
    const { client } = await connect();
    const t = (await client.listTools()).tools.find((x) => x.name === 'place_item')!;
    const props = t.inputSchema.properties as Record<string, unknown>;
    const entry = (t.inputSchema as any).$defs.placement.properties as Record<string, unknown>;
    for (const forbidden of ['price', 'currency', 'name', 'url', 'dims', 'product', 'productRef', 'snapshot', 'sku', 'width']) {
      expect(props, forbidden).not.toHaveProperty(forbidden);
      expect(entry, forbidden).not.toHaveProperty(forbidden);
    }
    expect((t.inputSchema as any).additionalProperties).toBe(false);
    expect((t.inputSchema as any).$defs.placement.additionalProperties).toBe(false);
  });

  it('read-only mode hides place_item and the item_* tools but keeps every read', async () => {
    const { client } = await connect({ readOnly: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('place_item');
    expect(names.filter((n) => n.startsWith('item_'))).toEqual([]);
    for (const n of ['list_providers', 'search_products', 'get_product', 'search_assets', 'get_placement_options', 'validate_layout', 'get_bill_of_materials']) expect(names).toContain(n);
  });

  it('item_place and item_set_variant are not offered to the LLM; the other item_* point to the new reads', async () => {
    const { client } = await connect();
    const d = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.description ?? '']));
    expect(d).not.toHaveProperty('item_place');
    expect(d).not.toHaveProperty('item_set_variant');
    expect(d.item_move).toMatch(/get_placement_options/);
    expect(d.place_item).toMatch(/itemId \+ variantSku/);
  });
});

describe('list_providers, search_products, get_product', () => {
  it('list_providers reports capabilities, circuit and personal-use flags', async () => {
    const { call: c, flat } = await setup();
    flat.providers.push({ id: 'ikea-fr', label: 'IKEA France', capabilities: { search: true, model3d: true, dims: 'structured', resolveUrl: false }, enabled: false, circuit: 'open', retryAt: 1_700_000_100_000, personalUseOnly: true });
    const { j } = await c('list_providers');
    expect(j.providers.map((p: any) => [p.id, p.enabled, p.circuit, p.personalUseOnly])).toEqual([['mock', true, 'closed', false], ['ikea-fr', false, 'open', true]]);
    expect(j.providers[1]).toMatchObject({ retryAt: 1_700_000_100_000, capabilities: { model3d: true } });
  });

  it('search_products returns compact lines, no photos, within 2.5k tokens at the maximum, and registers every id as seen', async () => {
    const { search, flat } = await setup();
    const { r, j } = await search('', { limit: 12 });
    expect(j.count).toBe(12);
    expect(j.truncated).toBe(true);
    expect(tokens(r)).toBeLessThanOrEqual(2500);
    const line = j.results[0];
    expect(Object.keys(line).sort()).toEqual(expect.arrayContaining(['productId', 'name', 'price', 'currency', 'dims', 'colours', 'has3d', 'category']));
    expect(JSON.stringify(j)).not.toMatch(/photo|https?:|modelRef/);
    const seen = [...(flat.seenProducts.values().next().value as Set<string>)];
    expect(seen.sort()).toEqual(j.results.map((x: any) => x.productId).sort());
  });

  it('search_products filters by category, price, size and colour, and never marks what it did not return', async () => {
    const { search, flat } = await setup();
    expect((await search('', { category: 'bed' })).j.results.map((x: any) => x.productId)).toEqual(['mock:MOCK-BED-160']);
    expect((await search('', { maxPrice: 40 })).j.results.every((x: any) => x.price <= 40)).toBe(true);
    const small = await search('', { maxWidth: 0.5, maxDepth: 0.5, maxHeight: 0.6 });
    expect(small.j.results.every((x: any) => x.dims.w <= 0.5 && x.dims.d <= 0.5 && x.dims.h <= 0.6)).toBe(true);
    const black = await search('', { colour: 'OAK', limit: 12 });
    expect(black.j.results.length).toBeGreaterThan(0);
    expect(black.j.results.every((x: any) => x.colours.some((c: string) => c.toLowerCase().includes('oak')))).toBe(true);
    const none = await search('zzzz');
    expect(none.j.count).toBe(0);
    expect(none.j.note).toMatch(/No match/);
    expect(flat.seenProducts.get([...flat.seenProducts.keys()][0]!)!.has('mock:MOCK-SOFA-3')).toBe(false);
  });

  it('search_products reports provider problems and unknown providers', async () => {
    const { search } = await setup();
    const { j } = await search('sofa', { provider: 'nope' });
    expect(j).toMatchObject({ ok: false, code: 'unknown_provider' });
  });

  it('get_product returns the facts within 1.2k tokens, with variants and weight, no photo, and marks the id seen', async () => {
    const { call: c, flat } = await setup();
    const { r, j } = await c('get_product', { productId: 'mock:MOCK-BED-160' });
    expect(tokens(r)).toBeLessThanOrEqual(1200);
    expect(j).toMatchObject({ ok: true, productId: 'mock:MOCK-BED-160', price: 299, currency: 'EUR', priceTtc: true, weightKg: 48.5, has3d: true, dims: { w: 1.6, d: 2, h: 0.9 } });
    expect(j.variants).toEqual([{ sku: 'MOCK-BED-160-WHT', name: 'MOCK Double bed frame 160 white', colour: 'white', price: 279 }]);
    expect(JSON.stringify(j)).not.toMatch(/photo|modelRef/);
    expect([...flat.seenProducts.values()][0]!.has('mock:MOCK-BED-160')).toBe(true);
  });

  it('get_product stays small even with the maximum of 20 variants', async () => {
    const base = mockProductRecords()[1]!;
    const many = ProductRecord.parse({ ...base, variants: Array.from({ length: 20 }, (_, i) => ({ sku: `V-${i}`, name: `MOCK Double bed frame 160 colour variant number ${i}`, colour: `colour-${i}`, price: 250 + i, dims: { w: 1.6, d: 2, h: 0.9 } })) });
    const { call: c } = await setup({}, new MockFlatApi({ products: [many] }));
    const { r } = await c('get_product', { productId: `mock:${many.sku}` });
    expect(tokens(r)).toBeLessThanOrEqual(1200);
  });

  it('get_product: unknown ids and bad ids', async () => {
    const { call: c } = await setup();
    expect((await c('get_product', { productId: 'mock:NOPE' })).j).toMatchObject({ ok: false, code: 'product_not_found' });
    expect((await c('get_product', { productId: 'nonsense' })).j.code).toBe('invalid_command');
    expect((await c('get_product', {})).j.code).toBe('invalid_command');
  });

  it('rate limits: 20 searches per minute and 60 product reads per minute, with retryAfterMs', async () => {
    const { search, call: c, clock } = await setup();
    for (let i = 0; i < 20; i++) expect((await search('sofa')).j.ok).toBe(true);
    const limited = await search('sofa');
    expect(limited.j).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(limited.j.retryAfterMs).toBeGreaterThan(0);
    expect(limited.j.retryAfterMs).toBeLessThanOrEqual(3000);
    clock.advance(limited.j.retryAfterMs);
    expect((await search('sofa')).j.ok).toBe(true);

    for (let i = 0; i < 60; i++) expect((await c('get_product', { productId: 'mock:MOCK-BED-160' })).j.ok).toBe(true);
    const gl = await c('get_product', { productId: 'mock:MOCK-BED-160' });
    expect(gl.j).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(gl.j.retryAfterMs).toBeGreaterThan(0);
    // the limits are separate buckets and do not touch writes
    expect((await c('list_providers')).j.ok).toBe(true);
  });

  it('a rejected search does not spend allowance', async () => {
    const { search } = await setup();
    for (let i = 0; i < 25; i++) expect((await search('sofa', { limit: 99 })).j.code).toBe('invalid_command');
    expect((await search('sofa')).j.ok).toBe(true);
  });
});

describe('search_assets', () => {
  it('lists the parametric generators with their parameter ranges and the CC0 library, filtered', async () => {
    const { call: c } = await setup();
    const { r, j } = await c('search_assets');
    expect(tokens(r)).toBeLessThanOrEqual(2500);
    const bed = j.parametric.find((g: any) => g.id === 'bed');
    expect(bed).toMatchObject({ category: 'bed' });
    expect(bed.params.w).toMatch(/^number 0\.7\.\.2\.4 =1\.6$/);
    expect(j.library.length).toBeGreaterThan(0);
    expect(j.library.length).toBeLessThanOrEqual(12);
    expect(j.library[0]).toHaveProperty('assetId');
    const beds = (await c('search_assets', { category: 'bed' })).j;
    expect(beds.parametric.map((g: any) => g.id)).toEqual(['bed']);
    expect(beds.library.every((m: any) => m.category === 'bed')).toBe(true);
    expect(beds.library.map((m: any) => m.assetId)).toEqual(cc0Assets().filter((m) => m.category === 'bed').map((m) => m.id));
    const tiny = (await c('search_assets', { maxDims: { w: 0.1 } })).j;
    expect(tiny.library).toEqual([]);
    const styled = (await c('search_assets', { style: 'wood', limit: 3 })).j;
    expect(styled.library.length).toBeLessThanOrEqual(3);
    expect(styled.library.every((m: any) => m.styleTags.some((t: string) => t.includes('wood')))).toBe(true);
  });
});

describe('get_placement_options', () => {
  it('needs a product seen in this session', async () => {
    const { call: c } = await setup();
    const r = await c('get_placement_options', { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST });
    expect(r.j).toMatchObject({ ok: false, code: 'unknown_product' });
    expect(r.j.hint).toMatch(/search_products/);
  });

  it('returns up to 3 valid candidates with the reasons (against_wall: the other alignments)', async () => {
    const { call: c, search } = await setup();
    await search('bed');
    const { r, j } = await c('get_placement_options', { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST });
    expect(j).toMatchObject({ ok: true, valid: true, name: 'MOCK Double bed frame 160x200', dims: { w: 1.6, d: 2, h: 0.9 } });
    expect(j.candidates.length).toBeGreaterThanOrEqual(1);
    expect(j.candidates.length).toBeLessThanOrEqual(3);
    for (const cand of j.candidates) {
      expect(cand.rationale.length).toBeGreaterThan(0);
      expect(cand.position).toHaveLength(2);
      expect(cand.relation.kind).toBeDefined();
    }
    expect(new Set(j.candidates.map((x: any) => x.position.join(','))).size).toBe(j.candidates.length);
    expect(tokens(r)).toBeLessThan(900);
  });

  it('is a dry run: the flat does not change', async () => {
    const { call: c, search, flat } = await setup();
    await search('bed');
    await c('get_placement_options', { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST });
    expect(flat.rev).toBe(0);
    expect(flat.calls).not.toContain('postCommand');
  });

  it('a blocked relation returns the violations and alternatives', async () => {
    const { call: c, search } = await setup();
    await search('bed');
    const { j } = await c('get_placement_options', { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-ch1-south' } });
    expect(j.valid).toBe(false);
    expect(j.violations.map((v: any) => v.code)).toEqual(expect.arrayContaining(['overlap']));
    expect(j.candidates.length).toBeGreaterThan(0);
    expect(j.candidates.length).toBeLessThanOrEqual(3);
  });

  it('unknown rooms and variants are reported', async () => {
    const { call: c, search } = await setup();
    await search('bed');
    expect((await c('get_placement_options', { productId: 'mock:MOCK-BED-160', roomId: 'ch11', relation: EAST })).j.code).toBe('unknown_room');
    expect((await c('get_placement_options', { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST, variantSku: 'x' })).j.code).toBe('invalid_command');
  });
});

describe('place_item', () => {
  const bed = { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST };

  it('refuses a productId this session never saw: unknown_product', async () => {
    const { call: c, flat } = await setup();
    const { j, r } = await c('place_item', bed);
    expect(r.isError).toBe(true);
    expect(j).toMatchObject({ ok: false, code: 'unknown_product' });
    expect(j.hint).toMatch(/search_products/);
    expect(flat.rev).toBe(0);
    // a product seen by ANOTHER session is not seen here
    await flat.markProductsSeen('another-session', ['mock:MOCK-BED-160']);
    expect((await c('place_item', bed)).j.code).toBe('unknown_product');
  });

  it('rejects invented prices, names, links and dims as unknown keys', async () => {
    const { call: c, search, flat } = await setup();
    await search('bed');
    for (const extra of [{ price: 1 }, { currency: 'EUR' }, { name: 'Free bed' }, { url: 'https://x.test' }, { dims: { w: 1, d: 1, h: 1 } }, { product: { price: 1 } }, { productRef: { provider: 'mock', sku: 'x' } }]) {
      const { j, r } = await c('place_item', { ...bed, ...extra });
      expect(r.isError, JSON.stringify(extra)).toBe(true);
      expect(j.code).toBe('invalid_command');
      expect(j.message).toMatch(/Unrecognized key/i);
    }
    // inside items[] too
    const many = await c('place_item', { items: [{ ...bed, price: 0 }] });
    expect(many.j.code).toBe('invalid_command');
    expect(flat.rev).toBe(0);
  });

  it('needs exactly one of relation or position', async () => {
    const { call: c, search } = await setup();
    await search('bed');
    expect((await c('place_item', { productId: 'mock:MOCK-BED-160', roomId: 'ch1' })).j.code).toBe('invalid_command');
    expect((await c('place_item', { ...bed, position: [8, 2] })).j.code).toBe('invalid_command');
  });

  it('places with a relation: facts come from the server record, the label names the product and the room, the history shows it', async () => {
    const { call: c, search, flat } = await setup();
    await search('bed');
    const { j } = await c('place_item', bed);
    expect(j).toMatchObject({ ok: true, committed: true, addedEur: 299 });
    expect(j.placed).toHaveLength(1);
    expect(j.placed[0]).toMatchObject({ productId: 'mock:MOCK-BED-160', price: 299, currency: 'EUR', roomId: 'ch1' });
    expect(j.placed[0].rationale.length).toBeGreaterThan(0);
    const item = flat.scene.items.find((i) => i.id === j.placed[0].itemId)!;
    expect(flat.scene.items.at(-1)).toBe(item);
    const rec = mockProductRecords().find((p) => p.sku === 'MOCK-BED-160')!;
    expect(item.product).toEqual({ provider: 'mock', sku: rec.sku, name: rec.name, url: rec.url, price: rec.price, currency: 'EUR', dims: rec.dims, category: 'bed', snapshotAt: rec.fetchedAt });
    expect(item.productRef).toEqual({ provider: 'mock', sku: rec.sku });
    expect(item.dims).toEqual(rec.dims);
    expect(item.relation?.kind).toBe('against_wall');
    expect(item.roomId).toBe('ch1');
    const hist = (await c('list_history')).j;
    expect(JSON.stringify(hist)).toContain('Placed MOCK Double bed frame 160x200 in Chambre 1');
  });

  it('the shape follows D2: lookalike when the provider has no model, the provider model when it has one, parametric as the last resort', async () => {
    const { call: c, search, flat } = await setup();
    await search('bed');
    expect((await c('place_item', bed)).j.placed[0].mesh).toBe('lookalike');
    expect(flat.scene.items.at(-1)!.mesh).toMatchObject({ kind: 'lookalike' });
    expect(cc0Assets().some((a) => a.id === (flat.scene.items.at(-1)!.mesh as { assetId: string }).assetId)).toBe(true);

    const f2 = new MockFlatApi();
    f2.providers[0]!.capabilities.model3d = true;
    const s2 = await setup({}, f2);
    await s2.search('bed');
    const r2 = await s2.call('place_item', bed);
    expect(r2.j.placed[0].mesh).toBe('provider');
    expect(f2.scene.items.at(-1)!.mesh).toEqual({ kind: 'provider' });
    expect(f2.scene.items.at(-1)!.assetId).toBe('product:mock');

    // no library table is 2.4 m long and 0.4 m high with that proportion: the last resort, a generator at the exact dims
    const odd = ProductRecord.parse({ ...mockProductRecords()[7]!, sku: 'MOCK-ODD-TABLE', name: 'MOCK Console 240', category: 'table', dims: { w: 2.4, d: 0.5, h: 0.45 }, modelRef: undefined, variants: [] });
    const f3 = new MockFlatApi({ products: [odd] });
    const s3 = await setup({}, f3);
    await s3.search('console');
    const r3 = await s3.call('place_item', { productId: 'mock:MOCK-ODD-TABLE', roomId: 'sejour', position: [2.85, 2.52] });
    expect(r3.j.placed?.[0]?.mesh, JSON.stringify(r3.j)).toBe('parametric');
    expect(f3.scene.items.at(-1)!.mesh).toMatchObject({ kind: 'parametric', generator: 'table' });
  });

  it('an explicit mesh: parametric must match the dims within 2% (dims_mismatch), a provider mesh needs a real model', async () => {
    const { call: c, search, flat } = await setup();
    await search('bed');
    const bad = await c('place_item', { ...bed, mesh: { kind: 'parametric', generator: 'bed', params: { w: 1.4, l: 2, h: 0.9 } } });
    expect(bad.j).toMatchObject({ ok: false, code: 'dims_mismatch' });
    expect(bad.j.message).toMatch(/1\.4/);
    expect(flat.rev).toBe(0);
    const ok = await c('place_item', { ...bed, mesh: { kind: 'parametric', generator: 'bed', params: { w: 1.61, l: 2, h: 0.9 } } });
    expect(ok.j).toMatchObject({ ok: true });
    expect(flat.scene.items.at(-1)!.mesh).toMatchObject({ kind: 'parametric', generator: 'bed' });
    expect(flat.scene.items.at(-1)!.assetId).toBe('param:bed');
    expect((await c('place_item', { ...bed, mesh: { kind: 'parametric', generator: 'nope', params: {} } })).j.code).toBe('invalid_command');
    expect((await c('place_item', { ...bed, mesh: { kind: 'lookalike', assetId: 'nope:nope' } })).j.code).toBe('invalid_command');
    expect((await c('place_item', { ...bed, mesh: { kind: 'provider' } })).j.code).toBe('model_unavailable');
    const wardrobeLook = cc0Assets().find((a) => a.category === 'wardrobe')!;
    expect((await c('place_item', { ...bed, mesh: { kind: 'lookalike', assetId: wardrobeLook.id } })).j.code).toBe('dims_mismatch');
  });

  it('variantSku uses the variant price and records the variant and colour', async () => {
    const { call: c, search, flat } = await setup();
    await search('bed');
    const { j } = await c('place_item', { ...bed, variantSku: 'MOCK-BED-160-WHT' });
    expect(j).toMatchObject({ ok: true, addedEur: 279 });
    const item = flat.scene.items.at(-1)!;
    expect(item.variant).toBe('MOCK-BED-160-WHT');
    expect(item.product).toMatchObject({ price: 279, colour: 'white', sku: 'MOCK-BED-160' });
    expect((await c('place_item', { ...bed, variantSku: 'NOPE' })).j.code).toBe('invalid_command');
  });

  it('an explicit position and rotation go through the solver too', async () => {
    const { call: c, search, flat } = await setup();
    await search('desk');
    const ok = await c('place_item', { productId: 'mock:MOCK-DESK-120', roomId: 'ch1', position: [8.2, 1.0], rotation: 90 });
    expect(ok.j.ok).toBe(true);
    expect(flat.scene.items.at(-1)).toMatchObject({ position: [8.2, 1], rotation: 90, relation: { kind: 'at' } });
    const bad = await c('place_item', { productId: 'mock:MOCK-DESK-120', roomId: 'ch1', position: [100, 100] });
    expect(bad.j).toMatchObject({ ok: false, code: 'placement_invalid' });
    expect(bad.j.violations[0].code).toBe('outside_room');
  });

  it('a refused spot returns placement_invalid with the violations and alternative candidates, and changes nothing', async () => {
    const { call: c, search, flat } = await setup();
    await search('bed');
    const { j, r } = await c('place_item', { ...bed, relation: { kind: 'against_wall', wallId: 'w-ch1-south' } });
    expect(r.isError).toBe(true);
    expect(j.code).toBe('placement_invalid');
    expect(j.violations.length).toBeGreaterThan(0);
    expect(j.candidates.length).toBeGreaterThan(0);
    expect(flat.rev).toBe(0);
    // a candidate's relation is accepted as is
    const retry = await c('place_item', { ...bed, relation: j.candidates[0].relation });
    expect(retry.j.ok).toBe(true);
  });

  it('items[] places several products in order as one undo step; later ones see earlier ones', async () => {
    const { call: c, search, flat } = await setup();
    await search('', { limit: 12 });
    const before = flat.scene;
    const { j } = await c('place_item', {
      items: [
        { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST },
        { productId: 'mock:MOCK-DESK-120', roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-ch2-ch1' } },
      ],
      label: 'Furnish Chambre 1',
    });
    expect(j).toMatchObject({ ok: true, committed: true });
    expect(j.placed.map((p: any) => p.productId)).toEqual(['mock:MOCK-BED-160', 'mock:MOCK-DESK-120']);
    expect(j.addedEur).toBe(378);
    expect(flat.scene.items).toHaveLength(before.items.length + 2);
    expect(flat.hist.past).toHaveLength(1);
    expect(flat.hist.past[0]!.label).toBe('Furnish Chambre 1');
    await c('undo');
    expect(flat.scene.items).toHaveLength(before.items.length);
    // overlapping picks: the second one sees the first and is refused (nothing applied)
    const clash = await c('place_item', { items: [{ productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST }, { productId: 'mock:MOCK-SHELF-77', roomId: 'ch1', position: [9.0, 2.2] }] });
    expect(clash.j.code).toBe('placement_invalid');
    expect(clash.j.index).toBe(1);
    expect(flat.scene.items).toHaveLength(before.items.length);
  });

  it('preview changes nothing and its diff equals the committed diff', async () => {
    const { call: c, search, flat } = await setup();
    await search('', { limit: 12 });
    const args = { items: [{ productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST }, { productId: 'mock:MOCK-NIGHT-WHT', roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-north', align: 'start' } }] };
    const before: Scene = flat.scene;
    const calls = flat.calls.filter((x) => x === 'postCommand').length;
    const pv = await c('place_item', { ...args, preview: true });
    expect(pv.j).toMatchObject({ ok: true, committed: false, preview: true, baseRev: 0 });
    expect(pv.j.placed).toHaveLength(2);
    expect(pv.j.wouldChange.items).toHaveLength(2);
    expect(flat.rev).toBe(0);
    expect(flat.calls.filter((x) => x === 'postCommand').length).toBe(calls);
    const co = await c('place_item', { ...args, ifRev: pv.j.baseRev });
    expect(co.j).toMatchObject({ ok: true, committed: true });
    expect(diffScenes(before, flat.scene)).toEqual(pv.j.diff);
    expect(co.j.changed).toEqual(pv.j.wouldChange);
    expect(co.j.placed).toEqual(pv.j.placed);
  });

  it('ifRev: a stale revision is stale_scene and nothing is placed', async () => {
    const { call: c, search, flat } = await setup();
    await search('bed');
    const { j } = await c('place_item', { ...bed, ifRev: 7 });
    expect(j.code).toBe('stale_scene');
    expect(flat.rev).toBe(0);
  });

  it('a change between the solve and the commit makes the commit stale instead of misplacing the item', async () => {
    const { call: c, search, flat } = await setup();
    await search('bed');
    const real = flat.getScene.bind(flat);
    let first = true;
    flat.getScene = async () => {
      const r = await real();
      if (first) {
        first = false;
        flat.rev += 1; // somebody else wrote right after we read the scene
      }
      return r;
    };
    const { j } = await c('place_item', bed);
    expect(j.code).toBe('stale_scene');
  });

  it('counts as one write for the rate limit, but the preview does not', async () => {
    const { call: c, search } = await setup({ limits: { maxBatch: 50, writesPerMinute: 1, rendersPerMinute: 10, maxArgBytes: 262144, sessionWriteCap: 500, searchesPerMinute: 20, productGetsPerMinute: 60 } });
    await search('', { limit: 12 });
    expect((await c('place_item', { ...bed, preview: true })).j.ok).toBe(true);
    expect((await c('place_item', { ...bed, preview: true })).j.ok).toBe(true);
    expect((await c('place_item', bed)).j.ok).toBe(true);
    const limited = await c('place_item', { productId: 'mock:MOCK-DESK-120', roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-ch2-ch1' } });
    expect(limited.j).toMatchObject({ code: 'rate_limited' });
    expect(limited.j.retryAfterMs).toBeGreaterThan(0);
  });

  it('with render: true and no renderer the placement stands and the image part reports render_unavailable', async () => {
    const { call: c, search, flat } = await setup();
    await search('bed');
    const { j } = await c('place_item', { ...bed, render: true });
    expect(j.ok).toBe(true);
    expect(j.render).toMatchObject({ ok: false, code: 'render_unavailable' });
    expect(flat.scene.items.some((i) => i.productRef?.sku === 'MOCK-BED-160')).toBe(true);
    expect((await c('place_item', { ...bed, render: { view: 'nonsense' } })).j.code).toBe('invalid_command');
  });

  it('a product with a non-TTC price cannot be placed', async () => {
    const base = mockProductRecords()[1]!;
    const gross = ProductRecord.parse({ ...base, priceTtc: false });
    const { call: c, search } = await setup({}, new MockFlatApi({ products: [gross] }));
    await search('bed');
    expect((await c('place_item', bed)).j).toMatchObject({ ok: false, code: 'invalid_command' });
  });

  it('read-only servers answer read_only even if the tool is called directly', async () => {
    const { client } = await connect({ readOnly: true });
    await expect(client.callTool({ name: 'place_item', arguments: bed })).rejects.toThrow(/not found/);
    const tool = placementTools().find((t) => t.name === 'place_item')!;
    const flat = new MockFlatApi();
    const ctx = { ...toolContext(flat), config: loadConfig({ FLAT_MCP_READONLY: '1' }, { log: () => undefined }) };
    const r = await tool.handler(ctx, bed);
    expect(r.structuredContent).toMatchObject({ code: 'read_only' });
  });

  it('unknown rooms come with the nearest ids', async () => {
    const { call: c, search } = await setup();
    await search('bed');
    const { j } = await c('place_item', { ...bed, roomId: 'chambre1' });
    expect(j.code).toBe('unknown_room');
    expect(j.hint).toContain('ch1');
  });
});

describe('validate_layout and get_bill_of_materials', () => {
  async function furnished() {
    const s = await setup();
    await s.search('', { limit: 12 });
    await s.call('place_item', { items: [{ productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST }, { productId: 'mock:MOCK-DESK-120', roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-ch2-ch1' } }] });
    return s;
  }

  it('validate_layout reports free floor, the narrowest walkway and the budget', async () => {
    const { call: c } = await furnished();
    const { j } = await c('validate_layout', { roomId: 'ch1', budgetEur: 500 });
    expect(j).toMatchObject({ ok: true, roomId: 'ch1', violations: [], totalEur: 378, budgetEur: 500, overBudget: false });
    expect(j.freeFloorM2).toBeGreaterThan(0);
    expect(j.minWalkwayM).toBeGreaterThanOrEqual(0.8);
    const over = (await c('validate_layout', { roomId: 'ch1', budgetEur: 300 })).j;
    expect(over).toMatchObject({ overBudget: true, overByEur: 78 });
    const flat = (await c('validate_layout', {})).j;
    expect(flat.totalEur).toBe(378);
    expect(flat).not.toHaveProperty('overBudget');
  });

  it('locked existing furniture counts EUR 0 and is not judged', async () => {
    const { call: c } = await setup();
    const r = (await c('validate_layout', { budgetEur: 0 })).j;
    expect(r).toMatchObject({ totalEur: 0, overBudget: false });
    const bom = (await c('get_bill_of_materials')).j;
    expect(bom.totalEur).toBe(0);
    expect(bom.withoutProduct.find((l: any) => l.itemId === 'placard-ch1')).toMatchObject({ locked: true });
  });

  it('validate_layout finds an item a user dropped into a door swing', async () => {
    const { call: c, search, flat } = await setup();
    await search('bed');
    const rec = mockProductRecords().find((p) => p.sku === 'MOCK-BED-160')!;
    flat.scene = { ...flat.scene, items: [...flat.scene.items, { id: 'u1', assetId: 'x', position: [8.6, 3.6], elevation: 0, rotation: 0, roomId: 'ch1', dims: rec.dims, mount: 'floor' } as never] };
    const { j } = await c('validate_layout', { roomId: 'ch1' });
    expect(j.ok).toBe(false);
    expect(j.violations.length).toBeGreaterThan(0);
    expect(j.violations[0]).toHaveProperty('hint');
  });

  it('validate_layout and get_bill_of_materials: unknown rooms', async () => {
    const { call: c } = await setup();
    expect((await c('validate_layout', { roomId: 'zzz' })).j.code).toBe('unknown_room');
    expect((await c('get_bill_of_materials', { roomId: 'zzz' })).j.code).toBe('unknown_room');
  });

  it('get_bill_of_materials groups by product, filters by room and stays small', async () => {
    const { call: c, search } = await furnished();
    await search('desk');
    const second = await c('place_item', { productId: 'mock:MOCK-DESK-120', roomId: 'sejour', position: [2.85, 2.57] });
    expect(second.j.ok, JSON.stringify(second.j)).toBe(true);
    const all = await c('get_bill_of_materials');
    expect(all.j.totalEur).toBe(457);
    expect(all.j.bySku.find((g: any) => g.productId === 'mock:MOCK-DESK-120')).toMatchObject({ quantity: 2, toBuy: 2, unitPrice: 79, amount: 158, url: 'https://shop.mock.example/p/mock-desk-120' });
    expect(tokens(all.r)).toBeLessThan(1500);
    const room = await c('get_bill_of_materials', { roomId: 'ch1' });
    expect(room.j).toMatchObject({ roomId: 'ch1', totalEur: 378 });
    expect(room.j.bySku.map((g: any) => g.productId).sort()).toEqual(['mock:MOCK-BED-160', 'mock:MOCK-DESK-120']);
  });

  it('stale snapshots are flagged by the clock (more than 7 days)', async () => {
    const { call: c, clock } = await furnished();
    expect((await c('get_bill_of_materials')).j.stale).toBeUndefined();
    clock.advance(1100 * 86_400_000); // the fake clock starts in 2023, the fixture snapshots are from 2026-10-27
    const late = (await c('get_bill_of_materials')).j;
    expect(late.stale).toHaveLength(2);
    expect(late.bySku.every((g: any) => g.stale)).toBe(true);
    expect(late.totalEur).toBe(378); // stale prices are reported, never dropped
  });
});

describe('describe_room with items (budget)', () => {
  it('stays within the token budget with a dozen placed items', async () => {
    const picks = ['MOCK-NIGHT-WHT', 'MOCK-NIGHT-OAK', 'MOCK-SHELF-77', 'MOCK-CHEST-4', 'MOCK-ARM-01', 'MOCK-LAMP-F1', 'MOCK-RUG-170', 'MOCK-BED-160', 'MOCK-DESK-120', 'MOCK-SOFA-3', 'MOCK-WARD-SL100', 'MOCK-MIRR-50'];
    // placed straight into the flat: the budget test is about the description, not about the layout rules
    const s = await setup();
    s.flat.scene = {
      ...s.flat.scene,
      items: [
        ...s.flat.scene.items,
        ...picks.map((sku, i) => {
          const p = mockProductRecords().find((x) => x.sku === sku)!;
          return { id: `i${i}`, assetId: 'param:sofa', position: [7.5 + (i % 4) * 0.7, 0.8 + Math.floor(i / 4) * 0.9], elevation: 0, rotation: 0, roomId: 'ch1', dims: p.dims, mount: 'floor', productRef: { provider: 'mock', sku }, product: { provider: 'mock', sku, name: p.name, url: p.url, price: p.price, currency: 'EUR', dims: p.dims, category: p.category, snapshotAt: p.fetchedAt }, mesh: { kind: 'parametric', generator: 'sofa', params: {} } } as never;
        }),
      ],
    };
    const { r, j } = await s.call('describe_room', { roomId: 'ch1' });
    expect(j.items.length).toBe(13); // 12 + the locked wardrobe
    expect(j.items.find((i: any) => i.productId === 'mock:MOCK-BED-160')).toMatchObject({ price: { amount: 299, currency: 'EUR' }, locked: false });
    expect(tokens(r)).toBeLessThan(4500);
  });
});

describe('place_item on top of furniture (relation "on")', () => {
  const rec = (sku: string, name: string, category: string, dims: { w: number; d: number; h: number }, mount: 'floor' | 'wall' = 'floor') =>
    ProductRecord.parse({ provider: 'mock', sku, name, url: `https://example.test/${sku}`, price: 20, currency: 'EUR', priceTtc: true, dims, dimsSource: 'structured', category, mount, fetchedAt: '2026-10-27T10:00:00.000Z', personalUseOnly: false });
  const products = [
    rec('NIGHT', 'Nightstand', 'bedside', { w: 0.45, d: 0.4, h: 0.55 }),
    rec('LAMP', 'Table lamp', 'lamp', { w: 0.2, d: 0.2, h: 0.4 }),
    rec('FLOORLAMP', 'Floor lamp', 'lamp', { w: 0.3, d: 0.3, h: 1.5 }),
    rec('FRAME', 'Picture frame', 'frame', { w: 0.25, d: 0.03, h: 0.3 }, 'wall'),
    rec('SOFA', 'Sofa', 'sofa', { w: 2, d: 0.9, h: 0.85 }),
    rec('CUSHION', 'Cushion', 'cushion', { w: 0.4, d: 0.4, h: 0.12 }),
  ];
  const NORTH = { kind: 'against_wall', wallId: 'w-north', roomId: 'ch1' } as const;

  it('a table lamp goes on a nightstand placed in the same call ($0), at the height of its top, and the lamp keeps its light', async () => {
    const { call: c, search } = await setup({}, new MockFlatApi({ products }));
    await search('');
    const { j, r } = await c('place_item', { items: [{ productId: 'mock:NIGHT', roomId: 'ch1', relation: NORTH }, { productId: 'mock:LAMP', roomId: 'ch1', relation: { kind: 'on', itemId: '$0' } }] });
    expect(r.isError, JSON.stringify(j)).toBeFalsy();
    expect(j.placed).toHaveLength(2);
    expect(j.placed[1].elevation).toBeCloseTo(0.55, 3);
    expect(j.placed[1].position).toEqual(j.placed[0].position);
    expect(j.placed[1].rationale.join(' ')).toMatch(/on top of/);
    expect(j.placed[1].light).toBeDefined();
    const v = await c('validate_layout', { roomId: 'ch1' });
    expect(v.j.violations.filter((x: any) => x.code === 'overlap')).toEqual([]);
  });

  it('a later call can put a frame on a placed item by id; get_placement_options shows the spot; a floor lamp and a cushion on a nightstand are refused with a reason', async () => {
    const { call: c, search } = await setup({}, new MockFlatApi({ products }));
    await search('');
    const first = await c('place_item', { productId: 'mock:NIGHT', roomId: 'ch1', relation: NORTH });
    const id = first.j.placed[0].itemId as string;
    const opt = await c('get_placement_options', { productId: 'mock:FRAME', roomId: 'ch1', relation: { kind: 'on', itemId: id } });
    expect(opt.j).toMatchObject({ valid: true });
    expect(opt.j.candidates[0].elevation).toBeCloseTo(0.55, 3);
    const frame = await c('place_item', { productId: 'mock:FRAME', roomId: 'ch1', relation: { kind: 'on', itemId: id } });
    expect(frame.r.isError, JSON.stringify(frame.j)).toBeFalsy();
    const floorLamp = await c('place_item', { productId: 'mock:FLOORLAMP', roomId: 'ch1', relation: { kind: 'on', itemId: id } });
    expect(floorLamp.r.isError).toBe(true);
    expect(JSON.stringify(floorLamp.j)).toMatch(/floor lamp/);
    const cushion = await c('place_item', { productId: 'mock:CUSHION', roomId: 'ch1', relation: { kind: 'on', itemId: id } });
    expect(cushion.r.isError).toBe(true);
    expect(JSON.stringify(cushion.j)).toMatch(/sofa/);
  });

  it('a cushion goes on a sofa', async () => {
    const { call: c, search } = await setup({}, new MockFlatApi({ products }));
    await search('');
    const { j, r } = await c('place_item', { items: [{ productId: 'mock:SOFA', roomId: 'ch1', relation: EAST }, { productId: 'mock:CUSHION', roomId: 'ch1', relation: { kind: 'on', itemId: '$0' } }] });
    expect(r.isError, JSON.stringify(j)).toBeFalsy();
    expect(j.placed[1].elevation).toBeGreaterThan(0.3);
    expect(j.placed[1].elevation).toBeLessThan(0.5);
  });

  it('the tool description tells the model about it', async () => {
    const { client } = await connect();
    const d = (await client.listTools()).tools.find((t) => t.name === 'place_item')!.description!;
    expect(d).toMatch(/kind:"on"/);
    expect(d).toMatch(/nightstand/);
  });
});
