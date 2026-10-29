/* global process, console, setTimeout, clearTimeout, Buffer, fetch, URL, AbortSignal */
/**
 * CG7 runner: `design-flat.mjs --close-gap --style <id> --rooms a,b --iterations N`.
 *
 * One `claude -p` session PER ROOM, each on its own throwaway scene server and its own MCP server process. Why per room and not one
 * session over all rooms:
 *  - the loop is heavy on context (4 reference images, the descriptor, the matches with thumbnails, an image per score): three
 *    rooms in one session would push the first room out of context before the last one starts;
 *  - cost and time caps are per room, so one stubborn room cannot starve the others, and a crashed room does not lose the rest;
 *  - the MCP server keeps the reference jobs and descriptors in memory per process: a session per room cannot mix them up;
 *  - every room gets the same fresh Charme scene, so the rooms are comparable (before/after, across styles).
 *
 * Output per room: `<root>/<style>/<room>/` with references/ (every candidate and the labelled visualisation), target.png (the
 * chosen reference), descriptor.json, before.png, iterations/iter-NN/{render.png,score.json,target.png}, score-curve.png,
 * contact-sheet.png (target | before | each iteration | final), gap-report.{md,json}, bom.{json,md}, final.png (honest render),
 * visualisation.png (labelled), scores.md, summary.md, result.json, transcript.json, prompt.md.
 *
 * `--dry` runs the same pipeline with a scripted fake model, the FakeImageProvider (IMAGE_PROVIDER=fake) and a FAKE image service
 * (colour-histogram "CLIP", made-up aesthetic scores) so the whole harness, the prerequisites check and the scoring path are
 * exercised without a model, a GPU or a cost. Dry output goes to `.tmp/design-closegap-dry/`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, cleanEnv, connectLikeClaudeCode, mcpCommand, startServer } from './lib.mjs';

const FIXTURE = new URL('../../packages/scene/fixtures/charme-3205.flat.json', import.meta.url);
const textOf = (r) => (r.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------------------------

/** What a real run needs, checked before any model money is spent. Returns { problems, warnings, info }. */
export async function checkPrerequisites({ imagegenUrl, token, dry, claude }) {
  const problems = [];
  const warnings = [];
  const info = [];
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const call = async (path, body) => {
    const res = await fetch(`${imagegenUrl}${path}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180_000) });
    let j = {};
    try {
      j = await res.json();
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, j };
  };

  if (!process.env.FLAT_WEB_URL && !existsSync(join(ROOT, 'apps/web/dist/index.html'))) problems.push('The viewer is not built, so renders are impossible. Run `pnpm mcp:setup` (builds apps/web/dist and installs Chromium).');
  if (!dry) {
    const v = spawnSync(claude, ['--version'], { encoding: 'utf8' });
    if (v.error || v.status !== 0) problems.push(`The \`${claude}\` CLI is not available (${v.error?.message ?? `exit ${v.status}`}). Install Claude Code and log in, or set CLAUDE_BIN.`);
    else info.push(`claude ${v.stdout.trim()}`);
  }

  let health;
  try {
    const r = await call('/health');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    health = r.j;
  } catch (e) {
    problems.push(`The image service is not reachable at ${imagegenUrl} (${e.message}). Start it in another terminal with \`pnpm imagegen\` (first time: \`pnpm imagegen:setup --download\`), or set IMAGEGEN_URL / IMAGEGEN_TOKEN.`);
  }
  if (health) {
    info.push(`image service ${imagegenUrl}: backend ${health.backend ?? '?'}${health.gpu?.name ? `, ${health.gpu.name}` : ''}`);
    if (!dry) {
      const usable = (health.models ?? []).some((m) => m.downloaded);
      if (health.ready === false || !usable) problems.push('The image service has no generation model downloaded. Run `pnpm imagegen:setup --download` (about 60 GB) or point IMAGEGEN_HF_HOME at a cache that has them.');
    }
    const clip = health.clip ?? {};
    const hasCatalogFolder = existsSync(join(ROOT, 'apps/server/local-assets/ikea-fr/photos'));
    if (!clip.hd) problems.push('The CLIP index of the HD library is missing. Run `pnpm imagegen:index` (embeds the committed thumbnails, under a second once the CLIP weights are present).');
    if (hasCatalogFolder && !clip.catalog) problems.push('The CLIP index of the local catalogue photos is missing. Run `pnpm imagegen:index` (it reads apps/server/local-assets/ikea-fr/photos; the index stays in that gitignored folder).');
    if (!hasCatalogFolder) warnings.push('There is no local catalogue (apps/server/local-assets/ikea-fr): products come from live shop searches and the picture match covers only the HD library.');
    // CLIP weights: a real embedding, not just an index file
    try {
      const e = await call('/embed', { images: [TINY_PNG] });
      if (!e.ok) problems.push(`The image service cannot embed pictures (${e.j.code ?? e.status}: ${e.j.message ?? ''}). Run \`pnpm imagegen:index --download\` once to fetch the CLIP weights.`);
    } catch (e) {
      problems.push(`The image service did not answer /embed (${e.message}).`);
    }
    try {
      const a = await call('/aesthetic', { images: [TINY_PNG] });
      if (!a.ok) warnings.push(`The aesthetic score will be skipped (${a.j.code ?? a.status}: ${a.j.message ?? ''}). It is optional: start the sidecar once with \`--download\` to fetch the 3 KB predictor and the OpenAI ViT-B/32 weights.`);
      else info.push(`aesthetic predictor: ${a.j.model}`);
    } catch (e) {
      warnings.push(`The aesthetic score will be skipped (${e.message}).`);
    }
  }
  return { problems, warnings, info };
}

