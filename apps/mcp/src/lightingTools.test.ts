import { ProductRecord } from '@flat/assets';
import { describe, expect, it } from 'vitest';
import { connect, json } from './testing/inproc';
import { MockFlatApi, mockProductRecords } from './testing/mockFlatApi';

/** M5.19-M5.21: LED grids through light_add / light_update, lamp products that carry a light, and the lighting plan. */

type Client = Awaited<ReturnType<typeof connect>>['client'];
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { r, j: json(r as never) as Record<string, any> };
};

const lamp = (sku: string, name: string, h: number, extra: Record<string, unknown> = {}): ProductRecord =>
  ProductRecord.parse({
    provider: 'mock',
    sku,
    name,
    url: `https://shop.mock.example/p/${sku.toLowerCase()}`,
    price: 25,
    currency: 'EUR',
    priceTtc: true,
    dims: { w: 0.3, d: 0.3, h },
    dimsSource: 'structured',
    category: 'lamp',
    mount: 'floor',
    colours: ['white'],
    fetchedAt: '2026-10-27T09:00:00.000Z',
    personalUseOnly: false,
    ...extra,
  });

async function setup() {
  const flat = new MockFlatApi({ products: [...mockProductRecords(), lamp('LAMP-BULB', 'MOCK Lampadaire avec ampoule', 1.5, { lumens: 1055 }), lamp('LAMP-PLAIN', 'MOCK Lampe de table', 0.4)] });
  const c = await connect({}, flat);
  return { ...c, flat, call: (name: string, args?: Record<string, unknown>) => call(c.client, name, args) };
}

describe('LED grids through light_add and light_update', () => {
  it('light_add places a 3x4 grid fitted to the room; light_update resizes and dims it; undo restores', async () => {
    const { call: c, flat } = await setup();
    const before = flat.scene;
    const add = await c('light_add', { light: { type: 'grid', id: 'led', roomId: 'sejour', fitToRoom: true, rows: 3, cols: 4, lumensEach: 450, kelvin: 2700 } });
    expect(add.j, JSON.stringify(add.j)).toMatchObject({ ok: true, committed: true });
    const g = flat.scene.lights.find((l) => l.id === 'led')!;
    expect(g).toMatchObject({ type: 'grid', rows: 3, cols: 4, lumensEach: 450, roomId: 'sejour' });

    const up = await c('light_update', { id: 'led', patch: { rows: 2, cols: 5, lumensEach: 300 } });
    expect(up.j.ok).toBe(true);
    expect(flat.scene.lights.find((l) => l.id === 'led')).toMatchObject({ rows: 2, cols: 5, lumensEach: 300 });

    const room = await c('describe_room', { roomId: 'sejour' });
    const light = room.j.lights.find((l: any) => l.id === 'led');
    expect(light).toMatchObject({ type: 'grid', rows: 2, cols: 5, lumensEach: 300, lumens: 3000, on: true });
    expect(light.grid).toMatchObject({ elevationM: expect.any(Number) });

    await c('undo');
    await c('undo');
    expect(flat.scene.lights).toStrictEqual(before.lights);
  });

  it('describe_room gives the lighting plan: target lux for the room type, what the lights give, a grid that reaches it', async () => {
    const { call: c } = await setup();
    const { j } = await c('describe_room', { roomId: 'sejour' });
    const plan = j.lighting_plan;
    expect(j.type).toBe('living');
    expect(plan).toMatchObject({ targetLux: { min: 100, max: 150 } });
    expect(plan.installedLumens).toBeGreaterThan(0);
    expect(plan.suggestedGrid).toMatchObject({ rows: expect.any(Number), cols: expect.any(Number), lumensEach: expect.any(Number) });
    // the suggestion can be sent as is
    const s = plan.suggestedGrid;
    const lux = (s.rows * s.cols * s.lumensEach * 0.5) / j.areaM2;
    expect(lux).toBeGreaterThan(90);
    expect(lux).toBeLessThan(165);
    const wcRoom = (await c('describe_room', { roomId: 'wc' })).j;
    const wc = wcRoom.lighting_plan;
    expect(wcRoom.type).toBe('bathroom');
    expect(wc.targetLux.min).toBeLessThanOrEqual(200);
  });

  it('rejects a grid that is too big or incomplete with a message that says what to send', async () => {
    const { call: c, flat } = await setup();
    const rev = flat.rev;
    const big = await c('light_add', { light: { type: 'grid', roomId: 'sejour', fitToRoom: true, rows: 20, cols: 20, lumensEach: 100 } });
    expect(big.r.isError).toBe(true);
    expect(JSON.stringify(big.j)).toMatch(/100 fixtures/);
    const partial = await c('light_add', { light: { type: 'grid', rows: 2, cols: 2, lumensEach: 100 } });
    expect(partial.r.isError).toBe(true);
    expect(JSON.stringify(partial.j)).toMatch(/fitToRoom/);
    expect(flat.rev).toBe(rev);
  });
});

