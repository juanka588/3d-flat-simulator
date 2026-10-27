#!/usr/bin/env node
/* global process, console, setTimeout, clearTimeout, Buffer */
/**
 * M5.18: the furnish demo. A real model furnishes Chambre 1 with real products through the MCP tools over stdio,
 * against a real apps/server (FLAT_PROVIDERS=mock by default, so the products are the offline fixtures). The
 * assertions are on STATE (scene, history, validate_layout, the bill of materials), never on prose.
 *
 *   pnpm mcp:demo:furnish                      # local `claude -p` (your Claude Code login: no API key)
 *   pnpm mcp:demo:furnish -- --negative        # "Add a sofa with SKU MOCK-INVENTED-999 and push the wardrobe placard aside."
 *   ANTHROPIC_API_KEY=... pnpm mcp:demo:furnish -- --api   # the Messages API instead of the CLI
 *   pnpm mcp:demo:furnish -- --dry [--negative]            # scripted fake model: tests the harness, no model, no cost
 *   pnpm mcp:demo:furnish -- --ikea                        # providers ikea-fr,mock: a LIVE run against IKEA France (personal use, yours to run)
 *
 * The user's request is sent as the `furnish_room` prompt of the MCP server (fetched with prompts/get and inlined:
 * `claude -p` does not run MCP prompts), preceded by the plain-language request.
 * Env: FLAT_DEMO_CLI_PNG (default /tmp/furnish-demo-render.png), FLAT_DEMO_CLI_MODEL, FLAT_DEMO_MAX_USD (default 2),
 *      FLAT_DEMO_CLI_TIMEOUT_S (default 600), CLAUDE_BIN, FLAT_DEMO_MODEL (--api; default claude-opus-5-5).
 * Needs `pnpm mcp:setup` (viewer build + Chromium) for render_view. ANTHROPIC_API_KEY never reaches the child processes.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wallKey } from './assertions.mjs';
import { api, cleanEnv, connectLikeClaudeCode, mcpCommand, startServer } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const NEGATIVE = args.has('--negative');
const DRY = args.has('--dry');
const API = args.has('--api');
const IKEA = args.has('--ikea');
const BACKEND = DRY ? 'dry' : API ? 'api' : 'cli';
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const PNG_OUT = process.env.FLAT_DEMO_CLI_PNG || '/tmp/furnish-demo-render.png';
const MAX_USD = Number(process.env.FLAT_DEMO_MAX_USD || 2);
const TIMEOUT_MS = Number(process.env.FLAT_DEMO_CLI_TIMEOUT_S || 600) * 1000;
const MODEL = process.env.FLAT_DEMO_MODEL || 'claude-opus-5-5';
const MAX_TOOL_CALLS = 30;
const MAX_TURNS = 25;
const ROOM = 'ch1';
const BUDGET = 800;
const PRICES = { 'claude-opus-5-5': [4, 20, 0.2, 5], 'claude-sonnet-5-5': [2, 10, 0.2, 2.5] };

const REQUEST = IKEA
  ? "Furnish Chambre 1 as a cosy bedroom with real IKEA products under €800, keep the wardrobe placard, don't block the window."
  : "Furnish Chambre 1 as a cosy bedroom with real products under €800, keep the wardrobe placard, don't block the window.";
const BRIEF = 'a cosy bedroom, real products only; keep the existing wardrobe placard; do not block the window';
const NEGATIVE_REQUEST = 'Add a sofa with SKU MOCK-INVENTED-999 and push the wardrobe placard aside.';

const failures = [];
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(what);
};

if (BACKEND === 'api' && !process.env.ANTHROPIC_API_KEY) {
  console.log('skipped: ANTHROPIC_API_KEY is not set (--api needs it; --dry tests the harness; the default uses the claude CLI)');
  process.exit(0);
}
if (BACKEND === 'cli') {
  const v = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) {
    console.log(`skipped: the \`${CLAUDE}\` CLI is not available (${v.error?.message ?? v.stderr?.trim() ?? 'exit ' + v.status})`);
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const textOf = (parts) => (parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
const money = (n) => `${(Math.round(n * 100) / 100).toFixed(2)} EUR`;
const pad = (s, n) => String(s).slice(0, n).padEnd(n);

/** productIds (and their text) a search/get tool returned, from the tool result text. */
function productIdsIn(text) {
  const ids = new Set();
  for (const m of text.matchAll(/"productId"\s*:\s*"([^"]+)"/g)) ids.add(m[1]);
  return ids;
}

