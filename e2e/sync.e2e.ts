/**
 * Live sync (M3.12) against a real `apps/server` on a random port with a temporary DATA_DIR:
 * two tabs follow each other, undo is shared, an LLM-style batch is one history entry, the app keeps
 * working while the server is down and reconciles after a restart, an epoch change asks the user, and
 * foreign origins are refused. Pages mode (no `?server=`) is covered by the other specs.
 *
 * Screenshots (always written): /tmp/sync-tabA.png, /tmp/sync-tabB.png (after tab A painted).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import type { Scene } from '../packages/scene/src/index';
import { sampleFlat } from './helpers';

const WEB_ORIGIN = 'http://127.0.0.1:5173';
const SERVER_CWD = join(process.cwd(), 'apps', 'server'); // playwright runs from the repo root
const SAGE = 'paint-a3ae93-matt';
const PAINT_SEJOUR = {
  type: 'batch',
  label: 'paint sejour',
  commands: [
    { type: 'material.define', material: { id: SAGE, name: 'Sage', kind: 'paint', color: '#a3ae93', roughness: 0.9 } },
    { type: 'room.setWallFinish', roomId: 'sejour', materialId: SAGE },
  ],
};

interface RunningServer {
  url: string;
  port: number;
  dataDir: string;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** Starts `apps/server` (tsx) with its own DATA_DIR; `stop()` terminates it and waits. */
async function startServer(opts: { port?: number; dataDir?: string; origins?: string } = {}): Promise<RunningServer> {
  const port = opts.port ?? (await freePort());
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'flat-sync-'));
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: SERVER_CWD,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ALLOWED_ORIGINS: opts.origins ?? WEB_ORIGIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout!.on('data', (d: Buffer) => (log += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (log += d.toString()));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    port,
    dataDir,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(killer);
      }
    },
  };
}

// Each test boots a server and two or three software-WebGL tabs: give them room on slow machines.
test.setTimeout(90_000);

const servers: RunningServer[] = [];
const dirs: string[] = [];
async function server(opts: Parameters<typeof startServer>[0] = {}): Promise<RunningServer> {
  const s = await startServer(opts);
  servers.push(s);
  if (!opts.dataDir) dirs.push(s.dataDir);
  return s;
}
test.afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const syncStatus = (page: Page) => page.getByTestId('sync-status');
const getScene = (page: Page): Promise<Scene> => page.evaluate(() => window.__flat!.getScene());
const connection = (page: Page) => page.evaluate(() => window.__flat!.connection());
const history = (page: Page) => page.evaluate(() => window.__flat!.history());
const isPainted = (scene: Scene) => scene.rooms.find((r) => r.id === 'sejour')!.wallFinish === SAGE;
const sejourFloor = (scene: Scene) => scene.rooms.find((r) => r.id === 'sejour')!.floorMaterial ?? null;