describe('lamp products carry a light', () => {
  const placeArgs = (productId: string) => ({ productId, roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-east' } });

  it('a lamp with lumens on its page lights with them (source "product"); one without gets the kind default ("estimated")', async () => {
    const { call: c, flat } = await setup();
    await c('search_products', { query: '', category: 'lamp' });
    const a = await c('place_item', placeArgs('mock:LAMP-BULB'));
    expect(a.j, JSON.stringify(a.j)).toMatchObject({ ok: true, committed: true });
    expect(a.j.placed[0].light).toMatchObject({ lumens: 1055, kelvin: 2700, lumensSource: 'product' });
    const b = await c('place_item', { ...placeArgs('mock:LAMP-PLAIN'), relation: { kind: 'against_wall', wallId: 'w-north' } });
    expect(b.j.ok, JSON.stringify(b.j)).toBe(true);
    expect(b.j.placed[0].light).toMatchObject({ lumens: 400, lumensSource: 'estimated' });

    const room = (await c('describe_room', { roomId: 'ch1' })).j;
    const lights = room.lights.filter((l: any) => l.itemId);
    expect(lights.map((l: any) => [l.lumens, l.lumensSource]).sort()).toEqual([[1055, 'product'], [400, 'estimated']]);
    expect(flat.scene.lights.filter((l) => l.itemId)).toHaveLength(2);
  });

  it('the light can be dimmed and switched with light_update, follows the item, and goes with it on undo', async () => {
    const { call: c, flat } = await setup();
    await c('search_products', { query: '', category: 'lamp' });
    const placed = await c('place_item', placeArgs('mock:LAMP-BULB'));
    const itemId = placed.j.placed[0].itemId as string;
    const lightId = placed.j.placed[0].light.id as string;

    const dim = await c('light_update', { id: lightId, patch: { lumens: 300, on: false } });
    expect(dim.j.ok).toBe(true);
    expect(flat.scene.lights.find((l) => l.id === lightId)).toMatchObject({ lumens: 300, on: false, lumensSource: 'user' });

    const bad = await c('light_update', { id: lightId, patch: { position: [1, 1] } });
    expect(bad.r.isError).toBe(true);
    const rm = await c('light_remove', { id: lightId });
    expect(rm.r.isError).toBe(true);

    const item = flat.scene.items.find((i) => i.id === itemId)!;
    const moved = await c('item_move', { id: itemId, position: [item.position[0], item.position[1] + 0.4] });
    expect(moved.j.ok, JSON.stringify(moved.j)).toBe(true);
    const light = flat.scene.lights.find((l) => l.id === lightId)!;
    expect(light.position[1]).toBeCloseTo(item.position[1] + 0.4, 9);

    await c('undo'); // the move
    expect(flat.scene.lights.find((l) => l.id === lightId)!.position[1]).toBeCloseTo(item.position[1], 9);
    await c('item_remove', { id: itemId });
    expect(flat.scene.lights.some((l) => l.id === lightId)).toBe(false);
    await c('undo');
    expect(flat.scene.lights.find((l) => l.id === lightId)).toMatchObject({ lumens: 300, on: false, itemId });
  });
});
