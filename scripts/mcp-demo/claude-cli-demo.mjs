#!/usr/bin/env node
/* global process, console, setTimeout, clearTimeout, Buffer */
/**
 * LLM demo through the local `claude` CLI (your own Claude Code login: no API key, nothing billed to a key).
 * `claude -p` is started headless with an MCP config pointing at this repo's server, the demo prompt, only the
 * flat MCP tools allowed (`--allowedTools mcp__flat__*`, no built-in tools) and `--output-format stream-json`.
 * Then the same state assertions as `llm-demo.mjs` run against the scene server, and the picture Claude was
 * handed by `render_view` is saved (default /tmp/cli-demo-render.png).
 *
 *   pnpm mcp:demo:cli              # "Paint the séjour sage green ... and show me", then describe the picture
 *   pnpm mcp:demo:cli -- --negative
 *
 * Env: FLAT_DEMO_CLI_PNG (default /tmp/cli-demo-render.png), FLAT_DEMO_CLI_MODEL (a --model value, default: the CLI's own),
 *      FLAT_DEMO_MAX_USD (--max-budget-usd, default 2), FLAT_DEMO_CLI_TIMEOUT_S (default 300), CLAUDE_BIN (default `claude`).
 * Needs `pnpm mcp:setup` (viewer build + Chromium) for render_view. ANTHROPIC_API_KEY is removed from the child
 * environment so the CLI uses its own login; the scene and MCP servers never see it either.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMPT_NEGATIVE, PROMPT_SAGE, applyBaseline, assertDemoState } from './assertions.mjs';
import { api, cleanEnv, connectLikeClaudeCode, mcpCommand, startServer } from './lib.mjs';

const NEGATIVE = process.argv.slice(2).includes('--negative');
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const PNG_OUT = process.env.FLAT_DEMO_CLI_PNG || '/tmp/cli-demo-render.png';
const MAX_USD = process.env.FLAT_DEMO_MAX_USD || '2';
const TIMEOUT_MS = Number(process.env.FLAT_DEMO_CLI_TIMEOUT_S || 300) * 1000;
const PROMPT = NEGATIVE
  ? PROMPT_NEGATIVE
  : `${PROMPT_SAGE} Use the flat MCP server (tools mcp__flat__*). Once you have the render, describe in a few sentences what the image shows: the wall and floor colours of the séjour and how the light looks.`;

const version = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8' });
if (version.error || version.status !== 0) {
  console.log(`skipped: the \`${CLAUDE}\` CLI is not available (${version.error?.message ?? version.stderr?.trim() ?? 'exit ' + version.status})`);
  process.exit(0);
}

const failures = [];
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(what);
};

const dataDir = mkdtempSync(join(tmpdir(), 'flat-clidemo-'));
const workDir = mkdtempSync(join(tmpdir(), 'flat-clidemo-cwd-'));
let server;
let reader;
let exitCode = 0;
try {
  server = await startServer(dataDir);
  const flat = api(server.url);
  const { before, historyBefore } = await applyBaseline(flat);

  const { command, args } = mcpCommand();
  const configPath = join(workDir, 'flat-mcp.json');
  writeFileSync(configPath, JSON.stringify({ mcpServers: { flat: { command, args, env: { FLAT_SERVER_URL: server.url } } } }, null, 2));

  const cliArgs = [
    '-p', PROMPT,
    '--mcp-config', configPath,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__flat__*',
    '--tools', '',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-budget-usd', MAX_USD,
    '--no-session-persistence',
    ...(process.env.FLAT_DEMO_CLI_MODEL ? ['--model', process.env.FLAT_DEMO_CLI_MODEL] : []),
  ];
  console.log(`claude ${version.stdout.trim()}; scene server ${server.url}`);
  console.log(`prompt: ${PROMPT}`);

  const child = spawn(CLAUDE, cliArgs, { cwd: workDir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const uses = new Map(); // tool_use id -> { name, input }
  const calls = [];
  let lastImage;
  let lastImageTool;
  let result;
  let buffered = '';
  const onLine = (line) => {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'assistant') {
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'text' && b.text.trim()) console.log(`  [model] ${b.text.trim().slice(0, 400)}`);
        if (b.type === 'tool_use') uses.set(b.id, { name: b.name.replace(/^mcp__flat__/, ''), input: b.input ?? {} });
      }
    } else if (ev.type === 'user') {
      for (const b of ev.message?.content ?? []) {
        if (b.type !== 'tool_result') continue;
        const use = uses.get(b.tool_use_id) ?? { name: '?', input: {} };
        const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
        const img = parts.find((p) => p.type === 'image');
        const error = Boolean(b.is_error);
        const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
        if (img && !error) {
          lastImage = img.source?.data;
          lastImageTool = use.name;
        }
        calls.push({ name: use.name, input: use.input, image: Boolean(img), error });
        console.log(`  [tool] ${use.name}${error ? ' -> ERROR' : ''}${img ? ` (image ${img.source?.media_type}, ${img.source?.data?.length ?? 0} base64 chars)` : ''}${error ? `: ${text.slice(0, 300)}` : ''}`);
      }
    } else if (ev.type === 'result') {
      result = ev;
    }
  };
  child.stdout.on('data', (d) => {
    buffered += d;
    let i;
    while ((i = buffered.indexOf('\n')) >= 0) {
      onLine(buffered.slice(0, i));
      buffered = buffered.slice(i + 1);
    }
  });
  const exit = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      console.log(`claude did not finish within ${TIMEOUT_MS / 1000} s: killing it`);
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  onLine(buffered);

  if (lastImage) {
    writeFileSync(PNG_OUT, Buffer.from(lastImage, 'base64'));
    console.log(`final render (from ${lastImageTool}) saved to ${PNG_OUT}`);
  }
  console.log(`claude exited ${exit}; ${result ? `${result.num_turns} turns, ${(result.duration_ms / 1000).toFixed(1)} s, $${(result.total_cost_usd ?? 0).toFixed(4)}` : 'no result event'}; tool calls [${calls.map((c) => c.name).join(', ')}]`);
  if (result?.result) console.log(`\nfinal message:\n${result.result}\n`);
  if (stderr.trim()) console.log(`claude stderr:\n${stderr.trim().slice(-1500)}`);

  check(exit === 0 && result && !result.is_error, 'claude -p finished without error', result?.subtype ?? `exit ${exit}`);
  check(calls.length >= 1, 'the model called flat MCP tools', calls.map((c) => c.name).join(','));
  const imageCalls = calls.filter((c) => c.image && !c.error);
  check(imageCalls.some((c) => c.name === 'render_view') || imageCalls.length > 0, 'a tool_result with an image reached the model (render_view, or a write with render)', imageCalls.map((c) => c.name).join(','));

  reader = await connectLikeClaudeCode({ serverUrl: server.url, clientName: 'cli-demo-reader' });
  const describeRoom = async (roomId) => (await reader.client.callTool({ name: 'describe_room', arguments: { roomId } })).structuredContent;
  await assertDemoState({ check, flat, describeRoom, before, historyBefore, calls, lastImage, finalPng: PNG_OUT, negative: NEGATIVE });

  if (!NEGATIVE && result?.result) {
    // Informational only (state assertions never judge prose): did the description mention the sage green?
    const says = /sage|green|olive|khaki/i.test(result.result);
    console.log(`INFO  the final message mentions the green walls: ${says ? 'yes' : 'no'}`);
  }
} catch (e) {
  console.error(`demo error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  exitCode = 1;
} finally {
  await reader?.close().catch(() => undefined);
  await server?.stop().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\nDEMO FAILED: ${failures.length} assertion(s)`);
  exitCode = 1;
} else if (exitCode === 0) console.log('\nDEMO OK');
process.exit(exitCode);
