import { chmod, mkdir, mkdtemp, open as openFile, readdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { makeEnvelope, serializeScene, type Command, type LeafCommand, type LogEntry } from '@flat/scene';
import { createApp, hostAllowed } from './app';
import { loadConfig, type ServerConfig } from './config';
import { startServer } from './server';
import { SceneStore } from './store';

let dir: string;
let open: SceneStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flat-dur-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open) await s.close().catch(() => {});
  open = [];
  await chmod(join(dir, 'state.json'), 0o600).catch(() => {});
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
const shutdown = async (s: SceneStore) => {
  await s.close();
  open = open.filter((o) => o !== s);
};

let n = 0;
const env = (cmd: Command, extra: Record<string, unknown> = {}) => ({
  ...makeEnvelope(cmd, { id: `d-${++n}`, ts: 1000 + n, author: { kind: 'user', name: 't' } }),
  ...extra,
});
const north = (deg: number): LeafCommand => ({ type: 'site.set', site: { northAngle: deg } });
const logPath = () => join(dir, 'log.ndjson');
const readLogEntries = async () =>
  (await readFile(logPath(), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEntry);

async function seeded(count = 5) {
  const b = await boot();
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const e = env(north(i * 3));
    ids.push(e.id);
    await b.call('POST', '/api/commands', e);
  }
  const live = { rev: b.store.rev, epoch: b.store.epoch, scene: serializeScene(b.store.scene) };
  await shutdown(b.store);
  return { live, ids };
}

describe('S1: corrupt snapshot never wipes data', () => {
  it('recovers from state.json.prev + log replay and quarantines the bad file', async () => {
    const { live } = await seeded();
    await writeFile(join(dir, 'state.json'), '{"format":1,"epoch":'); // truncated
    const b = await boot();
    expect(b.store.rev).toBe(live.rev);
    expect(b.store.epoch).toBe(live.epoch);
    expect(serializeScene(b.store.scene)).toBe(live.scene);
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
    expect((await readLogEntries()).length).toBe(5);
  });

  it('refuses to start when nothing is recoverable, leaving every file in place', async () => {
    await seeded();
    await rm(join(dir, 'state.json.prev'), { force: true });
    await writeFile(join(dir, 'state.json'), 'garbage');
    const before = await readFile(logPath(), 'utf8');
    await expect(boot()).rejects.toThrow(/state\.json/);
    expect(await readFile(logPath(), 'utf8')).toBe(before);
    expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe('garbage');
  });

  it('refuses on a schema-invalid snapshot too', async () => {
    await seeded();
    await rm(join(dir, 'state.json.prev'), { force: true });
    await writeFile(join(dir, 'state.json'), JSON.stringify({ format: 1, epoch: 'x' }));
    await expect(boot()).rejects.toThrow();
    expect((await readLogEntries()).length).toBe(5);
  });

  it.skipIf(process.getuid?.() === 0)('refuses on EACCES instead of reinitialising', async () => {
    await seeded();
    const before = await readFile(logPath(), 'utf8');
    await chmod(join(dir, 'state.json'), 0o000);
    await expect(boot()).rejects.toThrow();
    expect(await readFile(logPath(), 'utf8')).toBe(before);
  });

  it('refuses when state.json is missing but a log exists and there is no prev', async () => {
    await seeded();
    await rm(join(dir, 'state.json'));
    await rm(join(dir, 'state.json.prev'), { force: true });
    await expect(boot()).rejects.toThrow(/log/);
    expect((await readLogEntries()).length).toBe(5);
  });

  it('recovers across a compaction using the archived log', async () => {
    const b = await boot({ compactAfter: 10 });
    for (let i = 1; i <= 25; i++) await b.call('POST', '/api/commands', env(north(i)));
    const expected = serializeScene(b.store.scene);
    await shutdown(b.store);
    await writeFile(join(dir, 'state.json'), 'junk');
    const again = await boot({ compactAfter: 10 });
    expect(again.store.rev).toBe(25);
    expect(serializeScene(again.store.scene)).toBe(expected);
  });
});

