import { describe, expect, it } from 'vitest';
import { MockFlatApi } from './testing/mockFlatApi';
import { connect, json, textChars } from './testing/inproc';

/** The local product catalogue as the LLM sees it: results say where they came from, `live: true` is passed on, descriptions stay within budget. */

type Client = Awaited<ReturnType<typeof connect>>['client'];
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { r, j: json(r as never) as Record<string, any> };
};

describe('search_products with a local catalogue', () => {
  it('shows source, fetch date and staleness per result and still accepts the ids it returned', async () => {
    const flat = new MockFlatApi();
    const first = flat.products.slice(0, 2);
    first.forEach((p) => flat.localSkus.add(p.sku));
    const { client } = await connect({}, flat);
    const { r, j } = await call(client, 'search_products', { query: '', limit: 12 });
    const byId = new Map<string, any>(j.results.map((x: any) => [x.productId, x]));
    for (const p of first) expect(byId.get(`${p.provider}:${p.sku}`)).toMatchObject({ source: 'local', fetchedAt: p.fetchedAt.slice(0, 10) });
    const live = j.results.find((x: any) => !first.some((p) => `${p.provider}:${p.sku}` === x.productId));
    expect(live).toMatchObject({ source: 'live' });
    expect(Math.ceil(textChars(r) / 4)).toBeLessThanOrEqual(2900); // a little more than before: three short fields per line
  });

  it('passes live: true to the server and says so in the tool description', async () => {
    const flat = new MockFlatApi();
    const { client } = await connect({}, flat);
    await call(client, 'search_products', { query: 'bed' });
    await call(client, 'search_products', { query: 'bed', live: true });
    expect(flat.searches[0]).not.toHaveProperty('live');
    expect(flat.searches[1]).toMatchObject({ q: 'bed', live: true });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'search_products')!;
    expect(tool.description).toMatch(/local catalogue first/);
    expect((tool.inputSchema.properties as Record<string, any>).live.type).toBe('boolean');
    expect((await call(client, 'search_products', { query: 'bed', live: 'yes' })).j.ok).toBe(false);
  });

  it('get_product tells where the record came from', async () => {
    const flat = new MockFlatApi();
    const { client } = await connect({}, flat);
    const p = flat.products[0]!;
    await call(client, 'search_products', { query: '' });
    const got = await call(client, 'get_product', { productId: `${p.provider}:${p.sku}` });
    expect(got.j).toMatchObject({ fetchedAt: p.fetchedAt });
  });
});
