#!/usr/bin/env node
/* global process, console, fetch, setTimeout, Buffer, URL */
/**
 * M4.14: automated LLM demo. A real model drives the MCP tools over stdio against a real apps/server, and
 * the assertions are on STATE (scene, history), never on prose.
 *
 *   ANTHROPIC_API_KEY=... pnpm mcp:demo              # "Paint the séjour sage green ... and show me."
 *   ANTHROPIC_API_KEY=... pnpm mcp:demo -- --negative # "Remove the wall between the séjour and the hall."
 *   pnpm mcp:demo -- --dry [--negative]               # scripted fake model: tests the harness, no API calls, no cost
 *
 * Without ANTHROPIC_API_KEY (and without --dry) it prints "skipped" and exits 0.
 * Env: FLAT_DEMO_MODEL (default claude-opus-5-5; claude-sonnet-5-5 is the cheaper option),
 *      FLAT_DEMO_MAX_USD (hard cost cap, default 2), FLAT_DEMO_FINAL_PNG (default /tmp/mcp-demo-final.png).
 * Needs the viewer build for render_view: BASE_PATH=/ pnpm --filter @flat/web build; npx playwright install chromium.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = new Set(process.argv.slice(2));
const NEGATIVE = args.has('--negative');
const DRY = args.has('--dry');
const MODEL = process.env.FLAT_DEMO_MODEL || 'claude-opus-5-5';
const MAX_USD = Number(process.env.FLAT_DEMO_MAX_USD || 2);
const FINAL_PNG = process.env.FLAT_DEMO_FINAL_PNG || '/tmp/mcp-demo-final.png';
const MAX_TOOL_CALLS = 12;
const MAX_TURNS = 15;

/** USD per million tokens: [input, output, cache read, cache write]. */
const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
};

const PROMPT = NEGATIVE
  ? 'Remove the wall between the séjour and the hall.'
  : 'Paint the séjour sage green, give the flat warm 2700K evening lighting, and show me.';

if (!DRY && !process.env.ANTHROPIC_API_KEY) {
  console.log('skipped: ANTHROPIC_API_KEY is not set (use --dry to test the harness with a scripted model)');
  process.exit(0);
}

const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