// ---------------------------------------------------------------------------------------------
// The FAKE image service of --dry (so the prerequisites check and the scoring path run for real)
// ---------------------------------------------------------------------------------------------

export async function startFakeSidecar() {
  const { default: sharp } = await import('sharp');
  const vec = async (b64) => {
    const raw = await sharp(Buffer.from(b64, 'base64')).resize(4, 4, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const v = [...raw].map((x) => x / 255);
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      try {
        const b = body ? JSON.parse(body) : {};
        if (req.url === '/health') return send(200, { ready: true, backend: 'FAKE (dry run)', models: [{ id: 'qwen-cn', downloaded: true }], clip: { model: 'fake/colour', catalog: { count: 0 }, hd: { count: 0 } } });
        if (req.url === '/embed') return send(200, { ok: true, model: 'fake/colour-histogram', dim: 48, images: await Promise.all((b.images ?? []).map(vec)), texts: [] });
        if (req.url === '/aesthetic') {
          const scores = await Promise.all((b.images ?? []).map(async (i) => 3.5 + 3 * Math.min(1, ((await sharp(Buffer.from(i, 'base64')).stats()).channels[0]?.stdev ?? 0) / 90)));
          return send(200, { ok: true, model: 'fake/contrast', licence: 'FAKE (dry run)', scores });
        }
        if (req.url === '/index/query') return send(200, { ok: true, model: 'fake/colour', results: [], prep: ['plain'] });
        return send(404, { ok: false, code: 'not_found', message: 'no such route' });
      } catch (e) {
        return send(400, { ok: false, code: 'invalid_request', message: String(e) });
      }
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { url, stop: () => new Promise((ok) => srv.close(() => ok())) };
}

// ---------------------------------------------------------------------------------------------
// Dry model: what an obedient model would do, scripted
// ---------------------------------------------------------------------------------------------

const DRY_ITEMS = {
  sejour: [
    { id: 'sofa', category: 'sofa', subtype: '3 seater sofa', box: [180, 380, 620, 640], importance: 5 },
    { id: 'rug', category: 'rug', subtype: 'wool rug', box: [140, 560, 760, 740], importance: 4 },
    { id: 'coffee', category: 'table', subtype: 'coffee table', box: [330, 520, 560, 640], importance: 3 },
    { id: 'lamp', category: 'lamp', subtype: 'floor lamp', box: [700, 220, 790, 600], importance: 2 },
  ],
  sdb: [
    { id: 'tub', category: 'other', subtype: 'freestanding bathtub', box: [60, 420, 520, 640], importance: 5 },
    { id: 'vanity', category: 'drawers', subtype: 'wall-hung vanity', box: [600, 380, 900, 560], importance: 4 },
    { id: 'mirror', category: 'mirror', subtype: 'round mirror', box: [650, 160, 840, 340], importance: 3 },
  ],
  default: [
    { id: 'bed', category: 'bed', subtype: 'double bed', box: [220, 360, 700, 640], importance: 5 },
    { id: 'bedside', category: 'bedside', subtype: 'bedside table', box: [710, 450, 810, 590], importance: 3 },
    { id: 'rug', category: 'rug', subtype: 'wool rug', box: [160, 560, 760, 740], importance: 3 },
    { id: 'lamp', category: 'lamp', subtype: 'table lamp', box: [715, 400, 790, 460], importance: 2 },
  ],
};

function dryDescriptor(roomId, styleName, walls, floor) {
  const items = (DRY_ITEMS[roomId] ?? DRY_ITEMS['default']).map((i) => ({
    ...i,
    colour: 'natural',
    material: 'wood and fabric',
    shape: 'simple lines',
    approxDims: { w: 1.6, d: 0.8, h: 0.8 },
    placementHint: { relation: 'free' },
  }));
  return {
    style: `${styleName} (dry run descriptor)`,
    palette: [
      { hex: walls, role: 'walls', areaPct: 55 },
      { hex: floor, role: 'floor', areaPct: 25 },
    ],
    materials: { floor: 'dry-run floor', walls: 'painted plaster', accents: [] },
    lighting: { mood: 'soft daylight', kelvin: 3500, fixtures: [] },
    items,
    decor: [],
  };
}

async function dryTarget(beforePng, out) {
  const { default: sharp } = await import('sharp');
  const file = join(out, 'dry-target-source.png');
  // A made-up "generated reference": our own baseline view with another palette. Small enough for the tool's inline preview.
  await sharp(beforePng).modulate({ hue: 70, saturation: 1.35, brightness: 1.08 }).resize(640, 480).png({ compressionLevel: 9 }).toFile(file);
  const stats = await sharp(file).stats();
  const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const dom = stats.dominant;
  return { file, walls: hex([dom.r, dom.g, dom.b]), floor: hex(stats.channels.slice(0, 3).map((c) => c.mean * 0.6)) };
}

// ---------------------------------------------------------------------------------------------
// Post-processing: curve, contact sheet, labelled visualisation
// ---------------------------------------------------------------------------------------------

const svgBuf = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" font-family="Helvetica, Arial, sans-serif">${body}</svg>`);

export function readIterations(out) {
  const dir = join(out, 'iterations');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => /^iter-\d+$/.test(d) && existsSync(join(dir, d, 'score.json')))
    .sort()
    .map((d) => ({ dir: join(dir, d), name: d, ...JSON.parse(readFileSync(join(dir, d, 'score.json'), 'utf8')) }));
}

export async function scoreCurve(iters, file, title) {
  const { default: sharp } = await import('sharp');
  const W = 720;
  const H = 420;
  const L = 60;
  const R = 150;
  const T = 50;
  const B = 50;
  const n = Math.max(2, iters.length);
  const x = (i) => L + ((W - L - R) * i) / (n - 1);
  const y = (v) => T + (H - T - B) * (1 - v);
  const series = [
    { key: 'overall', get: (it) => it.overall, color: '#111111', width: 4 },
    { key: 'palette', get: (it) => it.scores?.palette?.score, color: '#d1495b' },
    { key: 'layout', get: (it) => it.scores?.layout?.score, color: '#2e86ab' },
    { key: 'clip', get: (it) => it.scores?.clip?.score, color: '#59a14f' },
    { key: 'aesthetic', get: (it) => it.scores?.aesthetic?.score, color: '#b07aa1' },
  ];
  let body = `<rect width="100%" height="100%" fill="#fff"/><text x="${L}" y="30" font-size="18" font-weight="bold" fill="#222">${esc(title)}</text>`;
  for (let g = 0; g <= 10; g += 2) body += `<line x1="${L}" x2="${W - R}" y1="${y(g / 10)}" y2="${y(g / 10)}" stroke="#e3e3e3"/><text x="${L - 8}" y="${y(g / 10) + 4}" font-size="12" text-anchor="end" fill="#666">${(g / 10).toFixed(1)}</text>`;
  iters.forEach((it, i) => (body += `<text x="${x(i)}" y="${H - B + 22}" font-size="12" text-anchor="middle" fill="#666">iter ${it.iteration ?? i + 1}</text>`));
  series.forEach((s, si) => {
    const pts = iters.map((it, i) => [i, s.get(it)]).filter(([, v]) => typeof v === 'number');
    if (!pts.length) return;
    body += `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}" points="${pts.map(([i, v]) => `${x(i)},${y(v)}`).join(' ')}"/>`;
    for (const [i, v] of pts) body += `<circle cx="${x(i)}" cy="${y(v)}" r="${s.width ? 5 : 3}" fill="${s.color}"/>`;
    body += `<rect x="${W - R + 20}" y="${T + si * 22}" width="14" height="4" fill="${s.color}"/><text x="${W - R + 40}" y="${T + si * 22 + 6}" font-size="13" fill="#333">${s.key}</text>`;
  });
  if (!iters.length) body += `<text x="${W / 2}" y="${H / 2}" font-size="16" text-anchor="middle" fill="#888">no iteration was scored</text>`;
  await sharp(svgBuf(W, H, body)).png().toFile(file);
}

export async function contactSheet({ target, before, iters, final, file }) {
  const { default: sharp } = await import('sharp');
  const TW = 320;
  const TH = 240;
  const CAP = 44;
  const tiles = [
    { label: 'target (AI reference)', sub: 'not a render of this flat', img: target },
    { label: 'before', sub: 'same camera, start of session', img: before },
    ...iters.map((it) => ({ label: `iteration ${it.iteration}`, sub: `overall ${it.overall ?? 'n/a'}`, img: join(it.dir, 'render.png') })),
    ...(final ? [{ label: 'final', sub: 'honest 3D render', img: final }] : []),
  ];
  const composites = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const left = i * TW;
    const input = t.img && existsSync(t.img) ? await sharp(t.img).resize(TW - 4, TH - 4, { fit: 'cover' }).png().toBuffer() : svgBuf(TW - 4, TH - 4, `<rect width="100%" height="100%" fill="#bbb"/><text x="12" y="${TH / 2}" font-size="14" fill="#555">no image</text>`);
    composites.push({ input, left: left + 2, top: CAP + 2 });
    composites.push({ input: svgBuf(TW, CAP, `<rect width="100%" height="100%" fill="#222"/><text x="10" y="20" fill="#fff" font-size="15" font-weight="bold">${esc(t.label)}</text><text x="10" y="37" fill="#ccc" font-size="12">${esc(t.sub)}</text>`), left, top: 0 });
  }
  await sharp({ create: { width: TW * tiles.length, height: TH + CAP, channels: 3, background: '#fff' } }).composite(composites).png().toFile(file);
}

