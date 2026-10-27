import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnvelope, serializeScene, type Command, type LogEntry } from '@flat/scene';
import { createApp } from './app';
import { loadConfig } from './config';
import { SceneStore } from './store';

let dir: string;
let open: SceneStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flat-undoguard-'));
});
afterEach(async () => {
  for (const s of open) await s.close().catch(() => {});
  open = [];
  await rm(dir, { recursive: true, force: true });
});

async function boot() {
  const config = loadConfig({}, { dataDir: dir, snapshotDebounceMs: 10, log: () => {}, rateLimitPerSec: 100000 });
  const store = await SceneStore.open(config);
  open.push(store);
  const app = createApp(store, config);
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { store, call };
}
const shutdown = async (s: SceneStore) => {
  await s.close();
  open = open.filter((o) => o !== s);
};

let n = 0;
const user = { kind: 'user' as const, name: 'u' };
const llm = { kind: 'llm' as const, name: 'claude' };
const env = (cmd: Command) => makeEnvelope(cmd, { id: `u-${++n}`, ts: 1000 + n, author: user });
const north = (deg: number): Command => ({ type: 'site.set', site: { northAngle: deg } });
const moveLocked = (x: number): Command => ({ type: 'item.move', id: 'placard-ch1', position: [x, 4.12] }); // a locked item of the Charme scene with room to slide (the placard of Chambre 2 fills its niche exactly)

describe('undo-to is all-or-nothing', () => {
  it('an LLM undo-to that would pass a locked item changes nothing; the user can do it', async () => {
    const b = await boot();
    expect((await b.call('POST', '/api/checkpoints', { name: 'start' })).status).toBe(200);
    for (const c of [north(11), moveLocked(8.8), north(12)]) { const r = await b.call("POST", "/api/commands", env(c)); if (r.status !== 200) throw new Error(JSON.stringify(await r.json())); }
    const before = { rev: b.store.rev, seq: b.store.seq, scene: serializeScene(b.store.scene), past: b.store.history.past.length, log: await readFile(join(dir, 'log.ndjson'), 'utf8') };

    const refused = await b.call('POST', '/api/undo-to', { checkpoint: 'start', author: llm });
    expect(refused.status).toBe(422);
    const body = (await refused.json()) as { errors: { code: string; message: string }[] };
    expect(body.errors[0]).toMatchObject({ code: 'precondition_failed' });
    expect(body.errors[0]!.message).toMatch(/step 2 of 3.*nothing was undone/);
    // nothing moved: state, history and log are exactly as before (step 1, the unlocked north, was NOT undone)
    expect({ rev: b.store.rev, seq: b.store.seq, scene: serializeScene(b.store.scene), past: b.store.history.past.length, log: await readFile(join(dir, 'log.ndjson'), 'utf8') }).toEqual(before);

    const ok = await b.call('POST', '/api/undo-to', { checkpoint: 'start', author: user });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { steps: number }).steps).toBe(3);
    expect(b.store.history.past).toHaveLength(0);
  });

  it('an LLM undo-to over unlocked changes still works', async () => {
    const b = await boot();
    await b.call('POST', '/api/checkpoints', { name: 'start' });
    for (const c of [north(11), north(12)]) await b.call('POST', '/api/commands', env(c));
    const r = await b.call('POST', '/api/undo-to', { checkpoint: 'start', author: llm });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { steps: number }).steps).toBe(2);
  });
});

describe('log replay is trusted history', () => {
  it('an old entry where an LLM undid a locked item replays instead of stopping the recovery', async () => {
    const b = await boot();
    await b.call('POST', '/api/commands', env(moveLocked(8.8)));
    expect((await b.call('POST', '/api/undo', { author: user })).status).toBe(200);
    await b.call('POST', '/api/commands', env(north(15)));
    const live = { rev: b.store.rev, scene: serializeScene(b.store.scene), epoch: b.store.epoch };
    await shutdown(b.store);

    // Rewrite history as an older server could have written it: the undo of the locked move was made by an LLM.
    const file = join(dir, 'log.ndjson');
    const entries = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEntry);
    const undoEntry = entries.find((e) => e.undoOf !== undefined)!;
    undoEntry.envelope = { ...undoEntry.envelope, author: llm };
    await writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    await writeFile(join(dir, 'state.json'), '{"format":1,"epoch":'); // corrupt snapshot: recover from state.json.prev + the log

    const again = await boot();
    expect(again.store.rev).toBe(live.rev);
    expect(again.store.epoch).toBe(live.epoch);
    expect(serializeScene(again.store.scene)).toBe(live.scene);
    expect((await readdir(dir)).filter((f) => f.includes('leftover') || f.includes('unreplayed'))).toEqual([]);
    
  });
});