/** A page in its own browser context (separate storage, like a second browser tab/window). */
async function openTab(browser: Browser, query: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: WEB_ORIGIN, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/?${query}`);
  await page.evaluate(() => window.__flat!.ready);
  return page;
}

async function openSynced(browser: Browser, s: RunningServer): Promise<Page> {
  const page = await openTab(browser, `server=${encodeURIComponent(s.url)}`);
  await expect.poll(async () => (await connection(page)).status, { timeout: 15_000 }).toBe('connected');
  return page;
}

test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((c) => c.close()));
});

test('without ?server the app stays local', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.__flat!.ready);
  expect(await connection(page)).toMatchObject({ mode: 'local', status: 'local', pending: 0 });
  await expect(syncStatus(page)).toHaveText('Local');
});

test('an edit in tab A reaches tab B within a second, and undo in B reaches A', async ({ browser }) => {
  const s = await server();
  const a = await openSynced(browser, s);
  const b = await openSynced(browser, s);
  await expect(syncStatus(a)).toContainText('Connected · rev 0');
  expect(isPainted(await getScene(b))).toBe(false);
  const cameraB = await b.evaluate(() => window.__flat!.stats().camera);

  expect((await a.evaluate((c) => window.__flat!.applyCommand(c), PAINT_SEJOUR)).ok).toBe(true);
  expect(isPainted(await getScene(a))).toBe(true);
  await expect.poll(async () => isPainted(await getScene(b)), { timeout: 1000 }).toBe(true);
  await expect(syncStatus(b)).toContainText('Connected · rev 1');
  await expect.poll(async () => (await connection(a)).pending).toBe(0);
  // The remote edit never re-frames the camera.
  await b.evaluate(() => window.__flat!.whenRendered());
  expect((await b.evaluate(() => window.__flat!.stats().camera))).toEqual(cameraB);

  await a.screenshot({ path: '/tmp/sync-tabA.png' });
  await b.screenshot({ path: '/tmp/sync-tabB.png' });

  // One shared history: B can undo what A did.
  await expect.poll(async () => (await history(b)).canUndo).toBe(true);
  expect(await b.evaluate(() => window.__flat!.undo())).toMatchObject({ ok: true });
  await expect.poll(async () => isPainted(await getScene(a)), { timeout: 1000 }).toBe(false);
  expect(isPainted(await getScene(b))).toBe(false);
  await expect.poll(async () => (await history(a)).canRedo).toBe(true);

  // ...and A can redo it.
  expect(await a.evaluate(() => window.__flat!.redo())).toMatchObject({ ok: true });
  await expect.poll(async () => isPainted(await getScene(b)), { timeout: 1000 }).toBe(true);
});

test('an LLM batch posted over HTTP is one history entry in both tabs', async ({ browser, request }) => {
  const s = await server();
  const a = await openSynced(browser, s);
  const b = await openSynced(browser, s);
  const res = await request.post(`${s.url}/api/commands`, {
    data: {
      v: 1,
      id: 'llm-batch-1',
      ts: 1,
      author: { kind: 'llm', name: 'claude' },
      cmd: {
        type: 'batch',
        label: 'warm living room',
        commands: [
          { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' },
          { type: 'site.set', site: { northAngle: 33 } },
        ],
      },
    },
  });
  expect(res.status()).toBe(200);
  for (const page of [a, b]) {
    await expect.poll(async () => sejourFloor(await getScene(page)), { timeout: 2000 }).toBe('floor-oak');
    await expect.poll(async () => (await history(page)).entries.length).toBe(1);
    const h = await history(page);
    expect(h.labels).toEqual(['warm living room']);
    expect(h.entries[0]).toMatchObject({ id: 'llm-batch-1', author: 'llm' });
    expect((await getScene(page)).site.northAngle).toBe(33);
  }
});

test('while the server is down edits still apply locally; after a restart they are reconciled', async ({ browser, request }) => {
  const s = await server();
  const a = await openSynced(browser, s);
  const b = await openSynced(browser, s);
  await a.evaluate((c) => window.__flat!.applyCommand(c), { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' });
  await expect.poll(async () => sejourFloor(await getScene(b))).toBe('floor-oak');

  await s.stop();
  await expect(syncStatus(a)).toHaveText('Reconnecting…', { timeout: 10_000 });
  expect((await connection(a)).status).toBe('reconnecting');

  // Offline edits apply locally and wait in the pending queue.
  const edit = await a.evaluate((c) => window.__flat!.applyCommand(c), { type: 'room.setCeiling', roomId: 'sejour', materialId: 'paint-white' });
  expect(edit.ok).toBe(true);
  expect((await getScene(a)).rooms.find((r) => r.id === 'sejour')!.ceilingMaterial).toBe('paint-white');
  await a.evaluate((c) => window.__flat!.applyCommand(c), { type: 'site.set', site: { northAngle: 71 } });
  expect((await connection(a)).pending).toBe(2);
  expect((await getScene(a)).site.northAngle).toBe(71);

  const restarted = await server({ port: s.port, dataDir: s.dataDir });
  await expect.poll(async () => (await connection(a)).status, { timeout: 30_000 }).toBe('connected');
  await expect.poll(async () => (await connection(a)).pending).toBe(0);
  await expect(syncStatus(a)).toContainText('Connected · rev 3');

  // The server has both offline edits, and the other tab got them too.
  const onServer = (await (await request.get(`${restarted.url}/api/scene`)).json()) as { rev: number; scene: Scene };
  expect(onServer.rev).toBe(3);
  expect(onServer.scene.site.northAngle).toBe(71);
  await expect.poll(async () => (await getScene(b)).site.northAngle, { timeout: 30_000 }).toBe(71);
});

test('an epoch change asks before anything is overwritten', async ({ browser, request }) => {
  const s = await server();
  const a = await openSynced(browser, s);
  const b = await openSynced(browser, s);
  await a.evaluate((c) => window.__flat!.applyCommand(c), { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' });
  await expect.poll(async () => sejourFloor(await getScene(b))).toBe('floor-oak');

  // Someone imports another flat into the server: new epoch.
  const put = await request.put(`${s.url}/api/scene`, { data: JSON.stringify(sampleFlat), headers: { 'content-type': 'application/json' } });
  expect(put.status()).toBe(200);
  for (const page of [a, b]) {
    await expect(syncStatus(page)).toHaveText('Conflict: choose');
    await expect(page.getByTestId('sync-conflict')).toBeVisible();
    expect(sejourFloor(await getScene(page))).toBe('floor-oak'); // still showing mine
  }

  await a.getByTestId('sync-use-server').click();
  await expect(a.getByTestId('sync-conflict')).toBeHidden();
  await expect.poll(async () => (await getScene(a)).name).toBe(sampleFlat.name);
  await expect(syncStatus(a)).toContainText('Connected · rev 0');

  await b.getByTestId('sync-keep-mine').click();
  await expect(b.getByTestId('sync-conflict')).toBeHidden();
  await expect(syncStatus(b)).toContainText('Connected');
  const onServer = (await (await request.get(`${s.url}/api/scene`)).json()) as { scene: Scene };
  expect(onServer.scene.name).not.toBe(sampleFlat.name);
  expect(sejourFloor(onServer.scene)).toBe('floor-oak');
});

test('a disallowed Origin is refused', async ({ browser, request }) => {
  const s = await server();
  const post = await request.post(`${s.url}/api/commands`, {
    headers: { origin: 'http://evil.example' },
    data: { v: 1, id: 'evil-1', ts: 1, author: { kind: 'user' }, cmd: { type: 'site.set', site: { northAngle: 5 } } },
  });
  expect(post.status()).toBe(403);
  const put = await request.put(`${s.url}/api/scene`, { headers: { origin: 'http://evil.example' }, data: '{}' });
  expect(put.status()).toBe(403);
  expect(((await (await request.get(`${s.url}/healthz`)).json()) as { rev: number }).rev).toBe(0);

  // A page on another origin cannot open the socket either.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('http://localhost:5173/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>x</title>' }));
  await page.goto('http://localhost:5173/');
  const outcome = await page.evaluate(
    (url) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`);
        ws.onopen = () => resolve('open');
        ws.onclose = () => resolve('refused');
      }),
    s.url,
  );
  expect(outcome).toBe('refused');
});

