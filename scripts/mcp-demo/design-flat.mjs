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
 *   pnpm mcp:demo:design -- --resume /tmp/design-flat/scene.flat.json   # continue a saved design (default brief: finish it)
 *   pnpm mcp:demo:design -- --brief "text"            # replace the request (with --resume: replaces the "continue" brief)
 *   pnpm mcp:demo:design -- --brief "text" --extend   # append it to the default request instead
 *   pnpm mcp:demo:design -- --max-minutes 60 --max-usd 10
 *
 * Output: FLAT_DESIGN_OUT (default /tmp/design-flat): scene.flat.json, renders/*.png, transcript.json, summary.md.
 * Env: FLAT_DESIGN_MAX_USD (default 20), FLAT_DESIGN_TIMEOUT_MIN (default 90; FLAT_DESIGN_TIMEOUT_S still works), FLAT_DEMO_CLI_MODEL, CLAUDE_BIN.
 * The cap stops claude with SIGINT (it prints its result: cost and turns), then SIGTERM; cost and turns are also summed from the stream events.
 * Needs `pnpm mcp:setup` (viewer build + Chromium) for render_view.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv, connectLikeClaudeCode, mcpCommand, startServer } from './lib.mjs';

const argv = process.argv.slice(2);
const args = new Set(argv);
/** Value of `--name value` or `--name=value`. */
const opt = (name) => {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return argv[i].includes('=') ? argv[i].slice(name.length + 1) : argv[i + 1];
};
const MOCK = args.has('--mock');
const RESUME = opt('--resume');
const BRIEF = opt('--brief');
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const OUT = process.env.FLAT_DESIGN_OUT || '/tmp/design-flat';
const MAX_USD = Number(opt('--max-usd') || process.env.FLAT_DESIGN_MAX_USD || 20);
const MAX_MIN = Number(opt('--max-minutes') || process.env.FLAT_DESIGN_TIMEOUT_MIN || (process.env.FLAT_DESIGN_TIMEOUT_S ? Number(process.env.FLAT_DESIGN_TIMEOUT_S) / 60 : 90));
const TIMEOUT_MS = MAX_MIN * 60_000;
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
- Search the shop one query at a time (parallel searches queue behind each other) and place several products per place_item call.
  Bed frames are drawn with a mattress as a visual dressing that is not bought: say that mattresses are extra.
- Keep the total furniture budget reasonable, around 6000 EUR TTC; finish with get_bill_of_materials.

At the end, reply with a short design brief: the palette, the per-room choices, and the price list with the total.`;

/** The request when continuing a saved design: finish what a first session left out. */
const CONTINUE = `You are an interior designer CONTINUING a design of this apartment (Blanc Nature, Charme 3205) that a first session
left unfinished. The flat already holds the walls, floors, lighting and the main furniture; look first (get_scene_summary,
describe_room of every room, get_bill_of_materials) and keep what is there. Do NOT remove or move placed furniture unless it is a
placeholder box (an item that is a plain box: replace it with a real product) or it breaks validate_layout. Use only the flat's MCP tools.

Finish the flat, room by room:
- Entrée: slim storage (a shoe cabinet or console, 25-35 cm deep), a wall mirror, coat hooks or a coat rack; keep the 0.9 m walkway.
- Balcon: an outdoor set (bistro table and two chairs or a small lounge set) and planters.
- Rugs in the séjour and in both bedrooms (rugs sit under the furniture: tapis).
- Accent lamps: a floor lamp (lampadaire) and table lamps (lampe de table, bedside lamps) that emit light, 2700 K; place them with place_item
  (a lamp comes with its light).
