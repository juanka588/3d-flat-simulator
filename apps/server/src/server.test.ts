import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { applyCommand, makeEnvelope, serializeScene, type Command, type LeafCommand, type LogEntry, type ServerMsg } from '@flat/scene';
import { createApp } from './app';
import { loadConfig, type ServerConfig } from './config';
import { startServer } from './server';
import { SceneStore } from './store';

const ORIGIN = 'http://localhost:5173';
let dir: string;
let open: SceneStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flat-server-'));
});
afterEach(async () => {
  for (const s of open) await s.close();
  open = [];
  await rm(dir, { recursive: true, force: true });
});

const cfg = (over: Partial<ServerConfig> = {}) =>
  loadConfig({}, { dataDir: dir, snapshotDebounceMs: 10, log: () => {}, rateLimitPerSec: 100000, ...over });

async function boot(over: Partial<ServerConfig> = {}) {
  const config = cfg(over);
  const store = await SceneStore.open(config);
  open.push(store);
  const app = createApp(store, config);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { store, app, call, config };
}

let n = 0;
const env = (cmd: Command, extra: Record<string, unknown> = {}) => ({
  ...makeEnvelope(cmd, { id: `id-${++n}`, ts: 1000 + n, author: { kind: 'user', name: 't' } }),
  ...extra,
});
const same = (a: unknown, b: unknown) => expect(serializeScene(a as never)).toBe(serializeScene(b as never));
const north = (deg: number): LeafCommand => ({ type: 'site.set', site: { northAngle: deg } });