describe('log corruption', () => {
  it('a corrupt line in the middle stops the boot and preserves the file', async () => {
    const { live } = await seeded();
    const lines = (await readFile(logPath(), 'utf8')).split('\n').filter(Boolean);
    lines[2] = '{"this is":"not a log entry"';
    const text = lines.join('\n') + '\n';
    await writeFile(logPath(), text);
    // stale snapshot so replay has to read the whole log
    const snap = JSON.parse(await readFile(join(dir, 'state.json.prev'), 'utf8'));
    await writeFile(join(dir, 'state.json'), JSON.stringify(snap));
    expect(snap.rev).toBeLessThan(live.rev);
    await expect(boot()).rejects.toThrow(/line 3/);
    expect(await readFile(logPath(), 'utf8')).toBe(text);
  });

  it('a stopped replay keeps the unreplayed entries in an archive file', async () => {
    await seeded(3);
    const entries = await readLogEntries();
    const last = entries.at(-1)!;
    const bad = { ...last, seq: 4, rev: 4, envelope: { ...env({ type: 'room.setFloor', roomId: 'nope', materialId: null }) } };
    const good = { ...last, seq: 5, rev: 5, envelope: env(north(55)) };
    await appendFile(logPath(), `${JSON.stringify(bad)}\n${JSON.stringify(good)}\n`);
    const snap = JSON.parse(await readFile(join(dir, 'state.json.prev'), 'utf8'));
    await writeFile(join(dir, 'state.json'), JSON.stringify(snap));
    const b = await boot();
    expect(b.store.rev).toBe(3);
    const files = await readdir(dir);
    const dropped = files.find((f) => f.startsWith('log.ndjson.dropped-'));
    expect(dropped).toBeDefined();
    expect((await readFile(join(dir, dropped!), 'utf8')).split('\n').filter(Boolean)).toHaveLength(2);
  });
});

