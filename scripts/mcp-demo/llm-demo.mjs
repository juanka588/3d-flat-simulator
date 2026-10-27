#!/usr/bin/env node
/* global process, console, Buffer */
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
 * Needs the viewer build and Chromium for render_view: pnpm mcp:setup.
 * The server and MCP processes never see ANTHROPIC_API_KEY (only the in-process SDK client does).
 * For the local `claude` CLI instead of an API key: pnpm mcp:demo:cli.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, connectLikeClaudeCode, startServer } from './lib.mjs';
import { PROMPT_NEGATIVE, PROMPT_SAGE, applyBaseline, assertDemoState } from './assertions.mjs';
const args = new Set(process.argv.slice(2));
const NEGATIVE = args.has('--negative');
const DRY = args.has('--dry');
const MODEL = process.env.FLAT_DEMO_MODEL || 'claude-opus-5-5';
const MAX_USD = Number(process.env.FLAT_DEMO_MAX_USD || 2);
const FINAL_PNG = process.env.FLAT_DEMO_FINAL_PNG || '/tmp/mcp-demo-final.png';
const MAX_TOOL_CALLS = 12;
const MAX_TURNS = 15;
/** Effort of the model, set explicitly (default high). */
const EFFORT = process.env.FLAT_DEMO_EFFORT || 'high';

/** USD per million tokens: [input, output, cache read, cache write]. */
const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
};

const PROMPT = NEGATIVE ? PROMPT_NEGATIVE : PROMPT_SAGE;

if (!DRY && !process.env.ANTHROPIC_API_KEY) {
  console.log('skipped: ANTHROPIC_API_KEY is not set (use --dry to test the harness with a scripted model)');
  process.exit(0);
}

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

  const { before, historyBefore } = await applyBaseline(flat);

  // The MCP server is started exactly as Claude Code starts it (pnpm --silent --dir <repo> mcp, from another directory).
  // Its environment has no ANTHROPIC_API_KEY: the key is for the model API only.
  const connection = await connectLikeClaudeCode({ serverUrl: server.url, clientName: DRY ? 'llm-demo-dry' : 'llm-demo' });
  mcp = connection.client;
  const mcpErr = () => connection.stderr();

  const listed = (await mcp.listTools()).tools;
  const tools = listed.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema }));
  console.log(`mode: ${DRY ? 'DRY (scripted model)' : `model ${MODEL}`}${NEGATIVE ? ' / negative' : ''}; ${tools.length} tools; server ${server.url}`);
  console.log(`prompt: ${PROMPT}`);

  const instructions = mcp.getInstructions();
  const model = DRY ? scriptedModel() : await realModel();
  const messages = [{ role: 'user', content: PROMPT }];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
  const calls = [];
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
      output_config: { effort: EFFORT },
      system: `You are helping a user edit a 3D model of their flat through the provided tools. Act directly with the tools; verify visually when you change the look.${instructions ? `\n\nServer instructions:\n${instructions}` : ''}`,
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
      let r;
      try {
        r = await mcp.callTool({ name: u.name, arguments: u.input ?? {} });
      } catch (e) {
        r = { isError: true, content: [{ type: 'text', text: `tool call failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }
      const content = toResultContent(r.content);
      const img = content.find((c) => c.type === 'image');
      if (img && !r.isError) lastImage = img.source.data;
      calls.push({ name: u.name, input: u.input ?? {}, image: Boolean(img), error: Boolean(r.isError) });
      console.log(`  [turn ${turns}] tool ${u.name}${r.isError ? ' -> ERROR' : ''}${img ? ' (image)' : ''}`);
      results.push({ type: 'tool_result', tool_use_id: u.id, content, ...(r.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }

  if (lastImage) {
    writeFileSync(FINAL_PNG, Buffer.from(lastImage, 'base64'));
    console.log(`final render saved to ${FINAL_PNG}`);
  }
  console.log(`usage: ${usage.input} in / ${usage.output} out / ${usage.cacheRead} cache-read / ${usage.cacheWrite} cache-write tokens; estimated cost $${usage.usd.toFixed(4)}${DRY ? ' (dry: no API calls)' : ''}; ${turns} turns, ${toolCalls} tool calls [${calls.map((c) => c.name).join(', ')}]`);

  // ---- Assertions on state ----
  check(!abort, 'the loop finished within its limits', abort ?? '');
  check(finished, 'the model ended its turn (stop_reason end_turn)');
  check(toolCalls <= MAX_TOOL_CALLS && turns <= MAX_TURNS, `at most ${MAX_TOOL_CALLS} tool calls and ${MAX_TURNS} turns`, `${toolCalls} calls, ${turns} turns`);

  const describeRoom = async (roomId) => (await mcp.callTool({ name: 'describe_room', arguments: { roomId } })).structuredContent;
  await assertDemoState({ check, flat, describeRoom, before, historyBefore, calls, lastImage, finalPng: FINAL_PNG, negative: NEGATIVE });
  if (process.env.FLAT_DEMO_VERBOSE) console.log(`mcp stderr:\n${mcpErr()}`);
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
