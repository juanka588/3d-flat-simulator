#!/usr/bin/env node
/* global process, console */
/**
 * One command to make `render_view` work: `pnpm mcp:setup`.
 *   1. builds the viewer that render_view draws (apps/web/dist) with the root base path,
 *   2. installs the headless Chromium for the Playwright version in apps/mcp,
 *   3. checks it end to end: starts a scene server, launches the MCP server exactly as Claude Code does
 *      (`pnpm --silent --dir <repo> mcp`, from another directory) and renders the séjour. Fails loudly if the picture is blank.
 * Then it prints the `claude mcp add` line. Flags: --no-check, --skip-build, --skip-browser.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, connectLikeClaudeCode, mcpCommand, pngStats, startServer } from './mcp-demo/lib.mjs';

const flags = new Set(process.argv.slice(2));

function run(what, command, args, env = {}, cwd = ROOT) {
  console.log(`\n==> ${what}\n    $ ${[command, ...args].join(' ')}`);
  return new Promise((ok, bad) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('error', bad);
    child.on('exit', (code) => (code === 0 ? ok() : bad(new Error(`${what} failed (exit ${code})`))));
  });
}

function fail(message) {
  console.error(`\nmcp:setup FAILED: ${message}`);
  process.exit(1);
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) fail(`Node ${process.versions.node} is too old; the MCP server needs Node 22 or newer.`);

const pnpm = mcpCommand();
// pnpm's own entry (node <pnpm.cjs>, or the pnpm binary): the same args minus "--silent --dir ROOT mcp".
const pnpmBase = { command: pnpm.command, args: pnpm.args.slice(0, pnpm.args.indexOf('--silent')) };

try {
  if (!flags.has('--skip-build')) {
    await run('Building the viewer (BASE_PATH=/)', pnpmBase.command, [...pnpmBase.args, '--filter', '@flat/web', 'build'], { BASE_PATH: '/' });
  }
  if (!existsSync(join(ROOT, 'apps/web/dist/index.html'))) fail('apps/web/dist/index.html is missing after the build.');

  if (!flags.has('--skip-browser') && process.env.FLAT_RENDER_CHANNEL !== 'chrome') {
    const cli = join(ROOT, 'apps/mcp/node_modules/playwright/cli.js');
    if (!existsSync(cli)) fail('Dependencies are not installed: run `pnpm install` first.');
    await run('Installing Chromium for render_view', process.execPath, [cli, 'install', 'chromium']);
  }

  if (!flags.has('--no-check')) {
    console.log('\n==> Checking: scene server + MCP over stdio (as Claude Code starts it) + render_view');
    const dataDir = mkdtempSync(join(tmpdir(), 'flat-setup-'));
    const server = await startServer(dataDir);
    const mcp = await connectLikeClaudeCode({ serverUrl: server.url });
    try {
      const started = Date.now();
      const r = await mcp.client.callTool({ name: 'render_view', arguments: { view: 'room', roomId: 'sejour' } }, { timeout: 120_000 });
      const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ').slice(0, 600);
      const image = r.content.find((c) => c.type === 'image');
      if (r.isError || !image) fail(`render_view did not return an image.\n${text}\nMCP stderr:\n${mcp.stderr().slice(-1500)}`);
      const stats = pngStats(image.data);
      if (stats.variance < 100 || stats.colors < 50) fail(`render_view returned a blank-looking image (${stats.colors} colours, variance ${stats.variance.toFixed(1)}).\n${text}`);
      console.log(`    OK: ${image.mimeType} ${stats.width}x${stats.height}, ${stats.colors} colours, ${((Date.now() - started) / 1000).toFixed(1)} s (cold start)`);
    } finally {
      await mcp.close().catch(() => undefined);
      await server.stop().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  console.log(`
Done. Next:
  pnpm dev:all                                   # scene server (8787) + web app (5173); open http://127.0.0.1:5173/?server=http://127.0.0.1:8787
  claude mcp add flat -- pnpm --silent --dir "${ROOT}" mcp
`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