test('a room-scoped wall paint made through the finish panel syncs to tab B, leaves the alcove stretch alone, and undoes from B', async ({ browser }) => {
  const s = await server();
  const a = await openSynced(browser, s);
  const b = await openSynced(browser, s);
  const roomFinishes = async (p: Page) => (await getScene(p)).walls.find((w) => w.id === 'w-west')!.roomFinishes;

  expect(await a.evaluate(() => window.__flat!.select({ wallId: 'w-west', side: 'right', roomId: 'sejour' }))).toBe(true);
  await a.evaluate(() => window.__flat!.whenRendered());
  const finish = a.getByTestId('properties').getByRole('region', { name: 'Finish' });
  await expect(finish.getByRole('button', { name: 'This wall (Séjour side)' })).toHaveAttribute('aria-pressed', 'true');
  await finish.getByRole('radio', { name: /^Navy / }).click();
  await expect.poll(() => roomFinishes(b), { timeout: 2000 }).toEqual({ sejour: { right: 'paint-26354f-matt' } });
  expect(await roomFinishes(a)).toEqual({ sejour: { right: 'paint-26354f-matt' } });

  expect(await b.evaluate(() => window.__flat!.undo())).toMatchObject({ ok: true });
  await expect.poll(() => roomFinishes(a), { timeout: 2000 }).toBeUndefined();
});
