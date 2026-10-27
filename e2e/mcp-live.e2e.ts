/**
 * M4.13 live tier: a real browser tab on `?server=` with "Follow assistant view" ON, a real apps/server,
 * and a real MCP client (SDK v2 over stdio) that spawns apps/mcp. A write tool reaches the tab within a
 * second with an llm author, and `set_sun_time {sync_to_user_tab}` changes the tab's lighting time but not
 * its lamps. Nightly / on demand (never in `pnpm test`); desktop chromium only.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Scene } from '../packages/scene/src/index';

const WEB_ORIGIN = 'http://127.0.0.1:5173';
const SERVER_CWD = join(process.cwd(), 'apps', 'server');
const MCP_CWD = join(process.cwd(), 'apps', 'mcp');

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

async function startServer(dataDir: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: SERVER_CWD,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ALLOWED_ORIGINS: WEB_ORIGIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout!.on('data', (d: Buffer) => (log += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (log += d.toString()));
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
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise<void>((r) => child.once('exit', () => r()));
        child.kill('SIGTERM');
        await exited;
      }
    },
  };
}

const SAGE = { id: 'paint-live-sage', name: 'Sage', kind: 'paint', color: '#a3ae93', roughness: 0.9 } as const;

test.setTimeout(120_000);

test('MCP write reaches the followed tab within 1 s (author llm); set_sun_time sync changes time, not lamps', async ({ page }) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'flat-live-'));
  const srv = await startServer(dataDir);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/main.ts'],
    cwd: MCP_CWD,
    env: { ...(process.env as Record<string, string>), FLAT_SERVER_URL: srv.url },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e-live', version: '1.0.0' });
  try {
    await page.goto(`/?server=${encodeURIComponent(srv.url)}`);
    await page.evaluate(() => window.__flat!.ready);
    await expect.poll(async () => (await page.evaluate(() => window.__flat!.connection())).status, { timeout: 15_000 }).toBe('connected');
    await page.getByTestId('follow-assistant').check();
    await client.connect(transport);

    const scene = (p: Page): Promise<Scene> => p.evaluate(() => window.__flat!.getScene());
    const finish = (s: Scene) => s.rooms.find((r) => r.id === 'sejour')!.wallFinish;
    const before = await scene(page);
    expect(finish(before)).not.toBe(SAGE.id);

    await client.callTool({ name: 'material_define', arguments: { material: SAGE } });
    const t0 = Date.now();
    const res = await client.callTool({ name: 'room_set_wall_finish', arguments: { roomId: 'sejour', materialId: SAGE.id } });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    await expect.poll(async () => finish(await scene(page)), { timeout: 1000 }).toBe(SAGE.id);
    const elapsed = Date.now() - t0;
    expect(elapsed, 'tool call + tab update').toBeLessThan(3000);
    await expect.poll(async () => (await page.evaluate(() => window.__flat!.history())).entries.at(-1)?.author, { timeout: 1000 }).toBe('llm');

    // set_sun_time with sync: the time changes in the tab, its lamps do not.
    const tabTime = () => page.evaluate(() => (window.__flat!.sunInfo() as { time?: string }).time);
    const lamps = () => page.evaluate(() => window.__flat!.stats().lights.lampsLit);
    const lampsBefore = await lamps();
    expect(await tabTime()).not.toBe('20:00');
    const sun = await client.callTool({ name: 'set_sun_time', arguments: { sync_to_user_tab: true, time: '20:00' } });
    expect(sun.isError, JSON.stringify(sun.content)).toBeFalsy();
    await expect.poll(tabTime, { timeout: 2000 }).toBe('20:00');
    await page.evaluate(() => window.__flat!.whenRendered());
    expect(await lamps()).toEqual(lampsBefore);
    await page.screenshot({ path: '/tmp/mcp-live-tab.png' });
  } finally {
    await client.close().catch(() => undefined);
    await srv.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('after an assistant session (paint, warm lights, synced evening, render_view) the followed tab still draws the flat', async ({ page }) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'flat-live-'));
  const srv = await startServer(dataDir);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/main.ts'],
    cwd: MCP_CWD,
    env: { ...(process.env as Record<string, string>), FLAT_SERVER_URL: srv.url },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'claude-code', version: '2.1.308' });
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    await page.goto(`/?server=${encodeURIComponent(srv.url)}`);
    await page.evaluate(() => window.__flat!.ready);
    await expect.poll(async () => (await page.evaluate(() => window.__flat!.connection())).status, { timeout: 15_000 }).toBe('connected');
    await page.getByTestId('follow-assistant').check();
    const baseline = await page.evaluate(() => window.__flat!.stats().triangles);
    await client.connect(transport);
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args }, { timeout: 90_000 });
      expect(r.isError, `${name}: ${JSON.stringify(r.content).slice(0, 300)}`).toBeFalsy();
    };
    await ok('get_scene_summary', {});
    await ok('describe_room', { roomId: 'sejour' });
    await ok('batch', {
      label: 'Sage séjour, warm lights',
      commands: [
        { type: 'material.define', material: SAGE },
        { type: 'room.setWallFinish', roomId: 'sejour', materialId: SAGE.id },
        { type: 'light.update', id: 'l-sejour', patch: { kelvin: 2700, on: true } },
      ],
    });
    await ok('set_sun_time', { preset: 'evening', sync_to_user_tab: true });
    await expect.poll(async () => (await page.evaluate(() => window.__flat!.sunInfo() as { time?: string })).time, { timeout: 3000 }).toBe('20:00');
    await ok('render_view', { view: 'room', roomId: 'sejour', preset: 'evening' });
    await page.evaluate(() => window.__flat!.whenRendered());
    const after = await page.evaluate(() => window.__flat!.stats());
    expect(after.triangles, 'geometry is still drawn').toBeGreaterThan(Math.min(1000, baseline / 2));
    expect(after.meshes).toContain('walls');
    await expect(page.getByTestId('viewer-error')).toBeHidden();
    expect(pageErrors).toEqual([]);
  } finally {
    await client.close().catch(() => undefined);
    await srv.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
