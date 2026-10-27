import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { HISTORY_CAP, makeEnvelope, serializeScene, type Command, type LeafCommand, type ServerMsg } from '@flat/scene';
import { createApp } from './app';
import { loadConfig, type ServerConfig } from './config';
import { startServer } from './server';
import { MAX_CHECKPOINTS, SceneStore } from './store';

let dir: string;
let open: SceneStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flat-cp-'));
});
afterEach(async () => {
  for (const s of open) await s.close();
  open = [];
  await rm(dir, { recursive: true, force: true });
});

const cfg = (over: Partial<ServerConfig> = {}) => loadConfig({}, { dataDir: dir, snapshotDebounceMs: 10, log: () => {}, rateLimitPerSec: 100000, ...over });
async function boot(over: Partial<ServerConfig> = {}) {
  const config = cfg(over);
  const store = await SceneStore.open(config);
  open.push(store);
  const app = createApp(store, config);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { store, call };
}
const shutdown = async (s: SceneStore) => {
  await s.close();
  open = open.filter((o) => o !== s);
};

let n = 0;
const env = (cmd: Command) => makeEnvelope(cmd, { id: `c-${++n}`, ts: 1000 + n, author: { kind: 'user', name: 't' } });
const north = (deg: number): LeafCommand => ({ type: 'site.set', site: { northAngle: deg } });
const scene = (s: SceneStore) => serializeScene(s.scene);
const post = async (b: Awaited<ReturnType<typeof boot>>, deg: number) => expect((await b.call('POST', '/api/commands', env(north(deg)))).status).toBe(200);

describe('checkpoints', () => {
  it('creates, lists, conflicts, replaces and survives a restart', async () => {
    const b = await boot();
    await post(b, 11);
    const res = await b.call('POST', '/api/checkpoints', { name: 'a' });
    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created.checkpoint).toMatchObject({ name: 'a', rev: 1, seq: 1, depth: 1, author: { kind: 'user', name: 'server' } });
    expect(created.checkpoint.topId).toBeUndefined();

    const dup = await b.call('POST', '/api/checkpoints', { name: 'a' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).errors[0].code).toBe('checkpoint_exists');
    expect((await b.call('POST', '/api/checkpoints', { name: '' })).status).toBe(422);

    await post(b, 12);
    expect((await b.call('POST', '/api/checkpoints', { name: 'a', replace: true, author: { kind: 'llm', name: 'claude' } })).status).toBe(200);
    const list = await (await b.call('GET', '/api/checkpoints')).json();
    expect(list).toMatchObject({ rev: 2, checkpoints: [{ name: 'a', rev: 2, depth: 2, author: { kind: 'llm' } }] });

    await shutdown(b.store);
    const again = await boot();
    const after = await (await again.call('GET', '/api/checkpoints')).json();
    expect(after.checkpoints).toEqual(list.checkpoints);
    expect(after.epoch).toBe(list.epoch);
  });

  it('evicts the oldest beyond the cap', async () => {
    const b = await boot();
    for (let i = 0; i < MAX_CHECKPOINTS + 2; i++) expect((await b.call('POST', '/api/checkpoints', { name: `cp${i}` })).status).toBe(200);
    const names = (await (await b.call('GET', '/api/checkpoints')).json()).checkpoints.map((c: { name: string }) => c.name);
    expect(names).toHaveLength(MAX_CHECKPOINTS);
    expect(names[0]).toBe('cp2');
  });

  it('an import resets them', async () => {
    const b = await boot();
    await b.call('POST', '/api/checkpoints', { name: 'a' });
    const sceneText = serializeScene(b.store.scene);
    expect((await b.call('PUT', '/api/scene', sceneText)).status).toBe(200);
    expect((await (await b.call('GET', '/api/checkpoints')).json()).checkpoints).toEqual([]);
    expect((await b.call('POST', '/api/undo-to', { checkpoint: 'a' })).status).toBe(404);
    await shutdown(b.store);
    const again = await boot();
    expect(again.store.checkpoints).toEqual([]);
  });
});