/** The visualisation with its label burned in: it must never be mistaken for the honest render. */
async function labelVisualisation(src, file) {
  const { default: sharp } = await import('sharp');
  const meta = await sharp(src).metadata();
  const w = meta.width ?? 1024;
  const h = meta.height ?? 768;
  const bar = Math.max(28, Math.round(h / 22));
  const label = 'VISUALISATION - AI-edited from our render. Furniture, windows and proportions may differ from the 3D result.';
  await sharp(src)
    .extend({ top: bar, background: '#7a1f1f' })
    .composite([{ input: svgBuf(w, bar, `<rect width="100%" height="100%" fill="#7a1f1f"/><text x="10" y="${Math.round(bar * 0.68)}" fill="#fff" font-size="${Math.round(bar * 0.5)}">${esc(label)}</text>`), left: 0, top: 0 }])
    .png()
    .toFile(file);
}

// ---------------------------------------------------------------------------------------------
// One room
// ---------------------------------------------------------------------------------------------

function findLatest(dir, re) {
  if (!existsSync(dir)) return undefined;
  const hits = readdirSync(dir).filter((f) => re.test(f)).sort();
  return hits.length ? join(dir, hits[hits.length - 1]) : undefined;
}

/** Runs the claude CLI session; returns { result, calls, usage, turns, stderr }. */
async function runClaude({ request, serverUrl, mcpEnv, maxUsd, timeoutMs, claude, log }) {
  const workDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'flat-closegap-cli-'));
  const { command, args: margs } = mcpCommand();
  const configPath = join(workDir, 'flat-mcp.json');
  writeFileSync(configPath, JSON.stringify({ mcpServers: { flat: { command, args: margs, env: { FLAT_SERVER_URL: serverUrl, ...mcpEnv } } } }, null, 2));
  const cliArgs = [
    '-p', request,
    '--mcp-config', configPath,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__flat__*',
    '--tools', '',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-budget-usd', String(maxUsd),
    '--no-session-persistence',
    ...(process.env.FLAT_DEMO_CLI_MODEL ? ['--model', process.env.FLAT_DEMO_CLI_MODEL] : []),
  ];
  const child = spawn(claude, cliArgs, { cwd: workDir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const uses = new Map();
  const calls = [];
  const seen = new Set();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let turns = 0;
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
      const mid = ev.message?.id;
      if (!mid || !seen.has(mid)) {
        if (mid) seen.add(mid);
        turns++;
        const u = ev.message?.usage ?? {};
        usage.input += u.input_tokens ?? 0;
        usage.output += u.output_tokens ?? 0;
        usage.cacheRead += u.cache_read_input_tokens ?? 0;
        usage.cacheCreate += u.cache_creation_input_tokens ?? 0;
      }
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'text' && b.text.trim()) log(`  [model] ${b.text.trim().slice(0, 400).replace(/\n/g, ' ')}`);
        if (b.type === 'tool_use') uses.set(b.id, { name: b.name.replace(/^mcp__flat__/, ''), input: b.input ?? {} });
      }
    } else if (ev.type === 'user') {
      for (const b of ev.message?.content ?? []) {
        if (b.type !== 'tool_result') continue;
        const use = uses.get(b.tool_use_id);
        if (!use) continue;
        const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
        const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        calls.push({ name: use.name, input: use.input, error: Boolean(b.is_error), text: text.slice(0, 600) });
        log(`  ${use.name}${b.is_error ? ` -> ERROR ${text.slice(0, 160)}` : ''}${parts.some((p) => p.type === 'image') ? ' (image)' : ''}`);
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
  let timedOut = false;
  await new Promise((done) => {
    let kill;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`claude did not finish within the time cap: stopping it (SIGINT first, so it prints its result)`);
      child.kill('SIGINT');
      kill = setTimeout(() => child.kill('SIGTERM'), 45_000);
    }, timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      clearTimeout(kill);
      done();
    });
  });
  onLine(buffered);
  if (stderr.trim()) log(`claude stderr:\n${stderr.trim().slice(-1200)}`);
  rmSync(workDir, { recursive: true, force: true });
  return { result, calls, usage, turns, timedOut };
}

