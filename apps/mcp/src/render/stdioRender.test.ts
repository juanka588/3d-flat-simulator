import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DIST } from './browserRenderer';
import { startFlatServer, type RunningServer } from './harness';
import { hasBuild } from './staticServer';

/**
 * Slow (`MCP_RENDER=1 pnpm test:render`): the regression test of "the tool calls happened but the render shows
 * nothing". It starts the MCP server the way Claude Code does - a fresh process of
 * `pnpm --silent --dir <repo> mcp`, from a working directory that is NOT the repo, over stdio, with the
 * viewer built the documented way (`BASE_PATH=/ pnpm --filter @flat/web build`) - and asserts that `render_view`
 * returns a real picture: an image block with the PNG base64 (no data: prefix), a non-blank decode (luma variance and
 * a non-trivial colour count), no error, and a clean stdout (the client would not have connected otherwise).
 */

const REPO = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

/** How a pnpm script is run from here: the pnpm that runs this test (npm_execpath), else `pnpm` on PATH. */
function pnpm(args: string[]): { command: string; args: string[] } {
  const exec = process.env.npm_execpath;
  if (exec && /pnpm/.test(exec)) return /\.[cm]?js$/.test(exec) ? { command: process.execPath, args: [exec, ...args] } : { command: exec, args };
  return { command: 'pnpm', args };
}

function pictureStats(png: PNG) {
  const n = png.width * png.height;
  const colors = new Set<number>();
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const r = png.data[i * 4]!;
    const g = png.data[i * 4 + 1]!;
    const b = png.data[i * 4 + 2]!;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    sumSq += luma * luma;
    colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  const mean = sum / n;
  return { mean, variance: sumSq / n - mean * mean, colors: colors.size };
}

type Block = { type: string; data?: string; mimeType?: string; text?: string };

async function renderOverStdio(serverUrl: string, env: Record<string, string>) {
  const run = pnpm(['--silent', '--dir', REPO, 'mcp']);
  const transport = new StdioClientTransport({
    ...run,
    cwd: tmpdir(), // not the repo: the README command must work from anywhere
    env: { ...(process.env as Record<string, string>), FLAT_SERVER_URL: serverUrl, ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  const client = new Client({ name: 'claude-code', version: '2.1.308' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'render_view', arguments: { view: 'room', roomId: 'sejour' } }, { timeout: 150_000 });
    return { result, stderr: () => stderr };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function expectPicture(result: Awaited<ReturnType<typeof renderOverStdio>>['result'], stderr: string): void {
  const content = result.content as Block[];
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
  expect(result.isError, `render_view failed: ${text}\n${stderr}`).toBeFalsy();
  const images = content.filter((c) => c.type === 'image');
  expect(images).toHaveLength(1);
  const image = images[0]!;
  expect(image.mimeType).toBe('image/png');
  expect(image.data, 'raw base64, not a data: URL').toMatch(/^iVBORw0KGgo/);
  const png = PNG.sync.read(Buffer.from(image.data!, 'base64'));
  expect([png.width, png.height]).toEqual([1024, 768]);
  const stats = pictureStats(png);
  // A real render of the séjour measures ~2900 (variance) and ~370 colours; one flat colour is 0 and 1.
  expect(stats.variance, `blank-looking render (mean luma ${stats.mean.toFixed(0)}, ${stats.colors} colours)`).toBeGreaterThan(400);
  expect(stats.colors).toBeGreaterThan(100);
  expect((result.structuredContent as { ok?: boolean }).ok).toBe(true);
}

describe.runIf(process.env.MCP_RENDER)('render_view over stdio, started the way Claude Code starts it (slow)', () => {
  let srv: RunningServer;
  let freshDist: string;

  beforeAll(async () => {
    srv = await startFlatServer('http://127.0.0.1:5173');
    // The documented build, into a scratch directory so the repo's own dist is left alone: BASE_PATH=/ pnpm --filter @flat/web build
    freshDist = mkdtempSync(join(tmpdir(), 'flat-dist-'));
    const build = pnpm(['--filter', '@flat/web', 'exec', 'vite', 'build', '--outDir', freshDist, '--emptyOutDir']);
    const r = spawnSync(build.command, build.args, { cwd: REPO, env: { ...process.env, BASE_PATH: '/' }, encoding: 'utf8', timeout: 240_000 });
    if (r.status !== 0) throw new Error(`web build failed (${r.status}): ${(r.stdout + r.stderr).slice(-1500)}`);
  }, 300_000);

  afterAll(async () => {
    await srv?.stop();
    if (freshDist) rmSync(freshDist, { recursive: true, force: true });
  });

  it('a fresh stdio process with a BASE_PATH=/ build returns a non-blank PNG', async () => {
    const { result, stderr } = await renderOverStdio(srv.url, { FLAT_WEB_URL: freshDist });
    expectPicture(result, stderr());
  }, 200_000);

  it.runIf(hasBuild(DEFAULT_DIST))('a fresh stdio process with the repo apps/web/dist (any base path, e.g. the Pages build) returns a non-blank PNG', async () => {
    const { result, stderr } = await renderOverStdio(srv.url, { FLAT_WEB_URL: '' });
    expectPicture(result, stderr());
  }, 200_000);
});