function costUsd(model, u) {
  const p = PRICES[model] ?? PRICES['claude-opus-5-5'];
  return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_read_input_tokens || 0) * p[2] + (u.cache_creation_input_tokens || 0) * p[3]) / 1e6;
}

/** The prompt: the plain request, then (furnish mode) the server's own furnish_room prompt messages. */
async function buildPrompt(reader) {
  if (NEGATIVE) return NEGATIVE_REQUEST;
  const p = await reader.client.getPrompt({ name: 'furnish_room', arguments: { roomId: ROOM, brief: BRIEF, budgetEur: String(BUDGET) } });
  const steps = p.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n\n');
  return `${REQUEST}\n\nUse the flat MCP server. Follow this procedure (the server's furnish_room prompt):\n\n${steps}`;
}

// ---------------------------------------------------------------------------------------------
// Backends. Each returns { calls, finalText, lastImage, summary, finished, abort }.
// calls: [{ name, input, text, image, error }] in order.
// ---------------------------------------------------------------------------------------------

async function runCli({ server, workDir, prompt }) {
  const { command, args: margs } = mcpCommand();
  const configPath = join(workDir, 'flat-mcp.json');
  writeFileSync(configPath, JSON.stringify({ mcpServers: { flat: { command, args: margs, env: { FLAT_SERVER_URL: server.url } } } }, null, 2));
  const cliArgs = [
    '-p', prompt,
    '--mcp-config', configPath,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__flat__*',
    '--tools', '',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-budget-usd', String(MAX_USD),
    '--no-session-persistence',
    ...(process.env.FLAT_DEMO_CLI_MODEL ? ['--model', process.env.FLAT_DEMO_CLI_MODEL] : []),
  ];
  const child = spawn(CLAUDE, cliArgs, { cwd: workDir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const uses = new Map();
  const calls = [];
  let lastImage;
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
        if (b.type === 'text' && b.text.trim()) console.log(`  [model] ${b.text.trim().slice(0, 300).replace(/\n/g, ' ')}`);
        if (b.type === 'tool_use') uses.set(b.id, { name: b.name.replace(/^mcp__flat__/, ''), input: b.input ?? {} });
      }
    } else if (ev.type === 'user') {
      for (const b of ev.message?.content ?? []) {
        if (b.type !== 'tool_result') continue;
        const use = uses.get(b.tool_use_id) ?? { name: '?', input: {} };
        const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
        const img = parts.find((p) => p.type === 'image');
        const error = Boolean(b.is_error);
        if (img && !error) lastImage = img.source?.data;
        calls.push({ name: use.name, input: use.input, text: textOf(parts), image: Boolean(img), error });
        console.log(`  [tool] ${use.name}${error ? ' -> ERROR' : ''}${img ? ' (image)' : ''}${error ? `: ${textOf(parts).slice(0, 200)}` : ''}`);
      }
    } else if (ev.type === 'result') result = ev;
  };
  child.stdout.on('data', (d) => {
    buffered += d;
    let i;
    while ((i = buffered.indexOf('\n')) >= 0) {
      onLine(buffered.slice(0, i));
      buffered = buffered.slice(i + 1);
    }
  });
  const exit = await new Promise((done) => {
    const timer = setTimeout(() => {
      console.log(`claude did not finish within ${TIMEOUT_MS / 1000} s: killing it`);
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
  onLine(buffered);
  if (stderr.trim()) console.log(`claude stderr:\n${stderr.trim().slice(-1200)}`);
  return {
    calls,
    lastImage,
    finalText: result?.result ?? '',
    turns: result?.num_turns ?? 0,
    finished: exit === 0 && Boolean(result) && !result.is_error,
    abort: exit === 0 && result && !result.is_error ? undefined : `claude exited ${exit} (${result?.subtype ?? 'no result event'})`,
    summary: result ? `${result.num_turns} turns, ${(result.duration_ms / 1000).toFixed(1)} s, $${(result.total_cost_usd ?? 0).toFixed(4)}` : 'no result event',
  };
}

/** A scripted model with the Messages API surface: the calls an obedient model would make. */
function scriptedModel() {
  let turn = 0;
  const use = (name, input) => ({ type: 'tool_use', id: `toolu_dry_${turn}_${name}`, name, input });
  const reply = (content, stop_reason) => ({ id: `msg_dry_${turn}`, role: 'assistant', model: 'scripted', content, stop_reason, usage: { input_tokens: 2000, output_tokens: 300 } });
  return {
    async create(params) {
      turn += 1;
      const seen = new Set();
      for (const m of params.messages) {
        if (m.role !== 'user' || typeof m.content === 'string') continue;
        for (const b of m.content) if (b.type === 'tool_result') for (const id of productIdsIn(textOf(b.content))) seen.add(id);
      }
      if (NEGATIVE) {
        if (turn === 1) return reply([{ type: 'text', text: 'Checking the room first.' }, use('describe_room', { roomId: ROOM }), use('place_item', { items: [{ productId: 'mock:MOCK-INVENTED-999', roomId: ROOM, relation: { kind: 'centered_in', roomId: ROOM } }] })], 'tool_use');
        return reply([{ type: 'text', text: 'I could not add that sofa: MOCK-INVENTED-999 is not a product any provider returned, and I never invent products. The wardrobe placard is locked existing furniture, so I left it where it is.' }], 'end_turn');
      }
      if (turn === 1) return reply([{ type: 'text', text: 'Reading the room and the providers.' }, use('describe_room', { roomId: ROOM }), use('list_providers', {})], 'tool_use');
      if (turn === 2) {
        return reply([use('search_products', { query: 'bed', category: 'bed', maxPrice: 400, maxWidth: 1.8 }), use('search_products', { query: '', category: 'bedside', maxPrice: 60, limit: 4 }), use('search_products', { query: '', category: 'drawers', maxPrice: 200, limit: 3 })], 'tool_use');
      }
      if (turn === 3) return reply([use('get_product', { productId: 'mock:MOCK-BED-160' }), use('get_product', { productId: 'mock:MOCK-NIGHT-WHT' }), use('get_product', { productId: 'mock:MOCK-CHEST-4' }), use('checkpoint', { name: 'before-furnish' })], 'tool_use');
      if (turn === 4) {
        const ok = ['mock:MOCK-BED-160', 'mock:MOCK-NIGHT-WHT', 'mock:MOCK-CHEST-4'].every((id) => seen.has(id));
        if (!ok) return reply([{ type: 'text', text: 'The searches did not return the products I expected.' }], 'end_turn');
        return reply([
          use('place_item', {
            label: 'Furnish Chambre 1',
            preview: true,
            render: { view: 'room', roomId: ROOM },
            items: [
              { productId: 'mock:MOCK-BED-160', roomId: ROOM, relation: { kind: 'against_wall', wallId: 'w-ch2-ch1', align: 'center' } },
              { productId: 'mock:MOCK-NIGHT-WHT', roomId: ROOM, relation: { kind: 'against_wall', wallId: 'w-ch2-ch1', align: 'start' } },
              { productId: 'mock:MOCK-CHEST-4', roomId: ROOM, relation: { kind: 'against_wall', wallId: 'w-east', align: 'center' } },
            ],
          }),
        ], 'tool_use');
      }
      if (turn === 5) {
        const items = params.messages.at(-1).content;
        void items;
        return reply([
          use('place_item', {
            label: 'Furnish Chambre 1',
            items: [
              { productId: 'mock:MOCK-BED-160', roomId: ROOM, relation: { kind: 'against_wall', wallId: 'w-ch2-ch1', align: 'center' } },
              { productId: 'mock:MOCK-NIGHT-WHT', roomId: ROOM, relation: { kind: 'against_wall', wallId: 'w-ch2-ch1', align: 'start' } },
              { productId: 'mock:MOCK-CHEST-4', roomId: ROOM, relation: { kind: 'against_wall', wallId: 'w-east', align: 'center' } },
            ],
          }),
        ], 'tool_use');
      }
      if (turn === 6) return reply([use('validate_layout', { roomId: ROOM, budgetEur: BUDGET }), use('get_bill_of_materials', { roomId: ROOM })], 'tool_use');
      if (turn === 7) return reply([use('render_view', { view: 'room', roomId: ROOM })], 'tool_use');
      return reply([{ type: 'text', text: 'Chambre 1 is furnished: a bed, a bedside table and a chest of drawers, all real catalogue products, under budget. The placard and the window are untouched.' }], 'end_turn');
    },
  };
}

async function runApi({ reader, prompt }) {
  const model = DRY ? scriptedModel() : await (async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    return { create: (p) => client.messages.create(p) };
  })();
  const tools = (await reader.client.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema }));
  const instructions = reader.client.getInstructions();
  const messages = [{ role: 'user', content: prompt }];
  const calls = [];
  let lastImage;
  let turns = 0;
  let usd = 0;
  let finalText = '';
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
      output_config: { effort: process.env.FLAT_DEMO_EFFORT || 'high' },
      system: `You are helping a user edit a 3D model of their flat through the provided tools. Act directly with the tools; verify visually when you change the look.${instructions ? `\n\nServer instructions:\n${instructions}` : ''}`,
      tools,
      messages,
    });
    usd += DRY ? 0 : costUsd(MODEL, res.usage);
    if (usd > MAX_USD) {
      abort = `cost cap exceeded: $${usd.toFixed(3)} > $${MAX_USD}`;
      break;
    }
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
      abort = `stop_reason ${res.stop_reason}`;
      break;
    }
    messages.push({ role: 'assistant', content: res.content });
    for (const b of res.content) if (b.type === 'text' && b.text.trim()) console.log(`  [turn ${turns}] model: ${b.text.trim().slice(0, 300).replace(/\n/g, ' ')}`);
    finalText = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || finalText;
    if (res.stop_reason === 'pause_turn') continue;
    if (res.stop_reason !== 'tool_use') {
      finished = true;
      break;
    }
    const results = [];
    for (const u of res.content.filter((b) => b.type === 'tool_use')) {
      if (calls.length >= MAX_TOOL_CALLS) {
        abort = `more than ${MAX_TOOL_CALLS} tool calls`;
        break;
      }
      let r;
      try {
        r = await reader.client.callTool({ name: u.name, arguments: u.input ?? {} });
      } catch (e) {
        r = { isError: true, content: [{ type: 'text', text: `tool call failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
      const content = [];
      for (const c of r.content ?? []) {
        if (c.type === 'text') content.push({ type: 'text', text: c.text });
        else if (c.type === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } });
      }
      const img = content.find((c) => c.type === 'image');
      if (img && !r.isError) lastImage = img.source.data;
      calls.push({ name: u.name, input: u.input ?? {}, text: textOf(content), image: Boolean(img), error: Boolean(r.isError) });
      console.log(`  [turn ${turns}] tool ${u.name}${r.isError ? ' -> ERROR' : ''}${img ? ' (image)' : ''}`);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: content.length ? content : [{ type: 'text', text: '(no content)' }], ...(r.isError ? { is_error: true } : {}) });
    }
    if (abort) break;
    messages.push({ role: 'user', content: results });
  }
  return { calls, lastImage, finalText, turns, finished, abort, summary: `${turns} turns, ${DRY ? 'dry: no cost' : `$${usd.toFixed(4)}`}` };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const dataDir = mkdtempSync(join(tmpdir(), 'flat-furnish-'));
const workDir = mkdtempSync(join(tmpdir(), 'flat-furnish-cwd-'));
let server;
let reader;
let exitCode = 0;
try {
  const providers = IKEA ? 'ikea-fr,mock' : 'mock';
  // FLAT_ENV_FILE points at nothing so apps/server/.env.local cannot change the provider set of the run.
  server = await startServer(dataDir, { FLAT_PROVIDERS: providers, FLAT_ENV_FILE: join(dataDir, 'none.env') });
  const flat = api(server.url);
  reader = await connectLikeClaudeCode({ serverUrl: server.url, clientName: `furnish-demo-${BACKEND}` });
  const before = await flat.get('/api/scene');
  const historyBefore = (await flat.get('/api/history')).past.length;
  const prompt = await buildPrompt(reader);
  console.log(`backend: ${BACKEND}${NEGATIVE ? ' / negative' : ''}; providers: ${providers}; scene server ${server.url}`);
  console.log(`request: ${NEGATIVE ? NEGATIVE_REQUEST : REQUEST}${NEGATIVE ? '' : ` (+ the furnish_room prompt, ${prompt.length} chars)`}`);

  // The model's own MCP session is separate from `reader` for the CLI (its seen-products registry is per session);
  // for --api/--dry the model uses `reader`'s session, which is fine because the reader only asserts at the end.
  const run = BACKEND === 'cli' ? await runCli({ server, workDir, prompt }) : await runApi({ reader, prompt });
  const { calls } = run;

  if (run.lastImage) {
    writeFileSync(PNG_OUT, Buffer.from(run.lastImage, 'base64'));
    console.log(`final render saved to ${PNG_OUT}`);
  }
  console.log(`${BACKEND} finished: ${run.summary}; ${calls.length} tool calls [${calls.map((c) => c.name).join(', ')}]`);
  if (run.finalText) console.log(`\nfinal message:\n${run.finalText}\n`);

  // ---- Assertions on state ----
  const after = await flat.get('/api/scene');
  const history = await flat.get('/api/history');
  const callTool = async (name, a) => (await reader.client.callTool({ name, arguments: a })).structuredContent;

  check(Boolean(run.finished) && !run.abort, 'the model finished within its limits', run.abort ?? '');
  check(calls.length <= MAX_TOOL_CALLS, `at most ${MAX_TOOL_CALLS} tool calls`, String(calls.length));
  check(run.turns <= MAX_TURNS, `at most ${MAX_TURNS} turns`, String(run.turns));

  const beforeWalls = new Map(before.scene.walls.map((w) => [w.id, wallKey(w)]));
  check(after.scene.walls.length === before.scene.walls.length && after.scene.walls.every((w) => beforeWalls.get(w.id) === wallKey(w)), 'no structural wall changed or was removed');

  const lockedBefore = before.scene.items.filter((i) => i.locked);
  const afterById = new Map(after.scene.items.map((i) => [i.id, i]));
  const placardsSame = lockedBefore.length > 0 && lockedBefore.every((i) => JSON.stringify(afterById.get(i.id)) === JSON.stringify(i) && afterById.get(i.id)?.locked === true);
  check(placardsSame, 'the placards are unchanged and still locked', lockedBefore.map((i) => i.id).join(','));

  const mine = history.past.slice(historyBefore);
  check(mine.every((h) => h.author?.kind === 'llm'), 'every history entry of the run is authored by llm', `${mine.length} entries; authors: ${[...new Set(mine.map((h) => `${h.author?.kind}${h.author?.name ? `:${h.author.name}` : ''}`))].join(',') || 'none'}`);

  const beforeIds = new Set(before.scene.items.map((i) => i.id));
  const placed = after.scene.items.filter((i) => !beforeIds.has(i.id));

  if (NEGATIVE) {
    check(!placed.some((i) => JSON.stringify(i).includes('INVENTED')), 'nothing invented was placed (no item with SKU MOCK-INVENTED-999)', `${placed.length} new items`);
    console.log(`INFO  items placed in the negative run: ${placed.length ? placed.map((i) => i.productRef ? `${i.productRef.provider}:${i.productRef.sku}` : i.id).join(', ') : 'none'}`);
    const refused = calls.some((c) => c.error && /unknown_product/.test(c.text));
    console.log(`INFO  the server refused an invented product with unknown_product: ${refused ? 'yes' : 'no (the model may have declined without trying)'}`);
  } else {
    // Every placed item is a real product seen in a search of this MCP session.
    const seen = new Set();
    for (const c of calls) if ((c.name === 'search_products' || c.name === 'get_product') && !c.error) for (const id of productIdsIn(c.text)) seen.add(id);
    const unseen = placed.filter((i) => !i.productRef || !seen.has(`${i.productRef.provider}:${i.productRef.sku}`));
    check(placed.length > 0 && unseen.length === 0, 'every placed item has a productRef that was seen in a search', unseen.length ? `not seen: ${unseen.map((i) => i.id).join(',')}` : `${placed.length} items, ${seen.size} products seen`);
    check(placed.length >= 3, 'at least 3 items placed', String(placed.length));
    check(placed.some((i) => i.product?.category === 'bed'), 'a bed is among them');
    check(placed.every((i) => i.roomId === ROOM), `all placed items are in ${ROOM}`);

    const bom = await callTool('get_bill_of_materials', { roomId: ROOM });
    check(typeof bom?.totalEur === 'number' && bom.totalEur <= BUDGET, `the BOM total for ${ROOM} is at most ${BUDGET} TTC`, bom ? money(bom.totalEur) : 'no BOM');
    const layout = await callTool('validate_layout', { roomId: ROOM, budgetEur: BUDGET });
    check(layout?.ok === true, `validateLayout(${ROOM}).ok`, `${layout?.violations?.length ?? '?'} violations, ${layout?.warnings?.length ?? '?'} warnings`);
    const blob = JSON.stringify([...(layout?.violations ?? []), ...(layout?.warnings ?? [])]);
    check(!blob.includes('door-ch1'), 'the swing of door-ch1 is not violated');
    check(!blob.includes('win-ch1'), 'the clearance of win-ch1 is not violated');
    check(layout?.overBudget === false, 'overBudget is false');
    check(calls.some((c) => c.name === 'render_view' && c.image && !c.error), 'at least one render_view image was returned');
    check(Boolean(run.lastImage), 'the final render was saved', PNG_OUT);

    console.log('\nPrice table (TTC):');
    console.log(`${pad('item', 38)} ${pad('productId', 22)} ${pad('w x d x h (m)', 16)} ${pad('price', 12)} link`);
    for (const g of bom?.bySku ?? []) {
      const item = after.scene.items.find((i) => g.itemIds?.includes(i.id));
      const d = item?.dims ? `${item.dims.w} x ${item.dims.d} x ${item.dims.h}` : '?';
      console.log(`${pad(g.name, 38)} ${pad(g.productId, 22)} ${pad(d, 16)} ${pad(`${g.quantity} x ${g.unitPrice}`, 12)} ${g.url ?? ''}`);
    }
    console.log(`${pad('TOTAL', 38)} ${pad('', 22)} ${pad('', 16)} ${money(bom?.totalEur ?? 0)} (budget ${BUDGET})`);
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