describe('S2: durability', () => {
  it('fsyncs the log before acknowledging and fsyncs atomic writes + directory', async () => {
    const probe = await openFile(join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { datasync(): Promise<void>; sync(): Promise<void> };
    await probe.close();
    const datasync = vi.spyOn(proto, 'datasync');
    const sync = vi.spyOn(proto, 'sync');
    const b = await boot();
    const syncBefore = datasync.mock.calls.length + sync.mock.calls.length;
    expect(syncBefore).toBeGreaterThan(0); // initial snapshot
    datasync.mockClear();
    const r = await b.call('POST', '/api/commands', env(north(9)));
    expect(r.status).toBe(200);
    expect(datasync.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('100 concurrent POSTs stay fast', async () => {
    const b = await boot();
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => b.call('POST', '/api/commands', env(north(i + 1)))));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('S3/S4: idempotency', () => {
  it('survives compaction plus restart', async () => {
    const b = await boot({ compactAfter: 5 });
    const first = env(north(1));
    const r1 = await (await b.call('POST', '/api/commands', first)).json();
    for (let i = 2; i <= 12; i++) await b.call('POST', '/api/commands', env(north(i)));
    const rev = b.store.rev;
    await shutdown(b.store);
    const again = await boot({ compactAfter: 5 });
    const dup = await again.call('POST', '/api/commands', first);
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual(r1);
    expect(again.store.rev).toBe(rev);
  });

  it('same id with a different body -> 409 idempotency_conflict; ts differences are ignored', async () => {
    const b = await boot();
    const e = env(north(10));
    expect((await b.call('POST', '/api/commands', e)).status).toBe(200);
    const retime = await b.call('POST', '/api/commands', { ...e, ts: e.ts + 999 });
    expect(retime.status).toBe(200);
    const clash = await b.call('POST', '/api/commands', { ...e, cmd: north(11) });
    expect(clash.status).toBe(409);
    expect((await clash.json()).errors[0].code).toBe('idempotency_conflict');
    expect(b.store.rev).toBe(1);
  });

  it('conflict detection also works after a restart', async () => {
    const b = await boot();
    const e = env(north(10));
    await b.call('POST', '/api/commands', e);
    await shutdown(b.store);
    const again = await boot();
    expect((await again.call('POST', '/api/commands', { ...e, cmd: north(11) })).status).toBe(409);
    expect((await again.call('POST', '/api/commands', e)).status).toBe(200);
  });

  it('undo/redo ids are namespaced from command ids and idempotent on retry', async () => {
    const b = await boot();
    const e = env(north(10));
    const posted = await (await b.call('POST', '/api/commands', e)).json();
    const undone = await (await b.call('POST', '/api/undo', { id: e.id })).json();
    expect(undone.ok).toBe(true);
    expect(undone.seq).toBe(2);
    expect(undone.seq).not.toBe(posted.seq);
    const retry = await (await b.call('POST', '/api/undo', { id: e.id })).json();
    expect(retry).toEqual(undone);
    expect(b.store.rev).toBe(2);
    const command = await (await b.call('POST', '/api/commands', e)).json();
    expect(command).toEqual(posted);
    await shutdown(b.store);
    const again = await boot();
    expect(await (await again.call('POST', '/api/undo', { id: e.id })).json()).toEqual(undone);
    expect(again.store.rev).toBe(2);
  });
});

describe('S5: replay', () => {
  it('does not remember responses for log entries that were never applied', async () => {
    await seeded(2);
    const last = (await readLogEntries()).at(-1)!;
    const badEnv = env({ type: 'room.setFloor', roomId: 'nope', materialId: null });
    await appendFile(logPath(), `${JSON.stringify({ ...last, seq: 3, rev: 3, envelope: badEnv })}\n`);
    const snap = JSON.parse(await readFile(join(dir, 'state.json.prev'), 'utf8'));
    await writeFile(join(dir, 'state.json'), JSON.stringify(snap));
    const b = await boot();
    expect(b.store.rev).toBe(2);
    const r = await b.call('POST', '/api/commands', badEnv);
    expect(r.status).toBe(422);
  });
});

describe('S6: import ordering', () => {
  it('a failed snapshot write leaves memory untouched', async () => {
    const b = await boot();
    await b.call('POST', '/api/commands', env(north(5)));
    await mkdir(join(dir, `state.json.${process.pid}.tmp`)); // makes the atomic write fail
    const epoch = b.store.epoch;
    const rev = b.store.rev;
    const sample = await readFile(new URL('../../../packages/scene/fixtures/sample.flat.json', import.meta.url), 'utf8');
    const res = await b.call('PUT', '/api/scene', sample);
    expect(res.status).toBe(500);
    expect(b.store.epoch).toBe(epoch);
    expect(b.store.rev).toBe(rev);
  });
});

describe('hosts', () => {
  it('hostAllowed honours an explicit allow-list', () => {
    expect(hostAllowed('192.168.1.5:8787')).toBe(false);
    expect(hostAllowed('192.168.1.5:8787', ['192.168.1.5'])).toBe(true);
    expect(hostAllowed('FLAT.local', ['flat.local'])).toBe(true);
    expect(hostAllowed('evil.example', ['flat.local'])).toBe(false);
    expect(hostAllowed('localhost:1', ['flat.local'])).toBe(true);
  });
  it('ALLOWED_HOSTS is parsed and applied by the app', async () => {
    expect(loadConfig({ ALLOWED_HOSTS: 'a.lan, 10.0.0.2' }).allowedHosts).toEqual(['a.lan', '10.0.0.2']);
    expect(loadConfig({}).allowedHosts).toEqual([]);
    const b = await boot({ allowedHosts: ['10.0.0.2'] });
    expect((await b.call('GET', '/api/scene', undefined, { host: '10.0.0.2:8787' })).status).toBe(200);
    expect((await b.call('GET', '/api/scene', undefined, { host: '10.0.0.3:8787' })).status).toBe(403);
  });
});

describe('single-instance lock', () => {
  it('refuses a second live instance and reclaims a stale lock', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'server.lock'), JSON.stringify({ pid: process.ppid }));
    await expect(boot()).rejects.toThrow(/already (running|in use)/);
    await writeFile(join(dir, 'server.lock'), JSON.stringify({ pid: 2 ** 22 - 3 }));
    const b = await boot();
    expect(JSON.parse(await readFile(join(dir, 'server.lock'), 'utf8')).pid).toBe(process.pid);
    await shutdown(b.store);
    await expect(readFile(join(dir, 'server.lock'), 'utf8')).rejects.toThrow();
  });
});

describe('WebSocket extras', () => {
  const live = async (over: Partial<ServerConfig> = {}) => {
    const running = await startServer(cfg({ port: 0, ...over }));
    open.push(running.store);
    return running;
  };

  it('terminates sockets that miss a pong', async () => {
    const s = await live({ wsHeartbeatMs: 40 });
    const ws = new WebSocket(s.url.replace('http', 'ws') + '/ws', { autoPong: false });
    await new Promise((r) => ws.once('open', r));
    const closed = new Promise<void>((r) => ws.once('close', () => r()));
    await closed;
    await s.close();
    open = [];
  });

  it('keeps sockets that answer pings', async () => {
    const s = await live({ wsHeartbeatMs: 40 });
    const ws = new WebSocket(s.url.replace('http', 'ws') + '/ws');
    await new Promise((r) => ws.once('open', r));
    await new Promise((r) => setTimeout(r, 250));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await s.close();
    open = [];
  });

  it('serialises a broadcast once, not once per client', async () => {
    const s = await live();
    const sockets = await Promise.all(
      [1, 2, 3].map(async () => {
        const ws = new WebSocket(s.url.replace('http', 'ws') + '/ws');
        await new Promise((r) => ws.once('open', r));
        return ws;
      }),
    );
    const spy = vi.spyOn(JSON, 'stringify');
    const got = Promise.all(sockets.map((ws) => new Promise<void>((r) => ws.on('message', (d) => JSON.parse(d.toString()).type === 'applied' && r()))));
    await fetch(`${s.url}/api/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env(north(3))) });
    await got;
    const applied = spy.mock.calls.filter(([v]) => (v as { type?: string } | undefined)?.type === 'applied');
    expect(applied).toHaveLength(1);
    sockets.forEach((w) => w.close());
    await s.close();
    open = [];
  });
});