- Plants and decor: plants (real or artificial), vases, picture frames or wall art, cushions and throws.
- Curtains or blinds at the windows and the balcony door, if the shop has them.
- Replace every placeholder box (describe_room items with mesh "placeholder"; the TV unit's TV is existing and locked, leave it).
Keep doors, windows and 0.8 m walkways clear (validate_layout must be ok for every room), keep everything locked as it is, take a
checkpoint first, render rooms as you go, and keep the added furniture budget reasonable (about 2500 EUR TTC more).
Search the shop ONE query at a time (parallel searches queue behind each other), and place several products per place_item call.
Bed frames are drawn with a mattress as a visual dressing that is NOT bought: mention that mattresses must be bought separately.

At the end, reply with a short brief: what you added per room and the updated price list and total (get_bill_of_materials).`;

const request = BRIEF !== undefined ? (args.has('--extend') ? `${RESUME ? CONTINUE : REQUEST}\n\nAdditional instructions:\n${BRIEF}` : BRIEF) : RESUME ? CONTINUE : REQUEST;

mkdirSync(join(OUT, 'renders'), { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'flat-design-'));
const server = await startServer(dataDir, { FLAT_PROVIDERS: MOCK ? 'mock' : 'ikea-fr,pasted-url', FLAT_ENV_FILE: '/dev/null' });
console.log(`scene server ${server.url} (data ${dataDir}), providers ${MOCK ? 'mock' : 'ikea-fr,pasted-url'}`);
const startScene = RESUME ? readFileSync(RESUME) : readFileSync(FIXTURE);
const put = await fetch(`${server.url}/api/scene`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: startScene });
if (!put.ok) throw new Error(`could not load ${RESUME ?? 'the fixture'}: ${put.status} ${await put.text()}`);
console.log(`${RESUME ? `resuming ${RESUME}` : 'starting from the Charme fixture'}; caps ${MAX_MIN} min, $${MAX_USD}`);

const workDir = mkdtempSync(join(tmpdir(), 'flat-design-cli-'));
const { command, args: margs } = mcpCommand();
const configPath = join(workDir, 'flat-mcp.json');
writeFileSync(configPath, JSON.stringify({ mcpServers: { flat: { command, args: margs, env: { FLAT_SERVER_URL: server.url } } } }, null, 2));
const cliArgs = [
  '-p', request,
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
let turns = 0;
const usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
const seenMessages = new Set();
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
    // Sum the usage of every assistant message (a message can be streamed in several events with the same id).
    const mid = ev.message?.id;
    if (!mid || !seenMessages.has(mid)) {
      if (mid) seenMessages.add(mid);
      turns++;
      const u = ev.message?.usage ?? {};
      usage.input += u.input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
      usage.cacheRead += u.cache_read_input_tokens ?? 0;
      usage.cacheCreate += u.cache_creation_input_tokens ?? 0;
    }
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
  let kill;
  const timer = setTimeout(() => {
    console.log(`claude did not finish within ${MAX_MIN} min: stopping it (SIGINT first, so it prints its result)`);
    child.kill('SIGINT');
    kill = setTimeout(() => child.kill('SIGTERM'), 45_000);
  }, TIMEOUT_MS);
  child.on('exit', () => {
    clearTimeout(timer);
    clearTimeout(kill);
    done();
  });
});
onLine(buffered);
if (stderr.trim()) console.log(`claude stderr:\n${stderr.trim().slice(-1500)}`);

// The result: the scene, the bill of materials, and our own renders of every room (day and evening).
const scene = await (await fetch(`${server.url}/api/scene`)).json();
writeFileSync(join(OUT, 'scene.flat.json'), JSON.stringify(scene.scene ?? scene, null, 2));
const mcp = await connectLikeClaudeCode({ serverUrl: server.url, clientName: 'design-renders' });
// A render can wait for models and the first one starts the browser: give the MCP request room (its default is 60 s).
const call = async (name, a) => mcp.client.callTool({ name, arguments: a }, { timeout: 300_000 });
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
const renderNotes = [];
// Start the browser and let the shop models download (the server fetches them in the background) before the timed renders.
try {
  await call('render_view', { view: 'top', preset: 'day', size: { width: 320, height: 240 }, waitForModelsS: 120 });
} catch (e) {
  console.log(`warm-up render failed: ${e.message}`);
}
for (const v of views) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await call('render_view', { ...v.args, waitForModelsS: attempt === 1 ? 90 : 150 });
      const img = (r.content ?? []).find((p) => p.type === 'image');
      const warnings = r.structuredContent?.warnings ?? [];
      if (img) {
        writeFileSync(join(OUT, 'renders', `${v.file}.png`), Buffer.from(img.data, 'base64'));
        const placeholders = warnings.filter((w) => /placeholder|stand-in/.test(w));
        if (placeholders.length) renderNotes.push(`${v.file}: ${placeholders.join(' | ')}`);
        break;
      }
      console.log(`render ${v.file} (attempt ${attempt}): no image (${JSON.stringify(r.content?.[0] ?? {}).slice(0, 200)})`);
    } catch (e) {
      console.log(`render ${v.file} (attempt ${attempt}) failed: ${e.message}`);
    }
  }
}
await mcp.close();
await server.stop();

const minutes = ((Date.now() - started) / 60000).toFixed(1);
const summary = [
  `# Design session (${new Date().toISOString()})`,
  result
    ? `cost $${(result.total_cost_usd ?? 0).toFixed(2)}, ${result.num_turns ?? turns} turns, ${calls.length} tool calls (${calls.filter((c) => c.error).length} errors), ${minutes} min`
    : `cost not reported (claude was stopped before it printed its result); summed from the stream: ${turns} assistant turns, tokens in ${usage.input} / out ${usage.output} / cache read ${usage.cacheRead} / cache write ${usage.cacheCreate}, ${calls.length} tool calls (${calls.filter((c) => c.error).length} errors), ${minutes} min`,
  `usage (summed from the stream): ${turns} turns, input ${usage.input}, output ${usage.output}, cache read ${usage.cacheRead}, cache write ${usage.cacheCreate}`,
  '',
  '## Model brief',
  result?.result ?? '(no final message)',
  ...(renderNotes.length ? ['', '## Renders with placeholders or stand-ins', ...renderNotes] : []),
  '',
  '## Bill of materials',
  bomText,
].join('\n');
writeFileSync(join(OUT, 'summary.md'), summary);
writeFileSync(join(OUT, 'transcript.json'), JSON.stringify(calls, null, 1));
console.log(`\n${summary.slice(0, 4000)}\n\nsaved to ${OUT}`);
