/**
 * Boots a real `apps/server` for the catalog specs: random port, temporary DATA_DIR, the Charme flat as the shared
 * scene, and the in-memory `mock` product provider (`FLAT_PROVIDERS=mock`). Same approach as sync.e2e.ts.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export const WEB_ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT ?? 5173}`;
const SERVER_CWD = join(process.cwd(), 'apps', 'server'); // playwright runs from the repo root

export interface RunningServer {
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

export async function startServer(opts: { providers?: string; dataDir?: string; port?: number; localCatalogDir?: string } = {}): Promise<RunningServer> {
  const port = opts.port ?? (await freePort());
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'flat-catalog-'));
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: SERVER_CWD,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ALLOWED_ORIGINS: WEB_ORIGIN, FLAT_PROVIDERS: opts.providers ?? 'mock', FLAT_ENV_FILE: join(dataDir, 'none.env'), LOCAL_CATALOG_DIR: opts.localCatalogDir ?? join(dataDir, 'no-local-catalog') },
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
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Opens the app connected to `server` and waits for the shared scene. */
export async function openConnected(page: Page, server: RunningServer): Promise<void> {
  await page.goto(`/?server=${encodeURIComponent(server.url)}`);
  await page.evaluate(() => window.__flat!.ready);
  await expect(page.locator('canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__flat!.connection().status), { timeout: 20_000 }).toBe('connected');
}