describe('undo-to', () => {
  it('returns to the exact checkpoint scene, keeps everything in history/log, is idempotent and redoable', async () => {
    const b = await boot();
    await post(b, 5);
    await b.call('POST', '/api/checkpoints', { name: 'cp' });
    const atCp = scene(b.store);
    await post(b, 6);
    await post(b, 7);
    await post(b, 8);
    const afterEdits = scene(b.store);
    expect(b.store.rev).toBe(4);

    const res = await b.call('POST', '/api/undo-to', { checkpoint: 'cp', id: 'ut-1', author: { kind: 'llm', name: 'claude' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, steps: 3, rev: 7, seq: 7 });
    expect(scene(b.store)).toBe(atCp);
    expect(b.store.history.past).toHaveLength(1);
    expect(b.store.history.future).toHaveLength(3);

    const log = await (await b.call('GET', '/api/log?since=0')).json();
    expect(log.entries).toHaveLength(7);
    expect(log.entries.slice(4).every((e: { undoOf?: string }) => e.undoOf)).toBe(true);

    const retry = await b.call('POST', '/api/undo-to', { checkpoint: 'cp', id: 'ut-1' });
    expect(await retry.json()).toEqual(body);
    expect(b.store.rev).toBe(7);

    // the same checkpoint again with a new id: already there -> noop success
    const noop = await (await b.call('POST', '/api/undo-to', { checkpoint: 'cp' })).json();
    expect(noop).toMatchObject({ steps: 0, rev: 7, result: { noop: true } });

    for (let i = 0; i < 3; i++) expect((await b.call('POST', '/api/redo')).status).toBe(200);
    expect(scene(b.store)).toBe(afterEdits);

    // the retry id survives a restart
    await shutdown(b.store);
    const again = await boot();
    expect(await (await again.call('POST', '/api/undo-to', { checkpoint: 'cp', id: 'ut-1' })).json()).toEqual(body);
  });

  it('409 when undone past the checkpoint, 409 when the history diverged, 404 for unknown', async () => {
    const b = await boot();
    await post(b, 1);
    await post(b, 2);
    await b.call('POST', '/api/checkpoints', { name: 'deep' }); // depth 2
    await b.call('POST', '/api/undo');
    await b.call('POST', '/api/undo'); // depth 0
    const r = await b.call('POST', '/api/undo-to', { checkpoint: 'deep' });
    expect(r.status).toBe(409);
    expect((await r.json()).errors[0].code).toBe('checkpoint_unreachable');
    expect(b.store.rev).toBe(4);

    await post(b, 3);
    await post(b, 4); // depth 2 again but different entries
    const d = await b.call('POST', '/api/undo-to', { checkpoint: 'deep' });
    expect(d.status).toBe(409);
    expect((await d.json()).errors[0].message).toMatch(/diverged/);

    expect((await b.call('POST', '/api/undo-to', { checkpoint: 'nope' })).status).toBe(404);
    expect((await b.call('POST', '/api/undo-to', {})).status).toBe(422);
  });

  it('a depth-0 checkpoint that fell out of the capped history is checkpoint_unreachable; one taken later still works', async () => {
    const b = await boot();
    await b.call('POST', '/api/checkpoints', { name: 'origin' }); // depth 0, absolute index 0
    for (let i = 0; i < HISTORY_CAP; i++) await post(b, 10 + i);
    expect(b.store.history.past).toHaveLength(HISTORY_CAP); // exactly at the cap: nothing trimmed yet, origin is still reachable

    await post(b, 999); // the 201st change drops the oldest entry
    expect(b.store.history.past).toHaveLength(HISTORY_CAP);
    const before = scene(b.store);
    const gone = await b.call('POST', '/api/undo-to', { checkpoint: 'origin' });
    expect(gone.status).toBe(409);
    const err = (await gone.json()).errors[0];
    expect(err.code).toBe('checkpoint_unreachable');
    expect(err.message).toMatch(/capped history/);
    expect(scene(b.store)).toBe(before); // nothing was undone

    // a checkpoint taken now has an absolute index past the trimmed entries and works
    await b.call('POST', '/api/checkpoints', { name: 'late' });
    const atCp = scene(b.store);
    await post(b, 500);
    await post(b, 501);
    const ok = await b.call('POST', '/api/undo-to', { checkpoint: 'late' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).steps).toBe(2);
    expect(scene(b.store)).toBe(atCp);

    // the absolute index and the trimmed count survive a restart
    await shutdown(b.store);
    const again = await boot();
    expect((await again.call('POST', '/api/undo-to', { checkpoint: 'origin' })).status).toBe(409);
    expect((await again.call('POST', '/api/undo-to', { checkpoint: 'late' })).status).toBe(200); // already there: noop
  }, 60_000);

  it('taking a checkpoint closes the coalescing window: later edits with the same key do not merge into the entry under the checkpoint', async () => {
    const b = await boot();
    const drag = (deg: number) => makeEnvelope(north(deg), { id: `d-${++n}`, ts: 5000 + n, author: { kind: 'user', name: 't' }, coalesceKey: 'drag' });
    expect((await b.call('POST', '/api/commands', drag(10))).status).toBe(200);
    await b.call('POST', '/api/checkpoints', { name: 'mid' });
    const atCp = scene(b.store);
    expect((await b.call('POST', '/api/commands', drag(20))).status).toBe(200); // within the 1 s window and same key
    expect(b.store.history.past).toHaveLength(2); // not merged
    const r = await b.call('POST', '/api/undo-to', { checkpoint: 'mid' });
    expect(r.status).toBe(200);
    expect(scene(b.store)).toBe(atCp);
    expect(b.store.scene.site.northAngle).toBe(10);
  });

  it('without a checkpoint in between the same two edits do coalesce (the control)', async () => {
    const b = await boot();
    const drag = (deg: number) => makeEnvelope(north(deg), { id: `d-${++n}`, ts: 7000 + n, author: { kind: 'user', name: 't' }, coalesceKey: 'drag' });
    await b.call('POST', '/api/commands', drag(10));
    await b.call('POST', '/api/commands', drag(20));
    expect(b.store.history.past).toHaveLength(1);
  });

  it('stale ifRev -> precondition_failed and nothing changes', async () => {
    const b = await boot();
    await b.call('POST', '/api/checkpoints', { name: 'z' });
    await post(b, 9);
    const r = await b.call('POST', '/api/undo-to', { checkpoint: 'z', ifRev: 0 });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ errors: [{ code: 'precondition_failed' }], rev: 1 });
    expect(b.store.rev).toBe(1);
    expect((await b.call('POST', '/api/undo-to', { checkpoint: 'z', ifRev: 1 })).status).toBe(200);
  });
});