/**
 * One room, start to finish. `o`: { styleId, roomId, iterations, budget, dry, out, imagegenUrl, maxUsd, maxMinutes, claude, noVisualisation }.
 * Returns the result record (also written to result.json).
 */
export async function runRoom(o) {
  const log = (...a) => console.log(`[${o.styleId}/${o.roomId}] ${a.join(' ')}`);
  const out = o.out;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'references'), { recursive: true });
  const providers = o.dry ? 'mock' : 'ikea-fr,pasted-url';
  const dataDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'flat-closegap-'));
  const server = await startServer(dataDir, { FLAT_PROVIDERS: providers, FLAT_ENV_FILE: '/dev/null' });
  log(`scene server ${server.url} (data ${dataDir}), providers ${providers}; caps $${o.maxUsd}, ${o.maxMinutes} min; out ${out}`);
  const mcpEnv = { FLAT_DESIGN_OUT: out, IMAGEGEN_URL: o.imagegenUrl, ...(process.env.IMAGEGEN_TOKEN ? { IMAGEGEN_TOKEN: process.env.IMAGEGEN_TOKEN } : {}), ...(process.env.FLAT_SCORE_WEIGHTS ? { FLAT_SCORE_WEIGHTS: process.env.FLAT_SCORE_WEIGHTS } : {}) };
  let reader;
  const started = Date.now();
  try {
    const put = await fetch(`${server.url}/api/scene`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: readFileSync(FIXTURE) });
    if (!put.ok) throw new Error(`could not load the fixture: ${put.status} ${await put.text()}`);

    // This MCP server is the runner's own: the baseline and final renders, the bill of materials and, in a dry run, the whole
    // scripted session go through it. In a real run `claude` starts its own MCP server on the same scene server.
    const dryTargetFile = join(out, 'dry-target-source.png');
    if (o.dry) Object.assign(mcpEnv, { IMAGE_PROVIDER: 'fake', IMAGEGEN_FAKE_IMAGE: dryTargetFile });
    reader = await connectLikeClaudeCode({ serverUrl: server.url, clientName: 'design-renders', env: mcpEnv });
    // A render can wait for models and the first one starts the browser: give the MCP request room (its default is 60 s).
    const call = async (name, a) => reader.client.callTool({ name, arguments: a }, { timeout: 300_000 });

    // The "before": our baseline view of the room, the default walk camera (the one generate_reference uses).
    const base = await call('render_view', { view: 'walk', roomId: o.roomId, preset: 'day', size: { width: 1024, height: 768 }, waitForModelsS: o.dry ? 5 : 120 });
    const baseImg = (base.content ?? []).find((p) => p.type === 'image');
    if (!baseImg) throw new Error(`the baseline render failed: ${textOf(base).slice(0, 300)}`);
    writeFileSync(join(out, 'before.png'), Buffer.from(baseImg.data, 'base64'));
    const dry = o.dry ? await dryTarget(join(out, 'before.png'), out) : undefined;

    // The request: the server's own close_the_gap prompt, inlined (claude -p cannot invoke MCP prompts itself).
    const prompt = await reader.client.getPrompt({ name: 'close_the_gap', arguments: { roomId: o.roomId, styleId: o.styleId, iterations: String(o.iterations), ...(o.budget ? { budgetEur: String(o.budget) } : {}) } });
    const request = `Use only the flat's MCP tools. The design output folder is already set: call gap_report without saveTo. Show nothing but the tools' pictures; you cannot open files.\n\n${prompt.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n\n')}`;
    writeFileSync(join(out, 'prompt.md'), request);

    const calls = [];
    let result;
    let turns = 0;
    let usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    let timedOut = false;
    const dryNotes = [];

    if (o.dry) {
      // ---- a scripted fake model: the calls an obedient model would make, with the controller's stop rule ----
      const run = async (name, a) => {
        const r = await call(name, a);
        calls.push({ name, input: a, error: Boolean(r.isError), text: textOf(r).slice(0, 600) });
        turns++;
        log(`  ${name}${r.isError ? ` -> ERROR ${textOf(r).slice(0, 200)}` : ''}`);
        return r;
      };
      const styleText = (await reader.client.readResource({ uri: `styles://${o.styleId}` })).contents[0].text;
      const stylePalette = styleText.match(/#[0-9a-fA-F]{6}/g) ?? ['#f1ece3'];
      const descriptor = dryDescriptor(o.roomId, o.styleId, dry.walls, dry.floor);
      await run('describe_room', { roomId: o.roomId });
      await run('checkpoint', { name: 'before-close-gap' });
      const gen = await run('generate_reference', { roomId: o.roomId, styleId: o.styleId, n: 2, waitS: 5 });
      const jobId = gen.structuredContent?.jobId;
      if (!jobId) throw new Error(`dry run: generate_reference gave no jobId: ${textOf(gen).slice(0, 300)}`);
      dryNotes.push(`critic pick: image 0 of ${jobId} (the dry run always picks the first)`);
      const rec = await run('record_reference', { jobId, index: 0, descriptor });
      if (rec.isError) throw new Error(`dry run: record_reference failed: ${textOf(rec).slice(0, 400)}`);
      let prev = null;
      let paint = stylePalette[0] ?? '#f1ece3';
      const channel = (hex, c) => parseInt(hex.slice(1 + 2 * c, 3 + 2 * c), 16);
      const toHex = (v) => `#${v.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;
      let lastScore;
      for (let k = 1; k <= o.iterations; k++) {
        if (k > 1) {
          // the critic's fix from the diff list: the walls role differs by (target - ours) in the render; shift the paint by that
          const walls = lastScore?.scores?.palette?.roles?.find((r) => r.role === 'walls');
          if (walls) paint = toHex([0, 1, 2].map((c) => channel(paint, c) + channel(walls.targetHex, c) - channel(walls.oursHex, c)));
        }
        const mid = `cg-wall-${k}`;
        await run('material_define', { material: { id: mid, name: `Close-gap walls ${k}`, kind: 'paint', color: paint, roughness: 0.9 } });
        await run('room_set_wall_finish', { roomId: o.roomId, materialId: mid });
        if (k === 1) {
          // real products where match_reference says good/approx; a CONCEPT shape only for verdict none AND importance 4 or more
          const m = await run('match_reference', { jobId, index: 0, thumbs: false });
          const importance = new Map(descriptor.items.map((d) => [d.id, d.importance]));
          for (const it of m.structuredContent?.items ?? []) {
            let entry;
            if (it.verdict !== 'none' && it.candidates?.[0]?.productId) entry = { productId: it.candidates[0].productId };
            else if (it.verdict === 'none' && (importance.get(it.id) ?? 0) >= 4 && it.suggestGenerator) entry = { concept: true, generator: it.suggestGenerator.generator, params: it.suggestGenerator.params };
            if (!entry) continue;
            const p = await run('place_item', { label: `Dry: ${it.id}`, items: [{ ...entry, roomId: o.roomId, relation: { kind: 'centered_in', roomId: o.roomId } }] });
            if (p.isError) dryNotes.push(`place_item for "${it.id}" was refused in the dry run (${p.structuredContent?.code ?? 'error'}); a real model would pick another spot`);
          }
        }
        await run('validate_layout', { roomId: o.roomId });
        const s = await run('score_against_reference', { jobId, index: 0 });
        lastScore = s.structuredContent;
        const overall = lastScore?.overall;
        if (typeof overall === 'number') {
          if (prev !== null && overall - prev < 0.02) {
            dryNotes.push(`stopped after iteration ${k}: improvement ${(overall - prev).toFixed(3)} < 0.02`);
            break;
          }
          prev = overall;
        }
      }
      await run('gap_report', { jobId, index: 0 });
      await run('get_bill_of_materials', { roomId: o.roomId });
      await run('render_view', { view: 'walk', roomId: o.roomId, preset: 'day' });
      if (!o.noVisualisation) await run('generate_reference', { roomId: o.roomId, styleId: o.styleId, mode: 'visualisation', waitS: 5 });
      result = { total_cost_usd: 0, num_turns: turns, result: `(dry run: no model was called; ${calls.length} scripted tool calls)` };
      usage = { input: 1500 * turns, output: 200 * turns, cacheRead: 0, cacheCreate: 0 };
    } else {
      const r = await runClaude({ request, serverUrl: server.url, mcpEnv, maxUsd: o.maxUsd, timeoutMs: o.maxMinutes * 60_000, claude: o.claude, log });
      ({ result, usage, turns, timedOut } = r);
      calls.push(...r.calls);
    }

    // ---- what the session left behind ----
    const iters = readIterations(out);
    let desc;
    try {
      desc = JSON.parse(readFileSync(join(out, 'descriptor.json'), 'utf8'));
    } catch {
      /* no descriptor recorded */
    }
    const refDir = join(out, 'references');
    const targetFile = desc ? join(refDir, `reference-${desc.jobId}-${desc.index}.png`) : undefined;
    if (targetFile && existsSync(targetFile)) copyFileSync(targetFile, join(out, 'target.png'));

    // the honest final render, from the camera of the reference when there is one
    const pose = iters.at(-1)?.pose;
    let finalFile;
    try {
      const r = await call('render_view', { ...(pose ? { view: 'walk', roomId: o.roomId, pose } : { view: 'walk', roomId: o.roomId }), preset: 'day', size: { width: 1024, height: 768 }, waitForModelsS: o.dry ? 5 : 120 });
      const img = (r.content ?? []).find((p) => p.type === 'image');
      if (img) {
        finalFile = join(out, 'final.png');
        writeFileSync(finalFile, Buffer.from(img.data, 'base64'));
      }
    } catch (e) {
      log(`final render failed: ${e.message}`);
    }

    // the labelled visualisation; when the model skipped it, ask for it here (it needs only our render)
    let visFile = findLatest(refDir, /^visualisation-.*\.png$/);
    if (!visFile && !o.noVisualisation && !timedOut) {
      try {
        log('the model did not make the visualisation: asking for it');
        await call('generate_reference', { roomId: o.roomId, styleId: o.styleId, mode: 'visualisation', waitS: o.dry ? 5 : 240 });
        visFile = findLatest(refDir, /^visualisation-.*\.png$/);
      } catch (e) {
        log(`visualisation failed: ${e.message}`);
      }
    }
    if (visFile) await labelVisualisation(visFile, join(out, 'visualisation.png'));

    // bill of materials (concept items listed apart by the tool) and gap report
    let bomJson = {};
    try {
      const bom = await call('get_bill_of_materials', { roomId: o.roomId });
      bomJson = bom.structuredContent ?? {};
      writeFileSync(join(out, 'bom.json'), JSON.stringify(bomJson, null, 2));
      writeFileSync(join(out, 'bom.md'), `# Bill of materials - ${o.roomId} (${o.styleId})\n\nReal products with their TTC prices; concept shapes (stand-ins, not for sale) are listed apart and not priced.\n\n\`\`\`json\n${JSON.stringify(bomJson, null, 2)}\n\`\`\`\n\n${textOf(bom)}\n`);
    } catch (e) {
      log(`bill of materials failed: ${e.message}`);
    }
    const gapDir = join(out, 'gap-reports');
    if (existsSync(gapDir)) {
      for (const d of readdirSync(gapDir)) {
        if (existsSync(join(gapDir, d, 'gap-report.md'))) {
          copyFileSync(join(gapDir, d, 'gap-report.md'), join(out, 'gap-report.md'));
          copyFileSync(join(gapDir, d, 'gap-report.json'), join(out, 'gap-report.json'));
        }
      }
    }

    await scoreCurve(iters, join(out, 'score-curve.png'), `${o.styleId} / ${o.roomId}: score per iteration`);
    await contactSheet({ target: existsSync(join(out, 'target.png')) ? join(out, 'target.png') : undefined, before: join(out, 'before.png'), iters, final: finalFile, file: join(out, 'contact-sheet.png') });

    const costUsd = result?.total_cost_usd ?? 0;
    const errors = calls.filter((c) => c.error).length;
    const minutes = Number(((Date.now() - started) / 60000).toFixed(1));
    const first = iters[0]?.overall ?? null;
    const last = iters.at(-1)?.overall ?? null;
    const row = (it) => `| ${it.iteration} | ${it.overall ?? 'n/a'} | ${it.scores?.palette?.score ?? '-'} (ΔE ${it.scores?.palette?.meanDeltaE ?? '-'}) | ${it.scores?.layout?.score ?? '-'} | ${it.scores?.clip?.score ?? '-'} | ${it.scores?.aesthetic?.score ?? '-'} | ${it.improvement ?? ''} | ${(it.diff ?? []).slice(0, 3).join('; ')} |`;
    const scoresMd = ['| iter | overall | palette | layout | clip | aesthetic | gain | top diffs |', '|---|---|---|---|---|---|---|---|', ...iters.map(row)].join('\n');
    writeFileSync(join(out, 'scores.md'), `# Scores - ${o.styleId} / ${o.roomId}\n\n${scoresMd}\n\nWeights are renormalised over the metrics that were available (FLAT_SCORE_WEIGHTS; default palette 0.3, layout 0.3, clip 0.3, aesthetic 0.1).\n`);
    const summary = [
      `# Close the gap - ${o.styleId} / ${o.roomId} (${new Date().toISOString()})`,
      o.dry ? `DRY RUN: scripted fake model, FakeImageProvider and a FAKE image service. The numbers and pictures below only prove the harness; they say nothing about quality. ${calls.length} tool calls (${errors} errors), ${minutes} min.` : `cost $${costUsd.toFixed(2)} (cap $${o.maxUsd}), ${turns} turns, ${calls.length} tool calls (${errors} errors), ${minutes} min (cap ${o.maxMinutes})${timedOut ? ' - STOPPED BY THE TIME CAP' : ''}.`,
      '',
      `Overall score: ${first ?? 'n/a'} -> ${last ?? 'n/a'} over ${iters.length} scored iteration(s).`,
      '',
      scoresMd,
      '',
      ...(dryNotes.length ? ['## Dry-run notes', ...dryNotes.map((n) => `- ${n}`), ''] : []),
      '## Files',
      '`contact-sheet.png` (target | before | iterations | final), `score-curve.png`, `target.png`, `descriptor.json`, `gap-report.md`, `bom.md`, `final.png` (honest 3D render), `visualisation.png` (AI-edited, labelled), `references/` (all candidates), `iterations/`.',
      '',
      '## Model brief',
      result?.result ?? '(no final message)',
    ].join('\n');
    writeFileSync(join(out, 'summary.md'), summary);
    writeFileSync(join(out, 'transcript.json'), JSON.stringify(calls, null, 1));
    const record = {
      styleId: o.styleId,
      roomId: o.roomId,
      dry: Boolean(o.dry),
      costUsd,
      turns,
      toolCalls: calls.length,
      errors,
      minutes,
      timedOut,
      tokens: usage,
      iterations: iters.length,
      overall: iters.map((i) => i.overall),
      first,
      last,
      totalEur: bomJson.totalEur ?? null,
      files: { contactSheet: join(out, 'contact-sheet.png'), scoreCurve: join(out, 'score-curve.png'), final: finalFile ?? null, visualisation: visFile ? join(out, 'visualisation.png') : null, target: existsSync(join(out, 'target.png')) ? join(out, 'target.png') : null },
      out,
    };
    writeFileSync(join(out, 'result.json'), JSON.stringify(record, null, 2));
    log(`done: overall ${first ?? 'n/a'} -> ${last ?? 'n/a'}, ${iters.length} iteration(s), ${minutes} min, $${costUsd.toFixed(2)}; ${out}`);
    return record;
  } finally {
    await reader?.close().catch(() => {});
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------

/**
 * `o`: { styleId, rooms[], iterations, budget, dry, maxUsd (per room), maxTotalUsd, maxMinutes (per room), root, claude, skipPrereqs, noVisualisation }.
 * Returns the process exit code.
 */
export async function closeGapMain(o) {
  const dryRoot = join(ROOT, '.tmp/design-closegap-dry');
  const root = o.root || (o.dry ? dryRoot : join(ROOT, '.tmp/design-closegap'));
  let fake;
  let imagegenUrl = (process.env.IMAGEGEN_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '');
  if (o.dry) {
    fake = await startFakeSidecar();
    imagegenUrl = fake.url;
    console.log(`DRY RUN: scripted fake model, FakeImageProvider (IMAGE_PROVIDER=fake) and a FAKE image service at ${fake.url} (colour-histogram embeddings, made-up aesthetic scores). Nothing is generated, nothing costs money.`);
  }
  try {
    if (!o.skipPrereqs) {
      const pre = await checkPrerequisites({ imagegenUrl, token: process.env.IMAGEGEN_TOKEN, dry: o.dry, claude: o.claude });
      for (const i of pre.info) console.log(`ok: ${i}`);
      for (const w of pre.warnings) console.log(`WARNING: ${w}`);
      if (pre.problems.length) {
        console.error(`\nPrerequisites missing (nothing was started, nothing was spent):\n${pre.problems.map((p) => `  - ${p}`).join('\n')}\n\nFix these and run the same command again.`);
        return 3;
      }
    }
    const totalCap = o.maxTotalUsd ?? o.maxUsd * o.rooms.length;
    console.log(`close-gap: style ${o.styleId}, rooms ${o.rooms.join(', ')}, up to ${o.iterations} iteration(s) each; ${o.dry ? 'dry (no model, no cost)' : `caps: $${o.maxUsd} and ${o.maxMinutes} min per room, $${totalCap} in total`}; output ${join(root, o.styleId)}/<room>/`);
    const results = [];
    let spent = 0;
    for (const roomId of o.rooms) {
      const remaining = totalCap - spent;
      if (!o.dry && remaining < 0.5) {
        console.log(`[${o.styleId}/${roomId}] SKIPPED: the total cost cap ($${totalCap}) is used up ($${spent.toFixed(2)})`);
        results.push({ roomId, error: 'skipped: total cost cap reached' });
        continue;
      }
      try {
        const rec = await runRoom({ ...o, roomId, out: join(root, o.styleId, roomId), imagegenUrl, maxUsd: Math.min(o.maxUsd, remaining) });
        spent += rec.costUsd;
        results.push({ roomId, record: rec });
      } catch (e) {
        results.push({ roomId, error: e instanceof Error ? e.message : String(e) });
        console.log(`[${o.styleId}/${roomId}] FAILED: ${results.at(-1).error}`);
      }
    }
    mkdirSync(join(root, o.styleId), { recursive: true });
    const lines = [
      `# Close the gap - ${o.styleId} (${new Date().toISOString()})`,
      o.dry ? 'DRY RUN (scripted model, fake image service): proves the harness only.' : `Caps: $${o.maxUsd} and ${o.maxMinutes} min per room, $${totalCap} total. Spent $${spent.toFixed(2)}.`,
      '',
      '| room | status | overall first -> last | iterations | cost | minutes | furniture (BOM) | contact sheet |',
      '|---|---|---|---|---|---|---|---|',
      ...results.map((r) => (r.record ? `| ${r.roomId} | ok${r.record.timedOut ? ' (time cap)' : ''} | ${r.record.first ?? 'n/a'} -> ${r.record.last ?? 'n/a'} | ${r.record.iterations} | ${o.dry ? 'dry' : `$${r.record.costUsd.toFixed(2)}`} | ${r.record.minutes} | ${r.record.totalEur === null ? 'n/a' : `${Math.round(r.record.totalEur)} EUR`} | ${r.roomId}/contact-sheet.png |` : `| ${r.roomId} | FAILED: ${String(r.error).slice(0, 100)} | | | | | | |`)),
    ];
    writeFileSync(join(root, o.styleId, 'summary.md'), lines.join('\n'));
    console.log(`\n${lines.join('\n')}\n\nsaved to ${join(root, o.styleId)}`);
    return results.some((r) => r.error) ? 1 : 0;
  } finally {
    await fake?.stop();
  }
}

export { sleep };
