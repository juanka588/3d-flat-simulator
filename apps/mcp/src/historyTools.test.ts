import { makeEnvelope } from '@flat/scene';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpFlatApi } from './flatApi';
import { loadConfig } from './config';
import { newSession } from './tools';
import { historyTools } from './tools/history';
import { connect, fakeClock, json } from './testing/inproc';
import { MockFlatApi } from './testing/mockFlatApi';
import { startRealServer, type RealServer } from './testing/harness';

type Client = Awaited<ReturnType<typeof connect>>['client'];
const floor = (client: Client, materialId: string, label?: string) => client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId, ...(label ? { label } : {}) } });
const floorOf = (flat: MockFlatApi) => flat.scene.rooms.find((r) => r.id === 'sejour')!.floorMaterial;

describe('history tools on the mock (M4.7)', () => {
  it('list_history shows who changed what, newest last, with a limit', async () => {
    const { client, flat } = await connect();
    await floor(client, 'floor-oak', 'oak');
    await flat.postCommand(makeEnvelope({ type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-deck' }, { id: 'u1', ts: 5, author: { kind: 'user' } }));
    await floor(client, 'floor-tile', 'tile');
    const all = json(await client.callTool({ name: 'list_history', arguments: {} }));
    expect(all).toMatchObject({ ok: true, canUndo: true, canRedo: false, undoDepth: 3, redoDepth: 0 });
    expect(all.past.map((p: { label: string; author: string }) => [p.label, p.author])).toEqual([['oak', 'llm:unit-client'], ['Floor of Séjour → Balcony slab (matt)', 'user'], ['tile', 'llm:unit-client']]);
    const last = json(await client.callTool({ name: 'list_history', arguments: { limit: 1 } }));
    expect(last.past.map((p: { label: string }) => p.label)).toEqual(['tile']);
    expect(json(await client.callTool({ name: 'list_history', arguments: { limit: 0 } })).code).toBe('invalid_command');
  });

  it('undo reverts the latest change whoever made it (shared stack) and says whose it was', async () => {
    const { client, flat } = await connect();
    await floor(client, 'floor-oak');
    await flat.postCommand(makeEnvelope({ type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-deck' }, { id: 'u1', ts: 5, author: { kind: 'user' } }));
    expect(floorOf(flat)).toBe('floor-deck');
    const r = await client.callTool({ name: 'undo', arguments: {} });
    expect(r.isError).toBeFalsy();
    const body = json(r);
    expect(body.undid).toMatchObject({ author: 'user' });
    expect(body.note).toContain('made by "user"');
    expect(floorOf(flat)).toBe('floor-oak');
    // the undo itself is attributed to the llm in the log
    expect(flat.log.at(-1)!.envelope.author).toEqual({ kind: 'llm', name: 'unit-client' });
    const again = json(await client.callTool({ name: 'undo', arguments: {} }));
    expect(again.undid.author).toBe('llm:unit-client');
    expect(again.note).toBeUndefined();
    expect(floorOf(flat)).not.toBe('floor-oak');
  });

  it('undo / redo expectId: the entry you saw is undone; a different top entry is stale_scene and nothing changes', async () => {
    const { client, flat } = await connect();
    await floor(client, 'floor-oak', 'oak');
    const seen = json(await client.callTool({ name: 'list_history', arguments: {} })).past.at(-1).id;
    await flat.postCommand(makeEnvelope({ type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-deck' }, { id: 'u1', ts: 5, author: { kind: 'user' } }));
    const stale = await client.callTool({ name: 'undo', arguments: { expectId: seen } });
    expect(stale.isError).toBe(true);
    expect(json(stale)).toMatchObject({ code: 'stale_scene', hint: expect.stringContaining('list_history') });
    expect(floorOf(flat)).toBe('floor-deck');
    expect(flat.hist.past).toHaveLength(2);
    const topId = json(await client.callTool({ name: 'list_history', arguments: {} })).past.at(-1).id;
    expect(json(await client.callTool({ name: 'undo', arguments: { expectId: topId } }))).toMatchObject({ ok: true, undid: { id: topId } });
    expect(floorOf(flat)).toBe('floor-oak');

    const next = json(await client.callTool({ name: 'list_history', arguments: {} })).redoNext[0].id;
    expect(json(await client.callTool({ name: 'redo', arguments: { expectId: 'nope' } })).code).toBe('stale_scene');
    expect(flat.hist.future).toHaveLength(1);
    expect(json(await client.callTool({ name: 'redo', arguments: { expectId: next } }))).toMatchObject({ ok: true, redid: { id: next } });
  });

  it('the undo / redo descriptions promise only what they do', async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const undo = tools.find((t) => t.name === 'undo')!;
    expect(undo.description).toContain('expectId');
    expect(undo.description).not.toMatch(/since the history was read/);
    expect(Object.keys((undo.inputSchema as { properties: object }).properties)).toEqual(['expectId']);
  });

  it('redo re-applies, and both report nothing_to_undo / nothing_to_redo on empty stacks', async () => {
    const { client, flat } = await connect();
    expect(json(await client.callTool({ name: 'undo', arguments: {} })).code).toBe('nothing_to_undo');
    expect(json(await client.callTool({ name: 'redo', arguments: {} })).code).toBe('nothing_to_redo');
    await floor(client, 'floor-oak', 'oak');
    await client.callTool({ name: 'undo', arguments: {} });
    const r = json(await client.callTool({ name: 'redo', arguments: {} }));
    expect(r).toMatchObject({ ok: true, redid: { label: 'oak' } });
    expect(floorOf(flat)).toBe('floor-oak');
  });

  it('the server\'s own "nothing to undo" answer maps too (history raced)', async () => {
    const { client, flat } = await connect();
    await floor(client, 'floor-oak');
    const real = flat.history.bind(flat);
    flat.history = async () => {
      const h = await real();
      flat.hist = { ...flat.hist, past: [], future: [] };
      return h;
    };
    expect(json(await client.callTool({ name: 'undo', arguments: {} })).code).toBe('nothing_to_undo');
  });

  it('a change between reading the history and undoing is stale_scene, not a silent wrong undo', async () => {
    const { client, flat } = await connect();
    await floor(client, 'floor-oak');
    const real = flat.history.bind(flat);
    flat.history = async () => {
      const h = await real();
      await flat.postCommand(makeEnvelope({ type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-deck' }, { id: 'u-race', ts: 5, author: { kind: 'user' } }));
      return h;
    };
    const r = await client.callTool({ name: 'undo', arguments: {} });
    expect(json(r)).toMatchObject({ code: 'stale_scene' });
    expect(floorOf(flat)).toBe('floor-deck');
  });

  it('checkpoint then restore_checkpoint undoes everything since, whoever made it; redo works after', async () => {
    const { client, flat } = await connect();
    await floor(client, 'floor-tile', 'before');
    const cp = json(await client.callTool({ name: 'checkpoint', arguments: { name: 'start' } }));
    expect(cp).toMatchObject({ ok: true, checkpoint: { name: 'start', depth: 1 } });
    await floor(client, 'floor-oak', 'a');
    await flat.postCommand(makeEnvelope({ type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-deck' }, { id: 'u1', ts: 5, author: { kind: 'user' } }));
    const r = json(await client.callTool({ name: 'restore_checkpoint', arguments: { name: 'start' } }));
    expect(r).toMatchObject({ ok: true, restored: 'start', steps: 2, committed: true });
    expect(floorOf(flat)).toBe('floor-tile');
    expect(json(await client.callTool({ name: 'redo', arguments: {} })).ok).toBe(true);
    const h = json(await client.callTool({ name: 'list_history', arguments: {} }));
    expect(h.checkpoints.map((c: { name: string }) => c.name)).toEqual(['start']);
  });

  it('restoring the checkpoint you are already at is a no-op', async () => {
    const { client } = await connect();
    await client.callTool({ name: 'checkpoint', arguments: { name: 'here' } });
    const r = json(await client.callTool({ name: 'restore_checkpoint', arguments: { name: 'here' } }));
    expect(r).toMatchObject({ ok: true, steps: 0, noop: true, committed: false });
  });

  it('a reused checkpoint name is refused with a hint about replace, and replace moves it', async () => {
    const { client } = await connect();
    await floor(client, 'floor-oak');
    await client.callTool({ name: 'checkpoint', arguments: { name: 'cp' } });
    await floor(client, 'floor-tile');
    const dup = await client.callTool({ name: 'checkpoint', arguments: { name: 'cp' } });
    expect(dup.isError).toBe(true);
    expect(json(dup)).toMatchObject({ code: 'invalid_command' });
    expect(json(dup).hint).toContain('replace: true');
    const moved = json(await client.callTool({ name: 'checkpoint', arguments: { name: 'cp', replace: true } }));
    expect(moved.checkpoint).toMatchObject({ name: 'cp', depth: 2 });
  });

  it('an unknown checkpoint is unknown_checkpoint with the nearest names', async () => {
    const { client } = await connect();
    await client.callTool({ name: 'checkpoint', arguments: { name: 'before-style' } });
    const r = await client.callTool({ name: 'restore_checkpoint', arguments: { name: 'before-styl' } });
    expect(r.isError).toBe(true);
    expect(json(r).code).toBe('unknown_checkpoint');
    expect(json(r).hint).toContain('before-style');
    const c2 = await connect({}, new MockFlatApi());
    expect(json(await c2.client.callTool({ name: 'restore_checkpoint', arguments: { name: 'x' } })).hint).toContain('no checkpoints');
  });

  it('undone past the checkpoint, or a diverged history, is precondition_failed with advice', async () => {
    const { client } = await connect();
    await floor(client, 'floor-oak');
    await client.callTool({ name: 'checkpoint', arguments: { name: 'cp' } });
    await client.callTool({ name: 'undo', arguments: {} });
    const past = await client.callTool({ name: 'restore_checkpoint', arguments: { name: 'cp' } });
    expect(json(past)).toMatchObject({ code: 'precondition_failed' });
    expect(json(past).hint).toContain('list_history');

    const c2 = await connect();
    await floor(c2.client, 'floor-oak', 'one');
    await c2.client.callTool({ name: 'checkpoint', arguments: { name: 'cp' } });
    await c2.client.callTool({ name: 'undo', arguments: {} });
    await floor(c2.client, 'floor-deck', 'diverged');
    const div = await c2.client.callTool({ name: 'restore_checkpoint', arguments: { name: 'cp' } });
    expect(json(div).code).toBe('precondition_failed');
    expect(json(div).message).toContain('diverged');
  });

  it('missing server endpoints map cleanly to not_implemented', async () => {
    const { client, flat } = await connect();
    const missing = { ok: false as const, kind: 'http' as const, status: 404, errors: [{ code: 'internal_error', path: '', message: 'scene server answered 404' }] };
    flat.failNext(missing);
    expect(json(await client.callTool({ name: 'checkpoint', arguments: { name: 'a' } })).code).toBe('not_implemented');
    flat.failNext(missing);
    expect(json(await client.callTool({ name: 'restore_checkpoint', arguments: { name: 'a' } })).code).toBe('not_implemented');
    // list_history still works without checkpoints
    const orig = flat.listCheckpoints.bind(flat);
    flat.listCheckpoints = async () => missing;
    const h = json(await client.callTool({ name: 'list_history', arguments: {} }));
    expect(h).toMatchObject({ ok: true, checkpoints: [], note: expect.stringContaining('not available') });
    flat.listCheckpoints = orig;
  });

  it('server_unreachable and the read-only mode', async () => {
    const { client, flat } = await connect();
    flat.down = true;
    for (const name of ['undo', 'redo', 'list_history']) expect(json(await client.callTool({ name, arguments: {} })).code, name).toBe('server_unreachable');
    expect(json(await client.callTool({ name: 'checkpoint', arguments: { name: 'a' } })).code).toBe('server_unreachable');
    const ro = await connect({ readOnly: true });
    const names = (await ro.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('list_history');
    expect(names).not.toContain('checkpoint');
    expect(names).not.toContain('undo');
    expect(names).not.toContain('restore_checkpoint');
    // a client that calls it anyway (stale tool list) is still refused by the handler
    const config = loadConfig({}, { readOnly: true, log: () => {} });
    const clock = fakeClock();
    const ctx = { flat: new MockFlatApi(), limits: config.limits, clock, author: { kind: 'llm' as const, name: 'x' }, session: newSession(config.limits, clock), config };
    const cp = historyTools().find((t) => t.name === 'checkpoint')!;
    expect(json(await cp.handler(ctx, { name: 'a' })).code).toBe('read_only');
  });
});

describe('history tools against the real apps/server (in process)', () => {
  let real: RealServer | undefined;
  afterEach(async () => {
    await real?.close();
    real = undefined;
  });

  it('write, checkpoint, write, restore, redo, list_history over HTTP', async () => {
    real = await startRealServer();
    const config = loadConfig({}, { serverUrl: real.url, log: () => {} });
    const flat = new HttpFlatApi(config);
    const { client } = await connect({ serverUrl: real.url }, flat as unknown as MockFlatApi);
    const sejourFloor = async () => ((await flat.getScene()) as { data: { scene: { rooms: { id: string; floorMaterial?: string }[] } } }).data.scene.rooms.find((r) => r.id === 'sejour')!.floorMaterial;

    const w1 = json(await floor(client, 'floor-oak', 'oak floor'));
    expect(w1).toMatchObject({ ok: true, committed: true, rev: 1 });
    const cp = json(await client.callTool({ name: 'checkpoint', arguments: { name: 'start' } }));
    expect(cp.checkpoint).toMatchObject({ name: 'start', depth: 1 });
    const dup = await client.callTool({ name: 'checkpoint', arguments: { name: 'start' } });
    expect(json(dup).hint).toContain('replace: true');
    await floor(client, 'floor-deck', 'deck floor');
    expect(await sejourFloor()).toBe('floor-deck');

    const prev = json(await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-tile', preview: true } }));
    expect(prev).toMatchObject({ committed: false, baseRev: 2 });
    expect(await sejourFloor()).toBe('floor-deck');

    const restored = json(await client.callTool({ name: 'restore_checkpoint', arguments: { name: 'start' } }));
    expect(restored).toMatchObject({ ok: true, steps: 1, restored: 'start' });
    expect(await sejourFloor()).toBe('floor-oak');
    expect(json(await client.callTool({ name: 'redo', arguments: {} })).redid.label).toBe('deck floor');
    expect(await sejourFloor()).toBe('floor-deck');

    const h = json(await client.callTool({ name: 'list_history', arguments: {} }));
    expect(h.past.map((p: { label: string }) => p.label)).toEqual(['oak floor', 'deck floor']);
    expect(h.checkpoints.map((c: { name: string }) => c.name)).toEqual(['start']);

    const unknown = await client.callTool({ name: 'restore_checkpoint', arguments: { name: 'nope' } });
    expect(json(unknown).code).toBe('unknown_checkpoint');
    expect(json(await client.callTool({ name: 'undo', arguments: {} })).undid.label).toBe('deck floor');
  });

  it('refusing a structural change end to end, and reading through the real catalog', async () => {
    real = await startRealServer();
    const flat = new HttpFlatApi(loadConfig({}, { serverUrl: real.url, log: () => {} }));
    const { client } = await connect({ serverUrl: real.url }, flat as unknown as MockFlatApi);
    const r = await client.callTool({ name: 'wall_set_structural', arguments: { wallId: 'w-north', structural: false } });
    expect(json(r).code).toBe('precondition_failed');
    const mats = (await client.callTool({ name: 'list_materials', arguments: {} })).structuredContent as { library: unknown[] };
    expect(mats.library.length).toBe(29);
    const s = json(await client.callTool({ name: 'get_scene_summary', arguments: {} }));
    expect(s.counts.rooms).toBe(8);
  });
});

describe('locked items cannot be reached through undo / redo / restore_checkpoint by an LLM (M1)', () => {
  const cabinet = { type: 'item.place', item: { assetId: 'param:wardrobe', id: 'locked-cab', position: [7.71, 1], roomId: 'ch1', dims: { w: 0.6, d: 0.6, h: 1 }, locked: true } } as const;
  const userPlace = (id: string) => makeEnvelope(cabinet as never, { id, ts: 5, author: { kind: 'user' } });

  it('on the mock: undo and restore_checkpoint of a user-placed locked item are refused, the user keeps their own undo', async () => {
    const { client, flat } = await connect();
    await client.callTool({ name: 'checkpoint', arguments: { name: 'before' } });
    expect((await flat.postCommand(userPlace('lock-1'))).ok).toBe(true);
    const undo = await client.callTool({ name: 'undo', arguments: {} });
    expect(undo.isError).toBe(true);
    expect(json(undo)).toMatchObject({ code: 'precondition_failed', hint: 'locked item: ask the user' });
    const restore = await client.callTool({ name: 'restore_checkpoint', arguments: { name: 'before' } });
    expect(json(restore)).toMatchObject({ ok: false, code: 'precondition_failed', hint: 'locked item: ask the user' });
    expect(flat.scene.items.some((i) => i.id === 'locked-cab')).toBe(true);
    const byUser = await flat.undo({ id: 'user-undo', author: { kind: 'user' } });
    expect(byUser.ok).toBe(true);
    expect(flat.scene.items.some((i) => i.id === 'locked-cab')).toBe(false);
  });

  let real: RealServer | undefined;
  afterEach(async () => {
    await real?.close();
    real = undefined;
  });

  it('end to end over the real server: /api/undo and /api/undo-to carry the author, so the same refusal applies', async () => {
    real = await startRealServer();
    const flat = new HttpFlatApi(loadConfig({}, { serverUrl: real.url, log: () => {} }));
    const { client } = await connect({ serverUrl: real.url }, flat as unknown as MockFlatApi);
    await client.callTool({ name: 'checkpoint', arguments: { name: 'before' } });
    const placed = await flat.postCommand(userPlace('lock-r1'));
    expect(placed.ok, JSON.stringify(placed)).toBe(true);
    const undo = await client.callTool({ name: 'undo', arguments: {} });
    expect(json(undo)).toMatchObject({ ok: false, code: 'precondition_failed', hint: 'locked item: ask the user' });
    const restore = await client.callTool({ name: 'restore_checkpoint', arguments: { name: 'before' } });
    expect(json(restore)).toMatchObject({ ok: false, code: 'precondition_failed', hint: 'locked item: ask the user' });
    const items = ((await flat.getScene()) as { data: { scene: { items: { id: string }[] } } }).data.scene.items;
    expect(items.some((i) => i.id === 'locked-cab')).toBe(true);
    // the user (no author given = the server's own user author) can undo it
    const byUser = await flat.undo({ id: 'user-undo-r', author: { kind: 'user' } });
    expect(byUser.ok).toBe(true);
  });
});
