import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, type Command } from '@flat/scene';
import { loadConfig } from '../config';
import { HttpFlatApi, type FlatApi } from '../flatApi';
import { fakeClock } from '../testing/inproc';
import { newSession, type ToolContext } from '../tools/registry';

/** Test harness for the render service: a real apps/server on a free port plus a tool context over `HttpFlatApi`. */

const SERVER_CWD = fileURLToPath(new URL('../../../server', import.meta.url));

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

export interface RunningServer {
  url: string;
  flat: FlatApi;
  stop(): Promise<void>;
}

/** Boots apps/server (Charme fixture, fresh data dir) accepting browser tabs served from `allowedOrigin`. */
export async function startFlatServer(allowedOrigin: string, env: Record<string, string> = {}): Promise<RunningServer> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'flat-render-'));
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: SERVER_CWD,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ALLOWED_ORIGINS: allowedOrigin, ...env },
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
  const config = loadConfig({}, { serverUrl: url, log: () => undefined });
  return {
    url,
    flat: new HttpFlatApi(config),
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise<void>((r) => child.once('exit', () => r()));
        child.kill('SIGTERM');
        await exited;
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A tool context over `flat` (an MCP session of its own). */
export function toolContext(flat: FlatApi, over: Partial<ToolContext> = {}): ToolContext {
  const config = loadConfig({}, { log: () => undefined });
  const clock = fakeClock();
  return { flat, limits: { ...config.limits, rendersPerMinute: 1000 }, clock, author: { kind: 'llm', name: 'render-test' }, session: newSession({ ...config.limits, rendersPerMinute: 1000 }, clock), config, ...over };
}

let n = 0;
/** Applies a command as the user would, through the scene server. */
export async function apply(flat: FlatApi, command: Command): Promise<void> {
  const r = await flat.postCommand(makeEnvelope(command, { id: `render-test-${Date.now()}-${n++}`, ts: Date.now(), author: { kind: 'user' } }));
  if (!r.ok) throw new Error(`command failed: ${JSON.stringify(r)}`);
}
