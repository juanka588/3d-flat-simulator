import { diffScenes } from '@flat/scene';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { HttpFlatApi } from './flatApi';
import { startRealServer, type RealServer } from './testing/harness';
import { connect, json, textChars } from './testing/inproc';
import type { MockFlatApi } from './testing/mockFlatApi';

/**
 * M5.11 end to end, no browser: a real apps/server (FLAT_PROVIDERS=mock) behind HttpFlatApi, and the MCP
 * server in process. The render step of the same flow runs in the slow tier (render/render.test.ts).
 */

let real: RealServer | undefined;
afterEach(async () => {
  await real?.close();
  real = undefined;
});

const EAST = { kind: 'against_wall', wallId: 'w-east' } as const;
const tokens = (r: { content: unknown }) => Math.ceil(textChars(r) / 4);

async function boot() {
  real = await startRealServer({ providers: ['mock'] });
  const config = loadConfig({}, { serverUrl: real.url, log: () => {}, requestTimeoutMs: 10_000 });
  const flat = new HttpFlatApi(config);
  const { client, clock } = await connect({ serverUrl: real.url }, flat as unknown as MockFlatApi);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { r, j: json(r as never) as Record<string, any> };
  };
  return { client, clock, flat, call, url: real.url };
}

describe('furnishing flow against the real server (mock provider)', () => {
  it('providers -> search -> get -> options -> batch place (preview, commit) -> validate -> bill -> undo', async () => {
    const { call, flat } = await boot();

    const providers = (await call('list_providers')).j;
    expect(providers.providers.find((p: any) => p.id === 'mock')).toMatchObject({ enabled: true, circuit: 'closed' });
    expect(providers.providers.find((p: any) => p.id === 'ikea-fr')).toMatchObject({ enabled: false });

    // nothing was searched yet: the server's seen registry refuses the id
    expect((await call('place_item', { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST })).j.code).toBe('unknown_product');

    const search = await call('search_products', { query: '', limit: 12, maxWidth: 2 });
    expect(search.j.count).toBeGreaterThan(5);
    expect(tokens(search.r)).toBeLessThanOrEqual(2500);
    const ids: string[] = search.j.results.map((x: any) => x.productId);
    expect(ids).toEqual(expect.arrayContaining(['mock:MOCK-BED-160', 'mock:MOCK-DESK-120']));

    const got = await call('get_product', { productId: 'mock:MOCK-BED-160' });
    expect(got.j).toMatchObject({ price: 299, weightKg: 48.5 });
    expect(tokens(got.r)).toBeLessThanOrEqual(1200);

    const options = await call('get_placement_options', { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST });
    expect(options.j).toMatchObject({ valid: true });
    expect(options.j.candidates.length).toBeGreaterThanOrEqual(1);

    const before = (await flat.getScene()) as { ok: true; data: { rev: number; scene: any } };
    const args = {
      items: [
        { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST },
        { productId: 'mock:MOCK-DESK-120', roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-ch2-ch1' } },
      ],
      label: 'Furnish Chambre 1',
    };
    const preview = await call('place_item', { ...args, preview: true });
    expect(preview.j).toMatchObject({ ok: true, committed: false, baseRev: before.data.rev });
    const stillThere = (await flat.getScene()) as { ok: true; data: { rev: number; scene: any } };
    expect(stillThere.data.rev).toBe(before.data.rev);

    const commit = await call('place_item', { ...args, ifRev: preview.j.baseRev });
    expect(commit.j).toMatchObject({ ok: true, committed: true, addedEur: 378 });
    const after = (await flat.getScene()) as { ok: true; data: { rev: number; scene: any } };
    expect(diffScenes(before.data.scene, after.data.scene)).toEqual(preview.j.diff);
    const added = after.data.scene.items.filter((i: any) => i.product);
    expect(added.map((i: any) => [i.product.sku, i.product.price, i.product.snapshotAt])).toEqual([['MOCK-BED-160', 299, '2026-10-27T09:00:00.000Z'], ['MOCK-DESK-120', 79, '2026-10-27T09:00:00.000Z']]);

    const layout = await call('validate_layout', { roomId: 'ch1', budgetEur: 500 });
    expect(layout.j).toMatchObject({ ok: true, violations: [], totalEur: 378, overBudget: false });

    const bom = await call('get_bill_of_materials', { roomId: 'ch1' });
    expect(bom.j).toMatchObject({ totalEur: 378 });
    expect(bom.j.bySku.map((g: any) => g.productId)).toEqual(['mock:MOCK-BED-160', 'mock:MOCK-DESK-120']);

    const room = await call('describe_room', { roomId: 'ch1' });
    expect(room.j.items.filter((i: any) => i.productId)).toHaveLength(2);
    expect(tokens(room.r)).toBeLessThan(3500);

    // one undo step reverts the whole batch
    const hist = (await call('list_history')).j;
    expect(hist.past.at(-1).label).toBe('Furnish Chambre 1');
    await call('undo');
    const reverted = (await flat.getScene()) as { ok: true; data: { scene: any } };
    expect(reverted.data.scene.items).toEqual(before.data.scene.items);
  });

  it('the server refuses what the MCP layer would let through: another session\'s search does not count', async () => {
    const a = await boot();
    await a.call('search_products', { query: 'bed' });
    // a second MCP session (new connection) on the same server has its own seen set
    const other = await connect({ serverUrl: a.url }, new HttpFlatApi(loadConfig({}, { serverUrl: a.url, log: () => {} })) as unknown as MockFlatApi, {}, 'other-client');
    const r = json((await other.client.callTool({ name: 'place_item', arguments: { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST } })) as never);
    expect(r.code).toBe('unknown_product');
    expect((await a.call('place_item', { productId: 'mock:MOCK-BED-160', roomId: 'ch1', relation: EAST, preview: true })).j.ok).toBe(true);
  });

  it('provider errors come through with their codes', async () => {
    const { call } = await boot();
    expect((await call('get_product', { productId: 'mock:NOPE' })).j.code).toBe('product_not_found');
    expect((await call('search_products', { query: 'bed', provider: 'ikea-fr' })).j.code).toBe('provider_disabled');
    expect((await call('search_products', { query: 'bed', provider: 'nope' })).j.code).toBe('unknown_provider');
  });
});
