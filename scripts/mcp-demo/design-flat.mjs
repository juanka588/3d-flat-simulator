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
 *   pnpm mcp:demo:design -- --resume .tmp/design-flat/scene.flat.json   # continue a saved design (default brief: finish it)
 *   pnpm mcp:demo:design -- --brief "text"            # replace the request (with --resume: replaces the "continue" brief)
 *   pnpm mcp:demo:design -- --brief "text" --extend   # append it to the default request instead
 *   pnpm mcp:demo:design -- --max-minutes 60 --max-usd 10
 *
 * Styles (apps/mcp/styles, docs/styles.md): the request is the server's own `design_flat_in_style` prompt, fetched with
 * prompts/get and inlined (like furnish-demo does for `furnish_room`).
 *   pnpm mcp:demo:design -- --style scandinavian [--budget 5000] [--brief "extra wishes"]
 *   pnpm mcp:demo:design -- --style japandi --team   # a lead artist delegates room by room to Claude Code subagents
 *   pnpm mcp:demo:design -- --variants french-parisian,scandinavian,brutalist [--team] [--parallel 2]
 * Variants run one session per style, each on its own throwaway server and data dir, sequentially (or --parallel N: they
 * then share your IKEA politeness budget, prefer the local catalogue), all from the same base scene (--resume <scene>, or
 * the fixture; --fresh strips furniture and lights that are not in the fixture). Output: .tmp/design-variants/<style>/ and
 * .tmp/design-variants/compare.md + contact-sheet.png. The cap (--max-usd, --max-minutes) applies to EACH run.
 *   --dry     no model, no cost: a scripted fake session that calls a few tools (use it to test the harness; offline mock providers)
 *
 * Close the gap (CG7, scripts/mcp-demo/close-gap.mjs): per room, a generated reference image, then furnish, score, fix, repeat.
 *   pnpm mcp:demo:design -- --close-gap --style japandi --rooms sejour:living,sejour:kitchen,sdb --iterations 3 [--budget 2500]
 *   --rooms takes room or room:zone (sejour:living, sejour:kitchen); a plain room with several zones is split per zone. Each target has
 *   several views (cameras from the geometry: see describe_room {plan:true}); --views 2 (most per zone) or --views media,wide (ids).
 *   Targets run in order, each starting from the previous result; the chain is saved as <out>/<style>/final-scene.flat.json (and
 *   <target>/scene.flat.json). Start from another scene with --resume <file>.
 *   --publish <url>  opt-in: GET the scene of that server to a backup file in the output folder, then PUT the final scene (PUT /api/scene).
 *   Caps per room: --max-usd (default 8), --max-minutes (default 45); in total: --max-total-usd (default per-room cap x rooms).
 *   Needs the image service (`pnpm imagegen`, CLIP indexes from `pnpm imagegen:index`): checked first, with instructions.
 *   --dry runs it end to end with a scripted fake model, the FakeImageProvider and a fake image service (output .tmp/design-closegap-dry/).
 *   Output: .tmp/design-closegap/<style>/<room>/ (contact-sheet.png, score-curve.png, target.png, gap-report.md, bom.md, final.png, ...).
 *   --force-memory  go on although the image service reports too little free memory (the preflight refuses below ~23 GB available).
 *   --no-render   skip the final renders
 *   --list-styles
 *
 * Output: FLAT_DESIGN_OUT (default .tmp/design-flat): scene.flat.json, renders/*.png, transcript.json, summary.md, result.json, prompt.md.
 * Env: FLAT_DESIGN_MAX_USD (default 20), FLAT_DESIGN_TIMEOUT_MIN (default 90; FLAT_DESIGN_TIMEOUT_S still works), FLAT_DEMO_CLI_MODEL, CLAUDE_BIN.
 * The cap stops claude with SIGINT (it prints its result: cost and turns), then SIGTERM; cost and turns are also summed from the stream events.
 * Needs `pnpm mcp:setup` (viewer build + Chromium) for render_view.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeGapMain, parseRoomSpec, parseViewsArg } from './close-gap.mjs';
import { ROOT, cleanEnv, connectLikeClaudeCode, mcpCommand, startServer } from './lib.mjs';

const argv = process.argv.slice(2);
const args = new Set(argv);
/** Value of `--name value` or `--name=value`. */
const opt = (name) => {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return argv[i].includes('=') ? argv[i].slice(name.length + 1) : argv[i + 1];
};
const MOCK = args.has('--mock');
const DRY = args.has('--dry');
const TEAM = args.has('--team');
const FRESH = args.has('--fresh');
const NO_RENDER = args.has('--no-render');
const RESUME = opt('--resume');
const BRIEF = opt('--brief');
const STYLE = opt('--style');
const VARIANTS = opt('--variants')?.split(',').map((s) => s.trim()).filter(Boolean);
const PARALLEL = Math.max(1, Number(opt('--parallel') || 1));
const BUDGET = opt('--budget');
const CLOSE_GAP = args.has('--close-gap');
const ROOMS_ARG = opt('--rooms')?.split(',').map((x) => x.trim()).filter(Boolean);
const VIEWS_ARG = parseViewsArg(opt('--views'));
const PUBLISH = opt('--publish');
const ITERATIONS = Math.max(1, Math.min(6, Number(opt('--iterations') || 3)));
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
/** The name of Claude Code's subagent tool (`Task` in older versions). */
const AGENT_TOOL = process.env.FLAT_DESIGN_AGENT_TOOL || 'Agent';
const OUT = process.env.FLAT_DESIGN_OUT || join(ROOT, '.tmp/design-flat');
const VARIANTS_OUT = process.env.FLAT_VARIANTS_OUT || join(ROOT, '.tmp/design-variants');
const MAX_USD = Number(opt('--max-usd') || process.env.FLAT_DESIGN_MAX_USD || 20);
const MAX_MIN = Number(opt('--max-minutes') || process.env.FLAT_DESIGN_TIMEOUT_MIN || (process.env.FLAT_DESIGN_TIMEOUT_S ? Number(process.env.FLAT_DESIGN_TIMEOUT_S) / 60 : 90));
const TIMEOUT_MS = MAX_MIN * 60_000;
const FIXTURE = new URL('../../packages/scene/fixtures/charme-3205.flat.json', import.meta.url);
const STYLES_DIR = join(ROOT, 'apps/mcp/styles');
const styleIds = () => readdirSync(STYLES_DIR).filter((f) => f.endsWith('.md') && !f.startsWith('_')).map((f) => f.replace(/\.md$/, '')).sort();

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

