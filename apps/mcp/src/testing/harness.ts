import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadConfig as loadServerConfig } from '@flat/server/src/config';
import { startServer, type RunningServer } from '@flat/server/src/server';

/** Directory of the `@flat/mcp` package. */
export const MCP_DIR = fileURLToPath(new URL('../..', import.meta.url));

export interface StdioHarness {
  client: Client;
  transport: StdioClientTransport;
  /** Everything the server wrote to stderr so far. */
  stderr: () => string;
  close(): Promise<void>;
}

/** Spawns `src/main.ts` as a real child process and connects an SDK client over its stdio. */
export async function connectStdio(env: Record<string, string> = {}, clientName = 'flat-test-client'): Promise<StdioHarness> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/main.ts'],
    cwd: MCP_DIR,
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: 'pipe',
  });
  let err = '';
  transport.stderr?.on('data', (d: Buffer) => (err += d.toString()));
  const client = new Client({ name: clientName, version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, stderr: () => err, close: () => client.close() };
}

export interface RealServer {
  server: RunningServer;
  url: string;
  close(): Promise<void>;
}

/** Boots the real `apps/server` app in this process on an ephemeral port with a throw-away data dir. */
export async function startRealServer(over: Record<string, unknown> = {}): Promise<RealServer> {
  const dir = await mkdtemp(join(tmpdir(), 'flat-mcp-'));
  const config = loadServerConfig({}, { dataDir: dir, port: 0, snapshotDebounceMs: 10, log: () => {}, rateLimitPerSec: 100000, ...over });
  const server = await startServer(config);
  return {
    server,
    url: server.url,
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A URL on loopback where nothing listens (connection refused). */
export const DEAD_URL = 'http://127.0.0.1:1';