describe('view relay and auth', () => {
  async function live(over: Partial<ServerConfig> = {}) {
    const running = await startServer(cfg({ port: 0, ...over }));
    open.push(running.store);
    return running;
  }
  const connect = (url: string, client?: string) =>
    new Promise<{ ws: WebSocket; msgs: ServerMsg[]; waitFor: (n: number) => Promise<void> }>((resolve, reject) => {
      const ws = new WebSocket(url.replace('http', 'ws') + '/ws' + (client ? `?client=${client}` : ''));
      const msgs: ServerMsg[] = [];
      const waiters: Array<() => void> = [];
      ws.on('message', (d) => {
        msgs.push(JSON.parse(d.toString()));
        waiters.splice(0).forEach((w) => w());
      });
      const waitFor = async (k: number) => {
        while (msgs.length < k) await new Promise<void>((r) => waiters.push(r));
      };
      ws.once('open', () => resolve({ ws, msgs, waitFor }));
      ws.once('error', reject);
    });
  const pose = { mode: 'top', center: [1, 2], halfHeight: 5 };
  const json = { 'content-type': 'application/json' };

  it('relays to everyone but the sender, without touching history or rev', async () => {
    const s = await live();
    const a = await connect(s.url, 'tab-a');
    const c = await connect(s.url, 'tab-b');
    await a.waitFor(1);
    await c.waitFor(1);
    const res = await fetch(`${s.url}/api/view`, { method: 'POST', headers: { ...json, 'x-flat-client': 'tab-a' }, body: JSON.stringify({ pose, from: 'mcp' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: 1 });
    await c.waitFor(2);
    expect(c.msgs[1]).toMatchObject({ type: 'view', seq: 1, from: 'mcp', pose: { mode: 'top' } });
    const all = await (await fetch(`${s.url}/api/view`, { method: 'POST', headers: json, body: JSON.stringify({ lighting: { time: '20:00' } }) })).json();
    expect(all.delivered).toBe(2);
    await a.waitFor(2);
    expect(a.msgs[1]).toMatchObject({ type: 'view', seq: 2, lighting: { time: '20:00' } });
    // Only the sent keys are relayed: no defaults (lamps, sunEnabled, exposureEV...) leak in.
    expect(Object.keys((a.msgs[1] as { lighting: object }).lighting)).toEqual(['time']);
    expect(a.msgs.filter((m) => m.type === 'view')).toHaveLength(1);

    expect(s.store.rev).toBe(0);
    expect(s.store.history.past).toHaveLength(0);
    expect((await (await fetch(`${s.url}/api/log?since=0`)).json()).entries).toEqual([]);
    expect((await fetch(`${s.url}/api/view`, { method: 'POST', headers: json, body: JSON.stringify({ from: 'x' }) })).status).toBe(422);
    a.ws.close();
    c.ws.close();
    await s.close();
    open = [];
  });

  it('rate limits views (10/s by default)', async () => {
    const b = await boot();
    const codes: number[] = [];
    for (let i = 0; i < 15; i++) codes.push((await b.call('POST', '/api/view', { pose })).status);
    expect(codes.filter((x) => x === 429).length).toBeGreaterThanOrEqual(1);
    expect(codes.slice(0, 10).every((x) => x === 200)).toBe(true);
  });

  it('enforces token and Origin on every new write route', async () => {
    const b = await boot({ token: 'secret' });
    const routes: Array<[string, unknown]> = [
      ['/api/checkpoints', { name: 'a' }],
      ['/api/undo-to', { checkpoint: 'a' }],
      ['/api/view', { pose }],
    ];
    for (const [path, body] of routes) {
      expect((await b.call('POST', path, body)).status).toBe(401);
      expect((await b.call('POST', path, body, { authorization: 'Bearer wrong' })).status).toBe(401);
      expect((await b.call('POST', path, body, { authorization: 'Bearer secret', origin: 'https://evil.example' })).status).toBe(403);
    }
    expect((await b.call('POST', '/api/checkpoints', { name: 'a' }, { authorization: 'Bearer secret' })).status).toBe(200);
    expect((await b.call('GET', '/api/checkpoints')).status).toBe(200);
    const open2 = await boot({ dataDir: join(dir, 'x') });
    for (const [path, body] of routes) {
      expect((await open2.call('POST', path, body, { origin: 'https://evil.example' })).status).toBe(403);
    }
  });
});