describe('REST', () => {
  it('serves the scene, healthz and materials', async () => {
    const { call } = await boot();
    const scene = await (await call('GET', '/api/scene')).json();
    expect(scene).toMatchObject({ rev: 0, scene: { version: 1 } });
    expect(typeof scene.epoch).toBe('string');
    expect((await call('GET', '/healthz')).status).toBe(200);
    const mats = await (await call('GET', '/api/materials')).json();
    expect(Array.isArray(mats)).toBe(true);
  });

  it('valid -> 200, invalid -> 422, malformed -> 400', async () => {
    const { call } = await boot();
    const ok = await call('POST', '/api/commands', env(north(12)));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, rev: 1, seq: 1 });

    const bad = await call('POST', '/api/commands', env({ type: 'room.setFloor', roomId: 'nope', materialId: null }));
    expect(bad.status).toBe(422);
    const body = await bad.json();
    expect(body.ok).toBe(false);
    expect(body.errors[0].code).toBe('unknown_entity');

    expect((await call('POST', '/api/commands', { v: 1 })).status).toBe(422);
    expect((await call('POST', '/api/commands', '{not json')).status).toBe(400);
    expect((await call('GET', '/api/scene')).status).toBe(200);
    expect((await (await call('GET', '/api/scene')).json()).rev).toBe(1);
  });

  it('rejects client-supplied undoOf/redoOf', async () => {
    const { call } = await boot();
    const r = await call('POST', '/api/commands', env(north(1), { undoOf: 'x' }));
    expect(r.status).toBe(422);
  });

  it('is idempotent by envelope id', async () => {
    const { call, store } = await boot();
    const e = env(north(33));
    const a = await call('POST', '/api/commands', e);
    const b = await call('POST', '/api/commands', e);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
    expect(store.rev).toBe(1);
    const lines = (await readFile(join(dir, 'log.ndjson'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('stale ifRev -> precondition_failed with the current rev', async () => {
    const { call } = await boot();
    await call('POST', '/api/commands', env(north(1)));
    const r = await call('POST', '/api/commands', env(north(2), { ifRev: 0 }));
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.errors[0].code).toBe('precondition_failed');
    expect(body.rev).toBe(1);
    const fresh = await call('POST', '/api/commands', env(north(3), { ifRev: 1 }));
    expect(fresh.status).toBe(200);
  });

  it('batch authored by llm is one history entry; undo x N then redo x N is identity', async () => {
    const { call } = await boot();
    const initial = await (await call('GET', '/api/scene')).json();
    const batch = env(
      { type: 'batch', label: 'warm living room', commands: [north(10), { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-tile' }, { type: 'scene.setDefaults', wall: 'paint-white' }] },
      { author: { kind: 'llm', name: 'claude' } },
    );
    expect((await call('POST', '/api/commands', batch)).status).toBe(200);
    for (let i = 20; i < 24; i++) await call('POST', '/api/commands', env(north(i)));
    const after = await (await call('GET', '/api/scene')).json();
    const h = await (await call('GET', '/api/history')).json();
    expect(h.past).toHaveLength(5);
    expect(h.past[0]).toMatchObject({ label: 'warm living room', author: { kind: 'llm' } });
    expect(h).toMatchObject({ canUndo: true, canRedo: false });

    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/undo')).status).toBe(200);
    const undone = await (await call('GET', '/api/scene')).json();
    same(undone.scene, initial.scene);
    expect((await call('POST', '/api/undo')).status).toBe(409);
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/redo', { author: { kind: 'user' } })).status).toBe(200);
    const redone = await (await call('GET', '/api/scene')).json();
    same(redone.scene, after.scene);
    expect(redone.rev).toBe(after.rev + 10);
    const log = await (await call('GET', '/api/log?since=5')).json();
    expect(log.entries[0]).toMatchObject({ seq: 6, undoOf: expect.any(String) });
    expect(log.truncated).toBe(false);
  });

  it('100 concurrent POSTs give gapless seq and match sequential replay', async () => {
    const { call, store } = await boot();
    const initial = structuredClone(store.scene);
    const responses = await Promise.all(Array.from({ length: 100 }, (_, i) => call('POST', '/api/commands', env(north(i + 1)))));
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(bodies.map((b) => b.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));

    const log: LogEntry[] = (await (await call('GET', '/api/log?since=0')).json()).entries;
    expect(log.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    let scene = initial;
    for (const e of log) {
      const r = applyCommand(scene, e.envelope);
      if (!r.ok) throw new Error('replay failed');
      scene = r.scene;
    }
    same(scene, store.scene);
  });

  it('PUT imports with a new epoch; an invalid PUT is 422 and leaves the live scene untouched', async () => {
    const { call, store } = await boot();
    await call('POST', '/api/commands', env(north(5)));
    const before = await (await call('GET', '/api/scene')).json();

    const bad = await call('PUT', '/api/scene', { version: 1, name: 'x', walls: 'nope' });
    expect(bad.status).toBe(422);
    const body = await bad.json();
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0].path).not.toBe('');
    expect((await call('PUT', '/api/scene', '{oops')).status).toBe(400);
    expect(await (await call('GET', '/api/scene')).json()).toEqual(before);

    const text = await readFile(new URL('../../../packages/scene/fixtures/sample.flat.json', import.meta.url), 'utf8');
    const ok = await call('PUT', '/api/scene', text);
    expect(ok.status).toBe(200);
    const after = await (await call('GET', '/api/scene')).json();
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.rev).toBe(0);
    expect((await (await call('GET', '/api/history')).json()).canUndo).toBe(false);
    expect(store.seq).toBe(0);
    expect((await readFile(join(dir, 'log.ndjson'), 'utf8')).trim()).toBe('');
  });
});

describe('security', () => {
  it('bad Origin -> 403 on writes; allowed Origin gets CORS headers; no Origin is allowed', async () => {
    const { call } = await boot();
    const evil = await call('POST', '/api/commands', env(north(1)), { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect((await call('PUT', '/api/scene', '{}', { origin: 'null' })).status).toBe(403);
    const good = await call('POST', '/api/commands', env(north(2)), { origin: ORIGIN });
    expect(good.status).toBe(200);
    expect(good.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const read = await call('GET', '/api/scene', undefined, { origin: 'https://evil.example' });
    expect(read.headers.get('access-control-allow-origin')).toBeNull();
    expect((await call('GET', '/api/scene', undefined, { host: 'evil.example' })).status).toBe(403);
  });

  it('FLAT_TOKEN gates writes only', async () => {
    const { call } = await boot({ token: 's3cret' });
    expect((await call('POST', '/api/commands', env(north(1)))).status).toBe(401);
    expect((await call('POST', '/api/commands', env(north(1)), { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call('POST', '/api/commands', env(north(1)), { authorization: 'Bearer s3cret' })).status).toBe(200);
    expect((await call('GET', '/api/scene')).status).toBe(200);
  });

  it('enforces body size and rate limits', async () => {
    const { call } = await boot({ bodyLimit: 200, rateLimitPerSec: 3 });
    expect((await call('POST', '/api/commands', 'x'.repeat(500))).status).toBe(413);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await call('POST', '/api/commands', env(north(i + 1)))).status);
    expect(codes).toContain(429);
  });
});

describe('persistence', () => {
  it('restores scene, rev and history after restart, and survives a torn last log line', async () => {
    const first = await boot();
    const { call, store } = first;
    for (let i = 1; i <= 5; i++) await call('POST', '/api/commands', env(north(i * 3)));
    await call('POST', '/api/undo');
    const live = { scene: structuredClone(store.scene), rev: store.rev, epoch: store.epoch };
    await store.close();
    open = [];

    // simulate a crash mid-write: the log tail never made it into a snapshot, and the last line is torn
    const second = await boot();
    expect(second.store.rev).toBe(live.rev);
    expect(second.store.epoch).toBe(live.epoch);
    same(second.store.scene, live.scene);
    expect(second.store.historyView().past).toHaveLength(4);
    expect(second.store.historyView().canRedo).toBe(true);
    await second.store.close();
    open = [];

    await appendFile(join(dir, 'log.ndjson'), '{"epoch":"x","seq":8,"rev":8,"enve');
    const third = await boot();
    expect(third.store.rev).toBe(live.rev);
    same(third.store.scene, live.scene);
    // the log stays appendable after the torn line was cut
    expect((await third.call('POST', '/api/commands', env(north(77)))).status).toBe(200);
    await third.store.close();
    open = [];
    const fourth = await boot();
    expect(fourth.store.rev).toBe(live.rev + 1);
    // idempotency survives the restart too
    const logLines = (await readFile(join(dir, 'log.ndjson'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as LogEntry);
    const dup = await fourth.call('POST', '/api/commands', logLines.at(-1)!.envelope);
    expect(await dup.json()).toMatchObject({ rev: live.rev + 1 });
    expect(fourth.store.rev).toBe(live.rev + 1);
  });

  it('replays the log tail when the snapshot is stale (crash before the debounced snapshot)', async () => {
    const { call, store } = await boot({ snapshotDebounceMs: 60_000 });
    for (let i = 1; i <= 4; i++) await call('POST', '/api/commands', env(north(i)));
    const expected = structuredClone(store.scene);
    // no close(): the snapshot on disk is still the initial one
    open = [];
    const snap = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    expect(snap.rev).toBe(0);
    const again = await boot();
    expect(again.store.rev).toBe(4);
    same(again.store.scene, expected);
  });

  it('compacts the log past the threshold without losing state', async () => {
    const { call, store } = await boot({ compactAfter: 10 });
    for (let i = 1; i <= 25; i++) await call('POST', '/api/commands', env(north(i)));
    const lines = (await readFile(join(dir, 'log.ndjson'), 'utf8')).trim().split('\n').filter(Boolean);
    expect(lines.length).toBeLessThan(10);
    expect((await (await call('GET', '/api/log?since=0')).json()).truncated).toBe(true);
    const expected = structuredClone(store.scene);
    await store.close();
    open = [];
    const again = await boot({ compactAfter: 10 });
    expect(again.store.rev).toBe(25);
    same(again.store.scene, expected);
    expect(await readFile(join(dir, 'scene.flat.json'), 'utf8')).toBe(serializeScene(expected));
  });

  it('boots from SCENE_FILE', async () => {
    const file = join(dir, 'custom.json');
    await writeFile(file, await readFile(new URL('../../../packages/scene/fixtures/sample.flat.json', import.meta.url), 'utf8'));
    const { store } = await boot({ sceneFile: file, dataDir: join(dir, 'data') });
    expect(store.rev).toBe(0);
  });
});

describe('WebSocket', () => {
  async function live(over: Partial<ServerConfig> = {}) {
    const running = await startServer(cfg({ port: 0, ...over }));
    open.push(running.store);
    return running;
  }
  const collect = (ws: WebSocket) => {
    const msgs: ServerMsg[] = [];
    const waiters: Array<() => void> = [];
    ws.on('message', (d) => {
      msgs.push(JSON.parse(d.toString()));
      waiters.splice(0).forEach((w) => w());
    });
    const next = async (n: number) => {
      while (msgs.length < n) await new Promise<void>((r) => waiters.push(r));
      return msgs;
    };
    return { msgs, next };
  };
  const connect = (url: string, origin?: string) =>
    new Promise<WebSocket & { c: ReturnType<typeof collect> }>((resolve, reject) => {
      const ws = new WebSocket(url.replace('http', 'ws') + '/ws', origin ? { origin } : {}) as WebSocket & { c: ReturnType<typeof collect> };
      ws.c = collect(ws);
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
      ws.once('error', reject);
    });

  it('sends hello, then applied after a POST, reset on import, and answers ping', async () => {
    const s = await live();
    const ws = await connect(s.url, ORIGIN);
    const c = ws.c;
    const hello = (await c.next(1))[0]!;
    expect(hello).toMatchObject({ type: 'hello', rev: 0 });

    const res = await fetch(`${s.url}/api/commands`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(env(north(42))) });
    expect(res.status).toBe(200);
    const applied = (await c.next(2))[1]!;
    expect(applied).toMatchObject({ type: 'applied', seq: 1, rev: 1, envelope: { cmd: { type: 'site.set' } }, inverse: { type: 'site.set' } });

    ws.send(JSON.stringify({ type: 'ping' }));
    expect((await c.next(3))[2]).toEqual({ type: 'pong' });

    const sample = await readFile(new URL('../../../packages/scene/fixtures/sample.flat.json', import.meta.url), 'utf8');
    await fetch(`${s.url}/api/scene`, { method: 'PUT', body: sample });
    const reset = (await c.next(4))[3]!;
    expect(reset).toMatchObject({ type: 'reset', rev: 0 });
    expect((reset as { epoch: string }).epoch).not.toBe((hello as { epoch: string }).epoch);

    ws.close();
    await s.close();
    open = [];
  });

  it('rejects a bad Origin on the upgrade with 403', async () => {
    const s = await live();
    await expect(connect(s.url, 'https://evil.example')).rejects.toThrow('403');
    const ok = await connect(s.url);
    ok.close();
    await s.close();
    open = [];
  });
});