const messagesText = (p) => p.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n\n');
const textOf = (r) => (r.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');

/** The fixture's item and light ids: what `--fresh` keeps. */
function stripFurniture(sceneBytes) {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const scene = JSON.parse(sceneBytes.toString('utf8'));
  const items = new Set(fixture.items.map((i) => i.id));
  const lights = new Set(fixture.lights.map((l) => l.id));
  scene.items = (scene.items ?? []).filter((i) => items.has(i.id));
  scene.lights = (scene.lights ?? []).filter((l) => lights.has(l.id));
  return Buffer.from(JSON.stringify(scene));
}

/** One design session (real `claude -p`, or the scripted fake with --dry) on its own throwaway server. Returns a result record. */
async function runSession(o) {
  const tag = o.styleId ? `[${o.styleId}] ` : '';
  const log = (...a) => console.log(tag + a.join(' '));
  const out = o.out;
  mkdirSync(join(out, 'renders'), { recursive: true });
  const providers = o.mock || o.dry ? 'mock' : 'ikea-fr,pasted-url';
  const dataDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'flat-design-'));
  const server = await startServer(dataDir, { FLAT_PROVIDERS: providers, FLAT_ENV_FILE: '/dev/null' });
  log(`scene server ${server.url} (data ${dataDir}), providers ${providers}`);
  let reader;
  try {
    let startScene = o.resume ? readFileSync(o.resume) : readFileSync(FIXTURE);
    if (o.fresh) startScene = stripFurniture(startScene);
    const put = await fetch(`${server.url}/api/scene`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: startScene });
    if (!put.ok) throw new Error(`could not load ${o.resume ?? 'the fixture'}: ${put.status} ${await put.text()}`);
    log(`${o.resume ? `resuming ${o.resume}` : 'starting from the Charme fixture'}${o.fresh ? ' (furniture and extra lights stripped)' : ''}; caps ${MAX_MIN} min, $${MAX_USD}${o.dry ? '; DRY (no model)' : ''}`);

    reader = await connectLikeClaudeCode({ serverUrl: server.url, clientName: 'design-renders' });
    // A render can wait for models and the first one starts the browser: give the MCP request room (its default is 60 s).
    const call = async (name, a) => reader.client.callTool({ name, arguments: a }, { timeout: 300_000 });

    // The request: the server's own prompts (prompts/get, inlined) for a style, else the built-in brief.
    let request;
    let agents; // team mode: { name: { description, prompt, tools } }
    let roles = [];
    if (o.styleId) {
      const budgetArg = o.budget ? { budgetEur: String(o.budget) } : {};
      if (o.team) {
        const lead = await reader.client.getPrompt({ name: 'design_flat_team', arguments: { styleId: o.styleId, ...budgetArg } });
        roles = JSON.parse(((await reader.client.readResource({ uri: 'styles://roles' })).contents[0]).text).filter((r) => r.type === 'specialist');
        agents = {};
        for (const r of roles) {
          const p = await reader.client.getPrompt({ name: 'room_specialist', arguments: { role: r.id, styleId: o.styleId } });
          agents[r.id] = { description: `${r.summary} Give it the roomId, the palette material ids, the budget and a short brief.`, prompt: messagesText(p), tools: r.tools.map((t) => `mcp__flat__${t}`) };
        }
        request = `Use only the flat's MCP tools. Delegate with the ${AGENT_TOOL} tool: subagent_type = the specialist id, and in its prompt the roomId, the palette material ids you defined, the budget and your brief for that room. Start the independent rooms in parallel (one ${AGENT_TOOL} call each, several in one message).\n\n${messagesText(lead)}`;
      } else {
        const notes = [BRIEF, o.resume && !o.fresh ? 'The flat may already hold a design: replace unlocked furniture and finishes that clash with this style.' : ''].filter(Boolean).join(' ');
        const p = await reader.client.getPrompt({ name: 'design_flat_in_style', arguments: { styleId: o.styleId, ...budgetArg, ...(notes ? { notes: notes.slice(0, 500) } : {}) } });
        request = `Use only the flat's MCP tools.\n\n${messagesText(p)}`;
      }
    } else {
      request = BRIEF !== undefined ? (args.has('--extend') ? `${o.resume ? CONTINUE : REQUEST}\n\nAdditional instructions:\n${BRIEF}` : BRIEF) : o.resume ? CONTINUE : REQUEST;
    }
    writeFileSync(join(out, 'prompt.md'), request);
    if (agents) writeFileSync(join(out, 'agents.json'), JSON.stringify(agents, null, 2));

    const started = Date.now();
    const calls = [];
    const agentStats = new Map();
    const stat = (name) => {
      if (!agentStats.has(name)) agentStats.set(name, { calls: 0, errors: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, first: Date.now(), last: Date.now() });
      const s = agentStats.get(name);
      s.last = Date.now();
      return s;
    };
    let result;
    let turns = 0;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    let shot = 0;

    if (o.dry) {
      // A scripted fake session: the calls an obedient lead (and its specialists) would start with. Tests the harness, no model.
      const palette = (await reader.client.readResource({ uri: `styles://${o.styleId ?? 'warm-minimal'}` })).contents[0].text.match(/#[0-9a-fA-F]{6}/g) ?? ['#f1ece3', '#cbbfae', '#9aab94'];
      const run = async (agent, name, a) => {
        const r = await call(name, a);
        const s = stat(agent);
        s.calls++;
        s.turns++;
        if (r.isError) s.errors++;
        calls.push({ agent, name, input: a, error: Boolean(r.isError), text: textOf(r).slice(0, 600) });
        log(`  [${agent}] ${name}${r.isError ? ` -> ERROR ${textOf(r).slice(0, 160)}` : ''}`);
        turns++;
        return r;
      };
      await run('lead', 'get_scene_summary', {});
      await run('lead', 'checkpoint', { name: 'before-dry' });
      await run('lead', 'material_define', { material: { id: 'paint-wall', name: 'Dry wall', kind: 'paint', color: palette[0], roughness: 0.9 } });
      await run('lead', 'material_define', { material: { id: 'paint-accent', name: 'Dry accent', kind: 'paint', color: palette[2] ?? palette[1], roughness: 0.9 } });
      const rooms = ['sejour', 'alcove', 'ch1', 'ch2', 'entree'];
      for (const roomId of rooms) {
        const agent = o.team ? (roles.find((r) => r.rooms.includes(roomId))?.id ?? 'lead') : 'lead';
        await run(agent, 'describe_room', { roomId });
        await run(agent, 'room_set_wall_finish', { roomId, materialId: roomId === 'ch1' || roomId === 'sejour' ? 'paint-accent' : 'paint-wall' });
        await run(agent, 'validate_layout', { roomId });
      }
      const fake = { input_tokens: 1500, output_tokens: 200 };
      for (const [, s] of agentStats) {
        s.input = fake.input_tokens * s.turns;
        s.output = fake.output_tokens * s.turns;
      }
      usage.input = fake.input_tokens * turns;
      usage.output = fake.output_tokens * turns;
      result = { total_cost_usd: 0, num_turns: turns, result: `(dry run: no model was called; ${calls.length} scripted tool calls${o.team ? ' attributed to the specialists by room' : ''})` };
    } else {
      // The real session: claude -p with the flat MCP server (stdio), the MCP tools only (plus the Agent tool for a team lead).
      const workDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'flat-design-cli-'));
      const { command, args: margs } = mcpCommand();
      const configPath = join(workDir, 'flat-mcp.json');
      writeFileSync(configPath, JSON.stringify({ mcpServers: { flat: { command, args: margs, env: { FLAT_SERVER_URL: server.url } } } }, null, 2));
      const agentsPath = join(workDir, 'agents.json');
      if (agents) writeFileSync(agentsPath, JSON.stringify(agents));
      const cliArgs = [
        '-p', request,
        '--mcp-config', configPath,
        '--strict-mcp-config',
        '--allowedTools', 'mcp__flat__*', ...(o.team ? [AGENT_TOOL] : []),
        '--tools', o.team ? AGENT_TOOL : '',
        ...(o.team ? ['--agents', agentsPath] : []),
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
      /** tool_use id of an Agent call -> the subagent it started. */
      const agentOf = new Map();
      const whose = (ev) => (ev.parent_tool_use_id ? (agentOf.get(ev.parent_tool_use_id) ?? 'subagent') : 'lead');
      const seenMessages = new Set();
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
          const agent = whose(ev);
          const s = stat(agent);
          // Sum the usage of every assistant message (a message can be streamed in several events with the same id).
          const mid = ev.message?.id;
          if (!mid || !seenMessages.has(mid)) {
            if (mid) seenMessages.add(mid);
            turns++;
            s.turns++;
            const u = ev.message?.usage ?? {};
            for (const [k, v] of [['input', u.input_tokens], ['output', u.output_tokens], ['cacheRead', u.cache_read_input_tokens], ['cacheCreate', u.cache_creation_input_tokens]]) {
              usage[k] += v ?? 0;
              s[k] += v ?? 0;
            }
          }
          for (const b of ev.message?.content ?? []) {
            if (b.type === 'text' && b.text.trim()) log(`  [${agent}] ${b.text.trim().slice(0, 400).replace(/\n/g, ' ')}`);
            if (b.type === 'tool_use') {
              if (b.name === AGENT_TOOL || b.name === 'Task') agentOf.set(b.id, String(b.input?.subagent_type ?? 'subagent'));
              else uses.set(b.id, { name: b.name.replace(/^mcp__flat__/, ''), input: b.input ?? {}, agent });
            }
          }
        } else if (ev.type === 'user') {
          const agent = whose(ev);
          for (const b of ev.message?.content ?? []) {
            if (b.type !== 'tool_result') continue;
            const use = uses.get(b.tool_use_id);
            if (!use) continue;
            const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
            const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
            const img = parts.find((p) => p.type === 'image');
            if (img && !b.is_error) writeFileSync(join(out, 'renders', `model-${String(++shot).padStart(2, '0')}.png`), Buffer.from(img.source?.data ?? '', 'base64'));
            const s = stat(agent);
            s.calls++;
            if (b.is_error) s.errors++;
            calls.push({ agent, name: use.name, input: use.input, error: Boolean(b.is_error), text: text.slice(0, 600) });
            log(`  [${agent}] ${use.name}${b.is_error ? ` -> ERROR ${text.slice(0, 160)}` : ''}${img ? ' (image)' : ''}`);
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
          log(`claude did not finish within ${MAX_MIN} min: stopping it (SIGINT first, so it prints its result)`);
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
      if (stderr.trim()) log(`claude stderr:\n${stderr.trim().slice(-1500)}`);
    }

    // The result: the scene, the bill of materials, and our own renders of every room (day and evening).
    const scene = await (await fetch(`${server.url}/api/scene`)).json();
    writeFileSync(join(out, 'scene.flat.json'), JSON.stringify(scene.scene ?? scene, null, 2));
    const bom = await call('get_bill_of_materials', {});
    const bomText = textOf(bom);
    const bomJson = bom.structuredContent ?? {};
    writeFileSync(join(out, 'bom.json'), JSON.stringify(bomJson, null, 2));
    const views = [
      { file: 'orbit-day', args: { view: 'orbit', preset: 'day' } },
      { file: 'top', args: { view: 'top', preset: 'day' } },
      ...['sejour', 'alcove', 'ch1', 'ch2', 'entree', 'sdb', 'wc', 'balcon'].flatMap((roomId) => [
        { file: `${roomId}-walk-day`, args: { view: 'walk', roomId, preset: 'day' } },
        { file: `${roomId}-walk-evening`, args: { view: 'walk', roomId, preset: 'evening' } },
      ]),
    ];
    const renderNotes = [];
    const rendered = [];
    if (!o.noRender) {
      // Start the browser and let the shop models download (the server fetches them in the background) before the timed renders.
      try {
        await call('render_view', { view: 'top', preset: 'day', size: { width: 320, height: 240 }, waitForModelsS: o.dry ? 5 : 120 });
      } catch (e) {
        log(`warm-up render failed: ${e.message}`);
      }
      let renderDown = false;
      for (const v of views) {
        if (renderDown) break;
        for (let attempt = 1; attempt <= (o.dry ? 1 : 2); attempt++) {
          try {
            const r = await call('render_view', { ...v.args, waitForModelsS: o.dry ? 5 : attempt === 1 ? 90 : 150 });
            const img = (r.content ?? []).find((p) => p.type === 'image');
            const warnings = r.structuredContent?.warnings ?? [];
            if (img) {
              writeFileSync(join(out, 'renders', `${v.file}.png`), Buffer.from(img.data, 'base64'));
              rendered.push(v.file);
              const placeholders = warnings.filter((w) => /placeholder|stand-in/.test(w));
              if (placeholders.length) renderNotes.push(`${v.file}: ${placeholders.join(' | ')}`);
              break;
            }
            const why = textOf(r);
            log(`render ${v.file} (attempt ${attempt}): no image (${why.slice(0, 200).replace(/\s+/g, ' ')})`);
            if (/render_unavailable/.test(why)) {
              log('renders are unavailable (run `pnpm mcp:setup` for the viewer build and Chromium): skipping the rest');
              renderDown = true;
              break;
            }
            // Rate limited (10 renders a minute): wait what the server says, then try again.
            const wait = /Wait (\d+) ms/.exec(why);
            if (wait) {
              await new Promise((done) => setTimeout(done, Number(wait[1]) + 500));
              attempt--;
            }
          } catch (e) {
            log(`render ${v.file} (attempt ${attempt}) failed: ${e.message}`);
          }
        }
      }
    }

    const minutes = ((Date.now() - started) / 60000).toFixed(1);
    const costUsd = result?.total_cost_usd ?? 0;
    const errors = calls.filter((c) => c.error).length;
    const agentRows = [...agentStats].map(([name, s]) => `| ${name} | ${s.calls} | ${s.errors} | ${s.turns} | ${s.input} | ${s.output} | ${s.cacheRead} | ${((s.last - s.first) / 1000).toFixed(0)} |`);
    const summary = [
      `# Design session${o.styleId ? ` - ${o.styleId}${o.team ? ' (team)' : ''}` : ''} (${new Date().toISOString()})`,
      o.dry
        ? `DRY RUN: no model was called. ${calls.length} scripted tool calls (${errors} errors), ${minutes} min`
        : result
          ? `cost $${costUsd.toFixed(2)}, ${result.num_turns ?? turns} turns, ${calls.length} tool calls (${errors} errors), ${minutes} min`
          : `cost not reported (claude was stopped before it printed its result); summed from the stream: ${turns} assistant turns, tokens in ${usage.input} / out ${usage.output} / cache read ${usage.cacheRead} / cache write ${usage.cacheCreate}, ${calls.length} tool calls (${errors} errors), ${minutes} min`,
      `usage (summed from the stream): ${turns} turns, input ${usage.input}, output ${usage.output}, cache read ${usage.cacheRead}, cache write ${usage.cacheCreate}`,
      ...(o.team || agentStats.size > 1 ? ['', '## Agents', '| agent | tool calls | errors | turns | input tok | output tok | cache read | seconds (first to last event) |', '|---|---|---|---|---|---|---|---|', ...agentRows, '(the cost is reported for the whole session only)'] : []),
      '',
      '## Model brief',
      result?.result ?? '(no final message)',
      ...(renderNotes.length ? ['', '## Renders with placeholders or stand-ins', ...renderNotes] : []),
      '',
      '## Bill of materials',
      bomText,
    ].join('\n');
    writeFileSync(join(out, 'summary.md'), summary);
    writeFileSync(join(out, 'transcript.json'), JSON.stringify(calls, null, 1));
    const record = {
      styleId: o.styleId ?? null,
      team: Boolean(o.team),
      dry: Boolean(o.dry),
      costUsd,
      turns: result?.num_turns ?? turns,
      toolCalls: calls.length,
      errors,
      minutes: Number(minutes),
      totalEur: bomJson.totalEur ?? null,
      itemCount: (bomJson.itemCount ?? 0) - (bomJson.withoutProduct ?? []).filter((i) => i.locked).length,
      rendered,
      out,
      agents: Object.fromEntries([...agentStats].map(([k, v]) => [k, { calls: v.calls, errors: v.errors, turns: v.turns, input: v.input, output: v.output, cacheRead: v.cacheRead, seconds: Math.round((v.last - v.first) / 1000) }])),
    };
    writeFileSync(join(out, 'result.json'), JSON.stringify(record, null, 2));
    log(`\n${summary.slice(0, 1500)}\n\nsaved to ${out}`);
    return record;
  } finally {
    await reader?.close().catch(() => {});
    await server.stop();
  }
}

