/* global process, fetch, setTimeout, URL, Buffer */
/**
 * Shared helpers of the MCP scripts (mcp-setup, llm-demo, claude-cli-demo): a throw-away scene server,
 * the way an MCP client launches this server (the exact command of the README), and image statistics.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export async function freePort() {
  return new Promise((ok, bad) => {
    const s = createServer();
    s.once('error', bad);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** An env without secrets the children do not need (the model key never reaches the scene server or the MCP server). */
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/** Boots apps/server on a free port with a fresh data dir (the Charme fixture). */
export async function startServer(dataDir, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(ROOT, 'apps/server'),
    env: cleanEnv({ PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ...extraEnv }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill('SIGTERM');
        await exited;
      }
    },
  };
}

export const api = (base) => ({
  get: async (p) => (await fetch(base + p)).json(),
  post: async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`POST ${p} -> ${r.status} ${await r.text()}`);
    return r.json();
  },
});

/**
 * The command an MCP client runs for this server: `pnpm --silent --dir <repo> mcp` (what the README gives to
 * `claude mcp add`). Under `pnpm run` the pnpm that started us is used, so a pnpm that is not on PATH works too.
 */
export function mcpCommand() {
  const exec = process.env.npm_execpath;
  if (exec && /pnpm/.test(exec)) {
    return exec.endsWith('.js') || exec.endsWith('.cjs') || exec.endsWith('.mjs')
      ? { command: process.execPath, args: [exec, '--silent', '--dir', ROOT, 'mcp'] }
      : { command: exec, args: ['--silent', '--dir', ROOT, 'mcp'] };
  }
  return { command: 'pnpm', args: ['--silent', '--dir', ROOT, 'mcp'] };
}

/** An MCP client (SDK v2) connected to the server exactly as Claude Code launches it, from `cwd` (default: not the repo). */
export async function connectLikeClaudeCode({ serverUrl, clientName = 'claude-code', cwd = '/', env = {} }) {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const { command, args } = mcpCommand();
  const transport = new StdioClientTransport({ command, args, cwd, env: cleanEnv({ FLAT_SERVER_URL: serverUrl, ...env }), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (d) => (stderr += d));
  const client = new Client({ name: clientName, version: '1.0.0' });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

/** Pixel statistics of a base64 PNG: luma deviation and the number of distinct (4 bit per channel) colours. */
export function pngStats(base64) {
  const { PNG } = createRequire(join(ROOT, 'apps/mcp/package.json'))('pngjs');
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  const n = png.width * png.height;
  const bins = new Set();
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const r = png.data[i * 4];
    const g = png.data[i * 4 + 1];
    const b = png.data[i * 4 + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += l;
    sumSq += l * l;
    bins.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  const mean = sum / n;
  return { width: png.width, height: png.height, mean, variance: sumSq / n - mean * mean, colors: bins.size };
}
