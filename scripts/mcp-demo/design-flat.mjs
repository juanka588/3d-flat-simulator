#!/usr/bin/env node
/* global process, console, setTimeout, clearTimeout, Buffer, fetch, URL */
/**
 * Whole-flat design session: a fresh `claude -p` (your Claude Code login, no API key) designs the Charme flat in a
 * modern, stylish way through the MCP tools only (walls, floors, lighting, real furniture and decor), against a
 * throwaway apps/server (your own server and its data are not touched). Afterwards it renders every room and saves
 * the resulting scene, so you can open it in the app (Import... or `PUT /api/scene`).
 *
 *   pnpm mcp:demo:design                 # IKEA France (live, personal use) + pasted-url providers
 *   pnpm mcp:demo:design -- --mock       # offline mock catalogue instead of IKEA
 *
 * Output: FLAT_DESIGN_OUT (default /tmp/design-flat): scene.flat.json, renders/*.png, transcript.json, summary.md.
 * Env: FLAT_DESIGN_MAX_USD (default 15), FLAT_DESIGN_TIMEOUT_S (default 3600), FLAT_DEMO_CLI_MODEL, CLAUDE_BIN.
 * Needs `pnpm mcp:setup` (viewer build + Chromium) for render_view.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv, connectLikeClaudeCode, mcpCommand, startServer } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const MOCK = args.has('--mock');
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const OUT = process.env.FLAT_DESIGN_OUT || '/tmp/design-flat';
const MAX_USD = Number(process.env.FLAT_DESIGN_MAX_USD || 15);
const TIMEOUT_MS = Number(process.env.FLAT_DESIGN_TIMEOUT_S || 3600) * 1000;
const FIXTURE = new URL('../../packages/scene/fixtures/charme-3205.flat.json', import.meta.url);

const REQUEST = `You are an interior designer. Redesign this whole apartment (Blanc Nature, Charme 3205: séjour/cuisine,
alcôve, two bedrooms, entrée, salle de bain, WC, balcony) in a modern, stylish, warm-minimal style, as a realistic
upgrade plan for the owner. Use only the flat's MCP tools.

Do, room by room:
- Walls: a coherent palette (soft warm whites, one or two muted accent walls, e.g. sage, clay, greige or deep green);
  paint per room side where it helps. Never touch structural walls' structure, only their finishes.
- Floors: keep the existing grey tiles of the kitchen zone, WC and bathroom (real, fixed) and the parquet elsewhere,
  unless a texture change is clearly better.
- Lighting: a layered plan per room (ceiling: LED downlight grids sized with describe_room's lighting_plan, plus warm
  accent lamps). 2700-3000 K in living spaces and bedrooms.
- Furniture and decor: ONLY real products from search_products/get_product (search in French, e.g. "canapé 3 places",
  "îlot cuisine", "tabouret de bar", "lit 160x200", "table basse", "tapis", "lampadaire", "suspension", "miroir",
  "plante artificielle", "étagère murale"), placed with place_item. The séjour needs a sofa, coffee table, rug, TV unit
  on the TV wall, dining or island seating, lamps and some decor; each bedroom a bed, nightstands, lamps, a rug;
  the alcôve a home office or reading corner; the entrée a slim storage/console and a mirror; the balcony an outdoor set.
- Keep everything locked (placards, kitchen, bathroom fittings, TE cupboard, columns) as it is; keep doors, windows and
  0.8 m walkways clear (validate_layout must be ok for every room).
- Take a checkpoint first. Render rooms as you go (render_view) to check the look and fix what looks wrong.
- Keep the total furniture budget reasonable, around 6000 EUR TTC; finish with get_bill_of_materials.

At the end, reply with a short design brief: the palette, the per-room choices, and the price list with the total.`;

mkdirSync(join(OUT, 'renders'), { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'flat-design-'));
const server = await startServer(dataDir, { FLAT_PROVIDERS: MOCK ? 'mock' : 'ikea-fr,pasted-url', FLAT_ENV_FILE: '/dev/null' });
console.log(`scene server ${server.url} (data ${dataDir}), providers ${MOCK ? 'mock' : 'ikea-fr,pasted-url'}`);
const put = await fetch(`${server.url}/api/scene`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: readFileSync(FIXTURE) });
if (!put.ok) throw new Error(`could not load the fixture: ${put.status} ${await put.text()}`);

const workDir = mkdtempSync(join(tmpdir(), 'flat-design-cli-'));
const { command, args: margs } = mcpCommand();
const configPath = join(workDir, 'flat-mcp.json');
writeFileSync(configPath, JSON.stringify({ mcpServers: { flat: { command, args: margs, env: { FLAT_SERVER_URL: server.url } } } }, null, 2));
const cliArgs = [
  '-p', REQUEST,
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
const started = Date.now();
const child = spawn(CLAUDE, cliArgs, { cwd: workDir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));
const uses = new Map();
const calls = [];
let result;
let buffered = '';
let shot = 0;
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
      if (b.type === 'text' && b.text.trim()) console.log(`  [model] ${b.text.trim().slice(0, 400).replace(/\n/g, ' ')}`);
      if (b.type === 'tool_use') uses.set(b.id, { name: b.name.replace(/^mcp__flat__/, ''), input: b.input ?? {} });
    }
  } else if (ev.type === 'user') {
    for (const b of ev.message?.content ?? []) {
      if (b.type !== 'tool_result') continue;
      const use = uses.get(b.tool_use_id) ?? { name: '?', input: {} };
      const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const img = parts.find((p) => p.type === 'image');
      if (img && !b.is_error) writeFileSync(join(OUT, 'renders', `model-${String(++shot).padStart(2, '0')}.png`), Buffer.from(img.source?.data ?? '', 'base64'));
      calls.push({ name: use.name, input: use.input, error: Boolean(b.is_error), text: text.slice(0, 600) });
      console.log(`  [tool] ${use.name}${b.is_error ? ` -> ERROR ${text.slice(0, 160)}` : ''}${img ? ' (image)' : ''}`);
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
await new Promise((done) => {
  const timer = setTimeout(() => {
    console.log(`claude did not finish within ${TIMEOUT_MS / 1000} s: stopping it`);
    child.kill('SIGTERM');
  }, TIMEOUT_MS);
  child.on('exit', () => {
    clearTimeout(timer);
    done();
  });
});
onLine(buffered);
if (stderr.trim()) console.log(`claude stderr:\n${stderr.trim().slice(-1500)}`);

// The result: the scene, the bill of materials, and our own renders of every room (day and evening).
const scene = await (await fetch(`${server.url}/api/scene`)).json();
writeFileSync(join(OUT, 'scene.flat.json'), JSON.stringify(scene.scene ?? scene, null, 2));
const mcp = await connectLikeClaudeCode({ serverUrl: server.url, clientName: 'design-renders' });
const call = async (name, a) => mcp.client.callTool({ name, arguments: a });
const bom = await call('get_bill_of_materials', {});
const bomText = (bom.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
const views = [
  { file: 'orbit-day', args: { view: 'orbit', preset: 'day' } },
  { file: 'top', args: { view: 'top', preset: 'day' } },
  ...['sejour', 'alcove', 'ch1', 'ch2', 'entree', 'sdb', 'wc', 'balcon'].flatMap((roomId) => [
    { file: `${roomId}-walk-day`, args: { view: 'walk', roomId, preset: 'day' } },
    { file: `${roomId}-walk-evening`, args: { view: 'walk', roomId, preset: 'evening' } },
  ]),
];
for (const v of views) {
  try {
    const r = await call('render_view', v.args);
    const img = (r.content ?? []).find((p) => p.type === 'image');
    if (img) writeFileSync(join(OUT, 'renders', `${v.file}.png`), Buffer.from(img.data, 'base64'));
    else console.log(`render ${v.file}: no image (${JSON.stringify(r.content?.[0] ?? {}).slice(0, 200)})`);
  } catch (e) {
    console.log(`render ${v.file} failed: ${e.message}`);
  }
}
await mcp.close();
await server.stop();

const minutes = ((Date.now() - started) / 60000).toFixed(1);
const summary = [
  `# Design session (${new Date().toISOString()})`,
  `cost $${(result?.total_cost_usd ?? 0).toFixed(2)}, ${result?.num_turns ?? 0} turns, ${calls.length} tool calls (${calls.filter((c) => c.error).length} errors), ${minutes} min`,
  '',
  '## Model brief',
  result?.result ?? '(no final message)',
  '',
  '## Bill of materials',
  bomText,
].join('\n');
writeFileSync(join(OUT, 'summary.md'), summary);
writeFileSync(join(OUT, 'transcript.json'), JSON.stringify(calls, null, 1));
console.log(`\n${summary.slice(0, 4000)}\n\nsaved to ${OUT}`);