// ---------------------------------------------------------------------------------------------
// Comparison sheet (variants)
// ---------------------------------------------------------------------------------------------

const ROOMS = ['sejour', 'alcove', 'ch1', 'ch2', 'entree', 'sdb', 'wc', 'balcon'];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function writeComparison(results, outRoot) {
  const ok = results.filter((r) => r.record);
  const money = (n) => (n === null || n === undefined ? 'n/a' : `${Math.round(n)} EUR`);
  const lines = [
    `# Design variants (${new Date().toISOString()})`,
    '',
    `Same base scene${RESUME ? ` (${RESUME})` : ' (the Charme fixture)'}${FRESH ? ', furniture stripped' : ''}; ${TEAM ? 'team mode (lead + specialists)' : 'single artist'}; ${DRY ? 'DRY RUN (no model, no cost)' : `cap $${MAX_USD} / ${MAX_MIN} min per run`}.`,
    '',
    '| style | status | model cost | furniture (BOM, TTC) | items | tool calls | errors | turns | minutes | out |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => (r.record ? `| ${r.styleId} | ok | ${DRY ? 'dry' : `$${r.record.costUsd.toFixed(2)}`} | ${money(r.record.totalEur)} | ${r.record.itemCount} | ${r.record.toolCalls} | ${r.record.errors} | ${r.record.turns} | ${r.record.minutes} | ${r.styleId}/ |` : `| ${r.styleId} | FAILED: ${String(r.error).slice(0, 120)} | | | | | | | | |`)),
    '',
    `Total model cost: ${DRY ? 'dry (none)' : `$${ok.reduce((n, r) => n + r.record.costUsd, 0).toFixed(2)}`}.`,
    '',
    '## Contact sheet',
    '',
    'Same camera per room (walk view, evening) across styles: `contact-sheet.png`.',
    '',
    ...ok.flatMap((r) => [`## ${r.styleId}`, `Summary: \`${r.styleId}/summary.md\`, scene: \`${r.styleId}/scene.flat.json\`, bill of materials: \`${r.styleId}/bom.json\`, renders: \`${r.styleId}/renders/\` (${r.record.rendered.length} images).`, '']),
  ];
  writeFileSync(join(outRoot, 'compare.md'), lines.join('\n'));
  // The contact sheet: rows = rooms, columns = styles, same camera (walk, evening).
  const { default: sharp } = await import('sharp');
  const TW = 320;
  const TH = 240;
  const LABEL_W = 70;
  const HEAD_H = 54;
  const cols = results;
  const W = LABEL_W + cols.length * TW;
  const H = HEAD_H + ROOMS.length * TH;
  const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" font-family="Helvetica, Arial, sans-serif">${body}</svg>`);
  const composites = [];
  cols.forEach((c, ci) => {
    const x = LABEL_W + ci * TW;
    const sub = c.record ? `${DRY ? 'dry run' : `$${c.record.costUsd.toFixed(2)}`} | ${money(c.record.totalEur)} furniture` : 'failed';
    composites.push({ input: svg(TW, HEAD_H, `<rect width="100%" height="100%" fill="#222"/><text x="10" y="24" fill="#fff" font-size="18" font-weight="bold">${esc(c.styleId)}</text><text x="10" y="44" fill="#ccc" font-size="13">${esc(sub)}</text>`), left: x, top: 0 });
  });
  ROOMS.forEach((room, ri) => {
    composites.push({ input: svg(LABEL_W, TH, `<rect width="100%" height="100%" fill="#eee"/><text x="8" y="${TH / 2}" fill="#333" font-size="14">${esc(room)}</text>`), left: 0, top: HEAD_H + ri * TH });
  });
  for (let ci = 0; ci < cols.length; ci++) {
    for (let ri = 0; ri < ROOMS.length; ri++) {
      const file = join(cols[ci].record?.out ?? '', 'renders', `${ROOMS[ri]}-walk-evening.png`);
      let input;
      if (cols[ci].record && existsSync(file)) input = await sharp(file).resize(TW - 4, TH - 4, { fit: 'cover' }).png().toBuffer();
      else input = svg(TW - 4, TH - 4, `<rect width="100%" height="100%" fill="#bbb"/><text x="12" y="${TH / 2}" fill="#555" font-size="14">no render</text>`);
      composites.push({ input, left: LABEL_W + ci * TW + 2, top: HEAD_H + ri * TH + 2 });
    }
  }
  await sharp({ create: { width: W, height: H, channels: 3, background: '#fff' } }).composite(composites).png().toFile(join(outRoot, 'contact-sheet.png'));
  console.log(`comparison: ${join(outRoot, 'compare.md')} and ${join(outRoot, 'contact-sheet.png')}`);
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

if (args.has('--list-styles')) {
  console.log(styleIds().join('\n'));
  process.exit(0);
}
const known = new Set(styleIds());
for (const id of [...(VARIANTS ?? []), ...(STYLE ? [STYLE] : [])]) {
  if (!known.has(id)) {
    console.error(`unknown style "${id}". Available: ${[...known].join(', ')}`);
    process.exit(2);
  }
}
if (TEAM && !STYLE && !VARIANTS) {
  console.error('--team needs --style <id> or --variants a,b,c');
  process.exit(2);
}
if (CLOSE_GAP) {
  const rooms = ROOMS_ARG?.length ? ROOMS_ARG : ['sejour'];
  const known = new Set(ROOMS);
  let unknown;
  try {
    unknown = rooms.filter((r) => !known.has(parseRoomSpec(r).roomId));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (!STYLE) {
    console.error('--close-gap needs --style <id> (see --list-styles)');
    process.exit(2);
  }
  if (unknown.length) {
    console.error(`unknown room(s) ${unknown.join(', ')}. The Charme flat has: ${ROOMS.join(', ')}`);
    process.exit(2);
  }
  const perRoomUsd = Number(opt('--max-usd') || process.env.FLAT_CLOSEGAP_MAX_USD || 8);
  const code = await closeGapMain({
    styleId: STYLE,
    rooms,
    iterations: ITERATIONS,
    budget: BUDGET,
    dry: DRY,
    maxUsd: perRoomUsd,
    maxTotalUsd: opt('--max-total-usd') ? Number(opt('--max-total-usd')) : undefined,
    maxMinutes: Number(opt('--max-minutes') || process.env.FLAT_CLOSEGAP_TIMEOUT_MIN || 45),
    root: process.env.FLAT_CLOSEGAP_OUT,
    claude: CLAUDE,
    skipPrereqs: args.has('--skip-prereqs'),
    forceMemory: args.has('--force-memory'),
    noVisualisation: args.has('--no-visualisation'),
    viewsSpec: VIEWS_ARG,
    resume: RESUME,
    publish: PUBLISH,
    dryRegress: args.has('--dry-regress'),
  });
  process.exit(code);
}

const base = { resume: RESUME, fresh: FRESH, team: TEAM, dry: DRY, mock: MOCK, noRender: NO_RENDER, budget: BUDGET };

if (VARIANTS?.length) {
  mkdirSync(VARIANTS_OUT, { recursive: true });
  console.log(`variants: ${VARIANTS.join(', ')} -> ${VARIANTS_OUT}; ${PARALLEL > 1 ? `${PARALLEL} in parallel` : 'sequential'}; ${DRY ? 'dry (no model, no cost)' : `cap $${MAX_USD} and ${MAX_MIN} min per run, worst case $${(MAX_USD * VARIANTS.length).toFixed(0)} in total`}`);
  if (PARALLEL > 1 && !DRY) {
    console.log(`WARNING: --parallel ${PARALLEL}: ${PARALLEL} sessions search the shop at once. Live IKEA searches are rate-limited and slow (the sessions queue behind each other and the politeness of the live provider is shared); use it only with the local catalogue (pnpm catalog:build)${existsSync(join(ROOT, 'apps/server/local-assets/ikea-fr')) ? '' : ' - NO local catalogue was found at apps/server/local-assets/ikea-fr, so every search would go live: prefer --parallel 1'}.`);
  }
  const results = VARIANTS.map((styleId) => ({ styleId }));
  let next = 0;
  const worker = async () => {
    while (next < results.length) {
      const r = results[next++];
      try {
        r.record = await runSession({ ...base, styleId: r.styleId, out: join(VARIANTS_OUT, r.styleId) });
      } catch (e) {
        r.error = e instanceof Error ? e.message : String(e);
        console.log(`[${r.styleId}] FAILED: ${r.error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, results.length) }, worker));
  await writeComparison(results, VARIANTS_OUT);
  process.exit(results.some((r) => r.error) ? 1 : 0);
} else {
  await runSession({ ...base, styleId: STYLE, out: OUT });
}