async function freePort() {
  return new Promise((ok, bad) => {
    const s = createServer();
    s.once('error', bad);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

async function startServer(dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(ROOT, 'apps/server'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
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

const api = (base) => ({
  get: async (p) => (await fetch(base + p)).json(),
  post: async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`POST ${p} -> ${r.status} ${await r.text()}`);
    return r.json();
  },
});

// ---------------------------------------------------------------------------------------------
// Models: the real Messages API, or a scripted fake with the same surface (`messages.create`)
// ---------------------------------------------------------------------------------------------

async function realModel() {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  return { create: (p) => client.messages.create(p) };
}

/** A scripted model: the calls an obedient model would make. Same response shape as the API. */
function scriptedModel() {
  let turn = 0;
  const use = (name, input) => ({ type: 'tool_use', id: `toolu_dry_${turn}_${name}`, name, input });
  const reply = (content, stop_reason) => ({ id: `msg_dry_${turn}`, role: 'assistant', model: 'scripted', content, stop_reason, usage: { input_tokens: 1500, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  return {
    async create() {
      turn += 1;
      if (NEGATIVE) {
        if (turn === 1) return reply([{ type: 'text', text: 'Let me look at the flat first.' }, use('list_rooms', {})], 'tool_use');
        return reply([{ type: 'text', text: 'I cannot remove that wall: structural walls are never removable, and there is no wall removal tool.' }], 'end_turn');
      }
      if (turn === 1) return reply([{ type: 'text', text: 'Looking at the rooms.' }, use('list_rooms', {})], 'tool_use');
      if (turn === 2) {
        return reply(
          [
            use('batch', {
              label: 'Sage séjour with warm 2700K evening lighting',
              commands: [
                { type: 'material.define', material: { id: 'paint-sage-demo', name: 'Sage green', kind: 'paint', color: '#9caf88', roughness: 0.9 } },
                { type: 'room.setWallFinish', roomId: 'sejour', materialId: 'paint-sage-demo' },
                { type: 'light.update', id: 'l-sejour', patch: { kelvin: 2700, on: true } },
                { type: 'light.update', id: 'l-cuisine', patch: { kelvin: 2700, on: true } },
              ],
            }),
            use('set_sun_time', { preset: 'evening' }),
          ],
          'tool_use',
        );
      }
      if (turn === 3) return reply([use('render_view', { view: 'room', roomId: 'sejour', preset: 'evening' })], 'tool_use');
      return reply([{ type: 'text', text: 'The séjour is sage green and the lights are warm 2700 K. See the render.' }], 'end_turn');
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function costUsd(usage) {
  const p = PRICES[MODEL] ?? PRICES['claude-opus-5-5'];
  return (
    ((usage.input_tokens || 0) * p[0] + (usage.output_tokens || 0) * p[1] + (usage.cache_read_input_tokens || 0) * p[2] + (usage.cache_creation_input_tokens || 0) * p[3]) / 1e6
  );
}

/** MCP content -> Anthropic tool_result content (text and images; images go back as image blocks). */
function toResultContent(content) {
  const out = [];
  for (const c of content ?? []) {
    if (c.type === 'text') out.push({ type: 'text', text: c.text });
    else if (c.type === 'image') out.push({ type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } });
  }
  return out.length ? out : [{ type: 'text', text: '(no content)' }];
}

function hueOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return null; // grey: no hue
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const wallKey = (w) => JSON.stringify([w.id, w.start, w.end, w.thickness, w.height, w.structural ?? null]);

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const failures = [];
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(what);
};

const dataDir = mkdtempSync(join(tmpdir(), 'flat-demo-'));
let server;
let mcp;
let exitCode = 0;
try {
  server = await startServer(dataDir);
  const flat = api(server.url);

  // Baseline (authored by the user, not the model): every lamp off and cold, so "warm 2700K and on" is something the model had to do.
  const start = await flat.get('/api/scene');
  const setup = start.scene.lights.map((l) => ({ type: 'light.update', id: l.id, patch: { on: false, kelvin: 4000 } }));
  await flat.post('/api/commands', { v: 1, id: `demo-setup-${Date.now()}`, ts: Date.now(), author: { kind: 'user' }, cmd: { type: 'batch', label: 'demo baseline', commands: setup } });
  const before = await flat.get('/api/scene');
  const historyBefore = (await flat.get('/api/history')).past.length;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/main.ts'],
    cwd: join(ROOT, 'apps/mcp'),
    env: { ...process.env, FLAT_SERVER_URL: server.url },
    stderr: 'pipe',
  });
  let mcpErr = '';
  transport.stderr?.on('data', (d) => (mcpErr += d));
  mcp = new Client({ name: DRY ? 'llm-demo-dry' : 'llm-demo', version: '1.0.0' });
  await mcp.connect(transport);

  const listed = (await mcp.listTools()).tools;
  const tools = listed.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema }));
  console.log(`mode: ${DRY ? 'DRY (scripted model)' : `model ${MODEL}`}${NEGATIVE ? ' / negative' : ''}; ${tools.length} tools; server ${server.url}`);
  console.log(`prompt: ${PROMPT}`);

  const model = DRY ? scriptedModel() : await realModel();
  const messages = [{ role: 'user', content: PROMPT }];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
  const called = [];
  let renderReturnedImage = false;
  let lastImage;
  let turns = 0;
  let toolCalls = 0;
  let finished = false;
  let abort;

  while (!finished && !abort) {
    if (turns >= MAX_TURNS) {
      abort = `more than ${MAX_TURNS} turns`;
      break;
    }
    turns += 1;
    const res = await model.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: 'You are helping a user edit a 3D model of their flat through the provided tools. Act directly with the tools; verify visually when you change the look.',
      tools,
      messages,
    });
    usage.input += res.usage.input_tokens || 0;
    usage.output += res.usage.output_tokens || 0;
    usage.cacheRead += res.usage.cache_read_input_tokens || 0;
    usage.cacheWrite += res.usage.cache_creation_input_tokens || 0;
    usage.usd += DRY ? 0 : costUsd(res.usage);
    if (usage.usd > MAX_USD) {
      abort = `cost cap exceeded: $${usage.usd.toFixed(3)} > $${MAX_USD}`;
      break;
    }
    if (res.stop_reason === 'refusal') {
      abort = `the model refused (${res.stop_details?.category ?? 'no category'})`;
      break;
    }
    if (res.stop_reason === 'max_tokens') {
      abort = 'the model hit max_tokens';
      break;
    }
    messages.push({ role: 'assistant', content: res.content }); // unchanged: thinking blocks must be passed back
    for (const b of res.content) if (b.type === 'text' && b.text.trim()) console.log(`  [turn ${turns}] model: ${b.text.trim().slice(0, 300)}`);

    if (res.stop_reason === 'pause_turn') continue;
    if (res.stop_reason !== 'tool_use') {
      finished = true; // end_turn (or stop_sequence)
      break;
    }
    const uses = res.content.filter((b) => b.type === 'tool_use');
    toolCalls += uses.length;
    if (toolCalls > MAX_TOOL_CALLS) {
      abort = `more than ${MAX_TOOL_CALLS} tool calls`;
      break;
    }
    // All tool_result blocks of a turn go into ONE user message.
    const results = [];
    for (const u of uses) {
      called.push(u.name);
      let r;
      try {
        r = await mcp.callTool({ name: u.name, arguments: u.input ?? {} });
      } catch (e) {
        r = { isError: true, content: [{ type: 'text', text: `tool call failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
      const content = toResultContent(r.content);
      const img = content.find((c) => c.type === 'image');
      if (img) {
        lastImage = img.source.data;
        if (u.name === 'render_view' && !r.isError) renderReturnedImage = true;
      }
      console.log(`  [turn ${turns}] tool ${u.name}${r.isError ? ' -> ERROR' : ''}${img ? ' (image)' : ''}`);
      results.push({ type: 'tool_result', tool_use_id: u.id, content, ...(r.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }

  if (lastImage) {
    writeFileSync(FINAL_PNG, Buffer.from(lastImage, 'base64'));
    console.log(`final render saved to ${FINAL_PNG}`);
  }
  console.log(`usage: ${usage.input} in / ${usage.output} out / ${usage.cacheRead} cache-read / ${usage.cacheWrite} cache-write tokens; estimated cost $${usage.usd.toFixed(4)}${DRY ? ' (dry: no API calls)' : ''}; ${turns} turns, ${toolCalls} tool calls [${called.join(', ')}]`);

  // ---- Assertions on state ----
  check(!abort, 'the loop finished within its limits', abort ?? '');
  check(finished, 'the model ended its turn (stop_reason end_turn)');
  check(toolCalls <= MAX_TOOL_CALLS && turns <= MAX_TURNS, `at most ${MAX_TOOL_CALLS} tool calls and ${MAX_TURNS} turns`, `${toolCalls} calls, ${turns} turns`);

  const after = await flat.get('/api/scene');
  const history = await flat.get('/api/history');
  const beforeWalls = new Map(before.scene.walls.map((w) => [w.id, wallKey(w)]));
  const wallsSame = after.scene.walls.length === before.scene.walls.length && after.scene.walls.every((w) => beforeWalls.get(w.id) === wallKey(w));
  check(wallsSame, 'no structural wall changed or was removed (walls identical: ids, geometry, structural flags)');

  const mine = history.past.slice(historyBefore);
  check(mine.every((h) => h.author?.kind === 'llm'), 'every history entry after the baseline is authored by llm', `${mine.length} entries, authors: ${[...new Set(mine.map((h) => h.author?.kind))].join(',') || 'none'}`);

  if (NEGATIVE) {
    check(mine.length === 0 || mine.every((h) => !/wall/i.test(h.label)), 'no wall-related change in the history', mine.map((h) => h.label).join(' | '));
    check(after.scene.walls.length === before.scene.walls.length, 'the wall count is unchanged');
  } else {
    check(mine.length >= 1, 'the model changed the flat (at least one history entry)');
    const sejour = after.scene.rooms.find((r) => r.id === 'sejour');
    let color = after.scene.materials?.find((m) => m.id === sejour?.wallFinish)?.color;
    if (!color && sejour?.wallFinish) {
      const cat = await flat.get('/api/materials').catch(() => []);
      color = (Array.isArray(cat) ? cat : cat.materials ?? []).find((m) => m.id === sejour.wallFinish)?.meanColor;
    }
    const hue = hueOf(color);
    check(hue !== null && hue >= 70 && hue <= 150, 'the séjour wall finish resolves to a greenish paint (hue 70-150)', `finish ${sejour?.wallFinish ?? 'none'}, color ${color ?? '?'}, hue ${hue === null ? 'n/a' : Math.round(hue)}`);
    const warm = after.scene.lights.filter((l) => l.kelvin === 2700 && l.on !== false);
    check(warm.length >= 1, 'at least one light has kelvin 2700 and is on', warm.map((l) => l.id).join(','));
    check(called.includes('render_view') && renderReturnedImage, 'render_view was called and returned an image');
    check(Boolean(lastImage), 'the final render was saved', FINAL_PNG);
  }
  if (mcpErr.trim() && process.env.FLAT_DEMO_VERBOSE) console.log(`mcp stderr:\n${mcpErr}`);
} catch (e) {
  console.error(`demo error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  exitCode = 1;
} finally {
  await mcp?.close().catch(() => undefined);
  await server?.stop().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\nDEMO FAILED: ${failures.length} assertion(s)`);
  exitCode = 1;
} else if (exitCode === 0) console.log('\nDEMO OK');
process.exit(exitCode);
