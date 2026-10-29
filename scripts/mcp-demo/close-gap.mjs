/* global process, console, setTimeout, clearTimeout, Buffer, fetch, URL, AbortSignal */
/**
 * CG7 runner: `design-flat.mjs --close-gap --style <id> --rooms sejour:living,sejour:kitchen,sdb --iterations N`.
 *
 * A target is a room or a zone of a room (`sejour:kitchen`); a plain room with several zones is split per zone. Each target has
 * several VIEWS (named cameras derived from the geometry: describe_room plan), one reference image and one descriptor per view,
 * scored together (weighted). Targets run in order and each starts from the scene the previous one ended with, so the last scene
 * holds everything: `<root>/<style>/final-scene.flat.json` (and `<target>/scene.flat.json`). The best scored iteration is kept: if
 * the session ends on a worse one, its scene is put back. `--publish <url>` (opt-in) backs up that server's scene and PUTs the final one.
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
import { basename, join } from 'node:path';
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
// Pure helpers (tested in close-gap.test.mjs)
// ---------------------------------------------------------------------------------------------

/** `sejour:kitchen` -> { roomId: 'sejour', zone: 'kitchen' }; `sdb` -> { roomId: 'sdb' }. */
export function parseRoomSpec(s) {
  const [roomId, zone, ...rest] = String(s).trim().split(':');
  if (!roomId || rest.length) throw new Error(`bad room spec "${s}": expected room or room:zone`);
  return { roomId, ...(zone ? { zone } : {}) };
}

/** `--views 2` -> 2 (most per zone); `--views media,wide` -> ['media','wide']; nothing -> undefined (the defaults). */
export function parseViewsArg(s) {
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return Math.max(1, Number(s));
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/** The views to use out of the plan's views: of one zone, limited by count per zone or by ids. Throws on an unknown id. */
export function selectViews(views, { zone, spec } = {}) {
  const inZone = zone ? views.filter((v) => v.zone === zone) : views;
  if (Array.isArray(spec)) {
    const byId = new Map(inZone.map((v) => [v.id, v]));
    const missing = spec.filter((id) => !byId.has(id));
    if (missing.length) throw new Error(`no view ${missing.join(', ')}${zone ? ` in zone ${zone}` : ''}. Views: ${inZone.map((v) => v.id).join(', ')}`);
    return spec.map((id) => byId.get(id));
  }
  if (typeof spec === 'number') {
    const seen = new Map();
    return inZone.filter((v) => {
      const n = (seen.get(v.zone) ?? 0) + 1;
      seen.set(v.zone, n);
      return n <= spec;
    });
  }
  return inZone;
}

/** The best scored iteration (highest overall, the earliest on a tie) and whether the last one is worse. */
export function pickBest(iters) {
  const scored = iters.filter((i) => typeof i.overall === 'number');
  if (!scored.length) return { best: undefined, last: iters.at(-1), regressed: false };
  const best = scored.reduce((a, b) => (b.overall > a.overall ? b : a));
  const last = scored.at(-1);
  return { best, last, regressed: best.name !== last.name };
}

/**
 * Backs up the scene served at `url` (GET /api/scene, the `scene` field, restorable with PUT) into `outDir`, then PUTs `scene`.
 * Never called by default; the lead runs it with --publish.
 */
export async function publishScene({ url, scene, outDir }) {
  const base = new URL(url).origin;
  const got = await fetch(`${base}/api/scene`);
  if (!got.ok) throw new Error(`could not read the current scene from ${base}: HTTP ${got.status}`);
  const current = await got.json();
  mkdirSync(outDir, { recursive: true });
  const backup = join(outDir, `backup-before-publish-${new Date().toISOString().replace(/[:.]/g, '-')}.flat.json`);
  writeFileSync(backup, `${JSON.stringify(current.scene, null, 2)}\n`);
  const put = await fetch(`${base}/api/scene`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: typeof scene === 'string' ? scene : JSON.stringify(scene) });
  const body = await put.text();
  if (!put.ok) throw new Error(`PUT ${base}/api/scene failed: HTTP ${put.status} ${body.slice(0, 300)}`);
  return { backup, base };
}

// ---------------------------------------------------------------------------------------------
// Dry model: what an obedient model would do, scripted
// ---------------------------------------------------------------------------------------------

const LIVING = [
  { id: 'sofa', category: 'sofa', subtype: '3 seater sofa', box: [180, 380, 620, 640], importance: 5 },
  { id: 'rug', category: 'rug', subtype: 'wool rug', box: [140, 560, 760, 740], importance: 4 },
  { id: 'coffee', category: 'table', subtype: 'coffee table', box: [330, 520, 560, 640], importance: 3 },
  { id: 'lamp', category: 'lamp', subtype: 'floor lamp', box: [700, 220, 790, 600], importance: 2 },
];
const DRY_ITEMS = {
  sejour: LIVING,
  'sejour:living': LIVING,
  'sejour:kitchen': [
    { id: 'stool', category: 'chair', subtype: 'bar stool', box: [300, 450, 380, 640], importance: 3 },
    { id: 'pendant', category: 'lamp', subtype: 'pendant lamp', box: [420, 60, 520, 200], importance: 2 },
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

function dryDescriptor(key, roomId, styleName, walls, floor) {
  const items = (DRY_ITEMS[key] ?? DRY_ITEMS[roomId] ?? DRY_ITEMS['default']).map((i) => ({
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
// Post-processing: curve, contact sheets, labelled visualisation
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

/** The picture of our render for a view in an iteration (aggregated scoring keeps one per view). */
export const iterRender = (it, viewId) => {
  const perView = viewId ? join(it.dir, 'views', viewId, 'render.png') : undefined;
  return perView && existsSync(perView) ? perView : join(it.dir, 'render.png');
};

export async function scoreCurve(iters, file, title, bestName) {
  const { default: sharp } = await import('sharp');
  const W = 760;
  const H = 420;
  const L = 60;
  const R = 190;
  const T = 50;
  const B = 50;
  const n = Math.max(2, iters.length);
  const x = (i) => L + ((W - L - R) * i) / (n - 1);
  const y = (v) => T + (H - T - B) * (1 - v);
  const viewIds = [...new Set(iters.flatMap((it) => (it.views ?? []).map((v) => v.view)))];
  const palette = ['#e15759', '#f28e2b', '#76b7b2', '#edc948'];
  const series = [
    { key: 'overall', get: (it) => it.overall, color: '#111111', width: 4 },
    { key: 'palette', get: (it) => it.scores?.palette?.score, color: '#d1495b' },
    { key: 'layout', get: (it) => it.scores?.layout?.score, color: '#2e86ab' },
    { key: 'clip', get: (it) => it.scores?.clip?.score, color: '#59a14f' },
    { key: 'aesthetic', get: (it) => it.scores?.aesthetic?.score, color: '#b07aa1' },
    ...viewIds.map((id, k) => ({ key: `view ${id}`, get: (it) => it.views?.find((v) => v.view === id)?.overall, color: palette[k % palette.length], dash: true })),
  ];
  let body = `<rect width="100%" height="100%" fill="#fff"/><text x="${L}" y="30" font-size="18" font-weight="bold" fill="#222">${esc(title)}</text>`;
  for (let g = 0; g <= 10; g += 2) body += `<line x1="${L}" x2="${W - R}" y1="${y(g / 10)}" y2="${y(g / 10)}" stroke="#e3e3e3"/><text x="${L - 8}" y="${y(g / 10) + 4}" font-size="12" text-anchor="end" fill="#666">${(g / 10).toFixed(1)}</text>`;
  iters.forEach((it, i) => (body += `<text x="${x(i)}" y="${H - B + 22}" font-size="12" text-anchor="middle" fill="#666">iter ${it.iteration ?? i + 1}</text>`));
  series.forEach((s, si) => {
    const pts = iters.map((it, i) => [i, s.get(it)]).filter(([, v]) => typeof v === 'number');
    if (!pts.length) return;
    body += `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}"${s.dash ? ' stroke-dasharray="5 4"' : ''} points="${pts.map(([i, v]) => `${x(i)},${y(v)}`).join(' ')}"/>`;
    for (const [i, v] of pts) body += `<circle cx="${x(i)}" cy="${y(v)}" r="${s.width ? 5 : 3}" fill="${s.color}"/>`;
    body += `<rect x="${W - R + 20}" y="${T + si * 22}" width="14" height="4" fill="${s.color}"/><text x="${W - R + 40}" y="${T + si * 22 + 6}" font-size="13" fill="#333">${esc(s.key)}</text>`;
  });
  const bi = iters.findIndex((it) => it.name === bestName);
  if (bi >= 0 && typeof iters[bi].overall === 'number') body += `<circle cx="${x(bi)}" cy="${y(iters[bi].overall)}" r="11" fill="none" stroke="#e8a200" stroke-width="3"/><text x="${x(bi)}" y="${y(iters[bi].overall) - 16}" font-size="12" text-anchor="middle" fill="#a06d00">best</text>`;
  if (!iters.length) body += `<text x="${W / 2}" y="${H / 2}" font-size="16" text-anchor="middle" fill="#888">no iteration was scored</text>`;
  await sharp(svgBuf(W, H, body)).png().toFile(file);
}

/** Rows of captioned tiles: `rows[i].tiles[j] = { label, sub, img }`. One row per view in the contact sheet. */
export async function contactSheetRows({ rows, file }) {
  const { default: sharp } = await import('sharp');
  const TW = 320;
  const TH = 240;
  const CAP = 44;
  const cols = Math.max(1, ...rows.map((r) => r.tiles.length));
  const composites = [];
  for (let r = 0; r < rows.length; r++) {
    const top = r * (TH + CAP);
    for (let i = 0; i < rows[r].tiles.length; i++) {
      const t = rows[r].tiles[i];
      const left = i * TW;
      const input = t.img && existsSync(t.img) ? await sharp(t.img).resize(TW - 4, TH - 4, { fit: 'cover' }).png().toBuffer() : svgBuf(TW - 4, TH - 4, `<rect width="100%" height="100%" fill="#bbb"/><text x="12" y="${TH / 2}" font-size="14" fill="#555">no image</text>`);
      composites.push({ input, left: left + 2, top: top + CAP + 2 });
      composites.push({ input: svgBuf(TW, CAP, `<rect width="100%" height="100%" fill="#222"/><text x="10" y="20" fill="#fff" font-size="15" font-weight="bold">${esc(t.label)}</text><text x="10" y="37" fill="#ccc" font-size="12">${esc(t.sub ?? '')}</text>`), left, top });
    }
  }
  await sharp({ create: { width: TW * cols, height: (TH + CAP) * Math.max(1, rows.length), channels: 3, background: '#fff' } }).composite(composites).png().toFile(file);
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


// ---------------------------------------------------------------------------------------------
// One target (a room, or a zone of a room)
// ---------------------------------------------------------------------------------------------

const SIZE = { width: 1024, height: 768 };
const walkPose = (v) => ({ mode: 'walk', position: v.eye, eyeHeight: 1.55, headingDeg: v.headingDeg, pitchDeg: 0, fovDeg: v.fovDeg });
const safeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
const jsonIn = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

/**
 * One target, start to finish. `o`: { styleId, roomId, zone?, viewsSpec?, startScene (JSON text), iterations, budget, dry, dryRegress,
 * out, imagegenUrl, maxUsd, maxMinutes, claude, noVisualisation }. Returns the result record (also written to result.json); the
 * final scene is written to `<out>/scene.flat.json` (the best scored iteration).
 */
export async function runRoom(o) {
  const tag = o.zone ? `${o.roomId}:${o.zone}` : o.roomId;
  const log = (...a) => console.log(`[${o.styleId}/${tag}] ${a.join(' ')}`);
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
  const putScene = async (text) => {
    const r = await fetch(`${server.url}/api/scene`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: text });
    if (!r.ok) throw new Error(`could not load the scene: ${r.status} ${await r.text()}`);
  };
  try {
    await putScene(o.startScene);

    const dryTargetFile = join(out, 'dry-target-source.png');
    if (o.dry) Object.assign(mcpEnv, { IMAGE_PROVIDER: 'fake', IMAGEGEN_FAKE_IMAGE: dryTargetFile });
    reader = await connectLikeClaudeCode({ serverUrl: server.url, clientName: 'design-renders', env: mcpEnv });
    const call = async (name, a) => reader.client.callTool({ name, arguments: a }, { timeout: 300_000 });

    // The plan: zones, views (cameras) and the layout intent of the room, from its geometry.
    const planRes = await call('describe_room', { roomId: o.roomId, plan: true });
    const plan = planRes.structuredContent ?? {};
    const views = selectViews(plan.views ?? [], { zone: o.zone, spec: o.viewsSpec });
    if (!views.length) throw new Error(`no views for ${tag}: ${textOf(planRes).slice(0, 300)}`);
    writeFileSync(join(out, 'plan.json'), JSON.stringify({ zones: plan.zones, views, layout: (plan.layout ?? []).filter((l) => !o.zone || l.zone === o.zone) }, null, 2));
    log(`views: ${views.map((v) => `${v.id} (${v.weight})`).join(', ')}`);

    const render = async (v, file) => {
      const r = await call('render_view', { view: 'walk', roomId: o.roomId, pose: walkPose(v), preset: 'day', size: SIZE, waitForModelsS: o.dry ? 5 : 120 });
      const img = (r.content ?? []).find((p) => p.type === 'image');
      if (!img) throw new Error(`render of view ${v.id} failed: ${textOf(r).slice(0, 300)}`);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, Buffer.from(img.data, 'base64'));
      return file;
    };
    const hero = views[0];
    // The "before": our baseline from each view's camera.
    for (const v of views) await render(v, join(out, 'views', v.id, 'before.png'));
    copyFileSync(join(out, 'views', hero.id, 'before.png'), join(out, 'before.png'));
    await contactSheetRows({
      rows: [{ tiles: views.map((v) => ({ label: `${v.id}${v.hero ? ' (hero)' : ''}`, sub: `${v.zone}, weight ${v.weight}, heading ${Math.round(v.headingDeg)}`, img: join(out, 'views', v.id, 'before.png') })) }],
      file: join(out, 'views-contact-sheet.png'),
    });
    const dry = o.dry ? await dryTarget(join(out, 'before.png'), out) : undefined;

    const prompt = await reader.client.getPrompt({ name: 'close_the_gap', arguments: { roomId: o.roomId, styleId: o.styleId, iterations: String(o.iterations), ...(o.zone ? { zone: o.zone } : {}), ...(o.budget ? { budgetEur: String(o.budget) } : {}) } });
    const restrict = o.viewsSpec ? `\n\nUse only these views of the zone: ${views.map((v) => v.id).join(', ')} (the first is the hero).` : '';
    const request = `Use only the flat's MCP tools. The design output folder is already set: call gap_report without saveTo. Show nothing but the tools' pictures; you cannot open files.\n\n${prompt.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n\n')}${restrict}`;
    writeFileSync(join(out, 'prompt.md'), request);

    const calls = [];
    let result;
    let turns = 0;
    let usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    let timedOut = false;
    const dryNotes = [];

    if (o.dry) {
      // ---- a scripted fake model: the calls an obedient model would make, with the controller's rules ----
      const run = async (name, a) => {
        let r = await call(name, a);
        // the per-minute render limit is real: a fake model that is much faster than a real one waits and retries, as the hint says
        for (let t = 0; t < 6 && r.isError && r.structuredContent?.code === 'rate_limited'; t++) {
          await sleep((r.structuredContent.retryAfterMs ?? 3000) + 200);
          r = await call(name, a);
        }
        calls.push({ name, input: a, error: Boolean(r.isError), text: textOf(r).slice(0, 600) });
        turns++;
        log(`  ${name}${r.isError ? ` -> ERROR ${textOf(r).slice(0, 200)}` : ''}`);
        return r;
      };
      const styleText = (await reader.client.readResource({ uri: `styles://${o.styleId}` })).contents[0].text;
      const stylePalette = styleText.match(/#[0-9a-fA-F]{6}/g) ?? ['#f1ece3'];
      await run('checkpoint', { name: 'before-close-gap' });
      const jobs = [];
      for (const v of views) {
        const gen = await run('generate_reference', { roomId: o.roomId, styleId: o.styleId, view: v.id, n: v === hero ? 2 : 1, waitS: 5, seed: 1 });
        const jobId = gen.structuredContent?.jobId;
        if (!jobId) throw new Error(`dry run: generate_reference gave no jobId for ${v.id}: ${textOf(gen).slice(0, 300)}`);
        const descriptor = dryDescriptor(tag, o.roomId, o.styleId, dry.walls, dry.floor);
        const rec = await run('record_reference', { jobId, index: 0, descriptor });
        if (rec.isError) throw new Error(`dry run: record_reference failed for ${v.id}: ${textOf(rec).slice(0, 400)}`);
        jobs.push({ view: v, jobId, descriptor });
      }
      const heroJob = jobs[0];
      let paint = stylePalette[0] ?? '#f1ece3';
      const channel = (hex, c) => parseInt(hex.slice(1 + 2 * c, 3 + 2 * c), 16);
      const toHex = (vv) => `#${vv.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;
      let best = -Infinity;
      let weakGains = 0;
      for (let k = 1; k <= o.iterations; k++) {
        if (k > 1) {
          const last = readIterations(out).at(-1);
          const walls = (last?.views?.[0]?.scores ?? last?.scores)?.palette?.roles?.find((r) => r.role === 'walls');
          if (walls) paint = toHex([0, 1, 2].map((c) => channel(paint, c) + channel(walls.targetHex, c) - channel(walls.oursHex, c)));
        }
        const regress = o.dryRegress && k === o.iterations && k > 1;
        if (regress) paint = '#ff0000';
        const mid = `cg-wall-${k}`;
        await run('material_define', { material: { id: mid, name: `Close-gap walls ${k}`, kind: 'paint', color: paint, roughness: 0.9 } });
        await run('room_set_wall_finish', { roomId: o.roomId, materialId: mid });
        if (k === 1) {
          const m = await run('match_reference', { jobId: heroJob.jobId, index: 0, thumbs: false });
          const importance = new Map(heroJob.descriptor.items.map((d) => [d.id, d.importance]));
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
        const s = await run('score_against_reference', { jobId: heroJob.jobId, index: 0, all: true });
        const overall = s.structuredContent?.overall;
        if (typeof overall !== 'number') continue;
        if (overall > best) {
          weakGains = best > -Infinity && overall - best < 0.02 ? weakGains + 1 : 0;
          best = overall;
          await run('checkpoint', { name: 'cg-best', replace: true });
        } else {
          weakGains++;
          if (regress) dryNotes.push(`iteration ${k} was made worse on purpose (--dry-regress) and NOT reverted by the fake model: the runner must put the best iteration back`);
          else {
            dryNotes.push(`iteration ${k} scored ${overall} below the best ${best}: restore_checkpoint cg-best`);
            await run('restore_checkpoint', { name: 'cg-best' });
          }
        }
        if (weakGains >= 2) {
          dryNotes.push(`stopped after iteration ${k}: under 0.02 over the best twice in a row`);
          break;
        }
        if (overall >= 0.85) break;
      }
      for (const j of jobs) await run('gap_report', { jobId: j.jobId, index: 0 });
      await run('get_bill_of_materials', { roomId: o.roomId });
      await run('render_view', { view: 'walk', roomId: o.roomId, pose: walkPose(hero), preset: 'day' });
      if (!o.noVisualisation) await run('generate_reference', { roomId: o.roomId, styleId: o.styleId, mode: 'visualisation', view: hero.id, waitS: 5 });
      result = { total_cost_usd: 0, num_turns: turns, result: `(dry run: no model was called; ${calls.length} scripted tool calls)` };
      usage = { input: 1500 * turns, output: 200 * turns, cacheRead: 0, cacheCreate: 0 };
    } else {
      const r = await runClaude({ request, serverUrl: server.url, mcpEnv, maxUsd: o.maxUsd, timeoutMs: o.maxMinutes * 60_000, claude: o.claude, log });
      ({ result, usage, turns, timedOut } = r);
      calls.push(...r.calls);
    }

    // ---- keep the best scored iteration: put its scene back when the session ended on something worse (or on unscored changes) ----
    const iters = readIterations(out);
    const { best, last, regressed } = pickBest(iters);
    let restored;
    try {
      const cur = await (await fetch(`${server.url}/api/scene`)).json();
      const snap = best ? join(best.dir, 'scene.flat.json') : undefined;
      if (best && snap && existsSync(snap) && (regressed || (best.rev !== undefined && cur.rev !== best.rev))) {
        await putScene(readFileSync(snap, 'utf8'));
        restored = { from: last?.name, to: best.name, overall: best.overall, lastOverall: last?.overall, why: regressed ? 'the last scored iteration is worse than the best' : 'the scene changed after the best score' };
        log(`kept the best iteration: put ${best.name} (${best.overall}) back instead of ${last?.name} (${last?.overall}) - ${restored.why}`);
      }
    } catch (e) {
      log(`could not check or restore the best iteration: ${e.message}`);
    }
    let sceneFile;
    try {
      const cur = await (await fetch(`${server.url}/api/scene`)).json();
      sceneFile = join(out, 'scene.flat.json');
      writeFileSync(sceneFile, `${JSON.stringify(cur.scene, null, 2)}\n`);
    } catch (e) {
      log(`could not save the final scene: ${e.message}`);
    }

    // ---- what the session left behind, per view ----
    const refDir = join(out, 'references');
    const targets = {};
    for (const v of views) {
      const d = jsonIn(join(out, 'views', `${v.id}.descriptor.json`)) ?? (views.length === 1 ? jsonIn(join(out, 'descriptor.json')) : undefined);
      if (!d) continue;
      targets[v.id] = d;
      const f = join(refDir, `reference-${d.jobId}-${d.index}.png`);
      if (existsSync(f)) copyFileSync(f, join(out, 'views', v.id, 'target.png'));
    }
    if (existsSync(join(out, 'views', hero.id, 'target.png'))) copyFileSync(join(out, 'views', hero.id, 'target.png'), join(out, 'target.png'));

    // honest final renders from each view's camera
    const finals = {};
    for (const v of views) {
      try {
        finals[v.id] = await render(v, join(out, 'views', v.id, 'final.png'));
      } catch (e) {
        log(`final render of ${v.id} failed: ${e.message}`);
      }
    }
    if (finals[hero.id]) copyFileSync(finals[hero.id], join(out, 'final.png'));

    let visFile = findLatest(refDir, /^visualisation-.*\.png$/);
    if (!visFile && !o.noVisualisation && !timedOut) {
      try {
        log('the model did not make the visualisation: asking for it');
        await call('generate_reference', { roomId: o.roomId, styleId: o.styleId, mode: 'visualisation', view: hero.id, waitS: o.dry ? 5 : 240 });
        visFile = findLatest(refDir, /^visualisation-.*\.png$/);
      } catch (e) {
        log(`visualisation failed: ${e.message}`);
      }
    }
    if (visFile) await labelVisualisation(visFile, join(out, 'visualisation.png'));

    let bomJson = {};
    try {
      const bom = await call('get_bill_of_materials', { roomId: o.roomId });
      bomJson = bom.structuredContent ?? {};
      writeFileSync(join(out, 'bom.json'), JSON.stringify(bomJson, null, 2));
      writeFileSync(join(out, 'bom.md'), `# Bill of materials - ${tag} (${o.styleId})\n\nReal products with their TTC prices; concept shapes (stand-ins, not for sale) are listed apart and not priced.\n\n\`\`\`json\n${JSON.stringify(bomJson, null, 2)}\n\`\`\`\n\n${textOf(bom)}\n`);
    } catch (e) {
      log(`bill of materials failed: ${e.message}`);
    }

    // gap reports: one per view (per reference job), merged into one file with a section per view
    const gapDir = join(out, 'gap-reports');
    const gapJson = {};
    const gapMd = [];
    for (const v of views) {
      const d = targets[v.id];
      const dir = d ? join(gapDir, `${d.jobId}-${d.index}`) : undefined;
      if (!dir || !existsSync(join(dir, 'gap-report.md'))) continue;
      gapJson[v.id] = jsonIn(join(dir, 'gap-report.json'));
      gapMd.push(`## View ${v.id} (${v.label}, weight ${v.weight})\n\n${readFileSync(join(dir, 'gap-report.md'), 'utf8')}`);
    }
    if (gapMd.length) {
      writeFileSync(join(out, 'gap-report.md'), `# Gap report - ${tag} (${o.styleId})\n\n${gapMd.join('\n\n')}\n`);
      writeFileSync(join(out, 'gap-report.json'), `${JSON.stringify({ views: gapJson }, null, 2)}\n`);
    }

    await scoreCurve(iters, join(out, 'score-curve.png'), `${o.styleId} / ${tag}: score per iteration`, best?.name);
    await contactSheetRows({
      rows: views.map((v) => ({
        tiles: [
          { label: `${v.id}: target`, sub: 'AI reference, not a render', img: join(out, 'views', v.id, 'target.png') },
          { label: `${v.id}: before`, sub: 'same camera, start', img: join(out, 'views', v.id, 'before.png') },
          ...iters.map((it) => ({ label: `iteration ${it.iteration}${it.name === best?.name ? ' (best)' : ''}`, sub: `${v.id} ${it.views?.find((x) => x.view === v.id)?.overall ?? it.overall ?? 'n/a'}, all ${it.overall ?? 'n/a'}`, img: iterRender(it, v.id) })),
          { label: `${v.id}: final`, sub: restored ? `honest 3D render (best iteration kept)` : 'honest 3D render', img: finals[v.id] },
        ],
      })),
      file: join(out, 'contact-sheet.png'),
    });

    const costUsd = result?.total_cost_usd ?? 0;
    const errors = calls.filter((c) => c.error).length;
    const minutes = Number(((Date.now() - started) / 60000).toFixed(1));
    const first = iters[0]?.overall ?? null;
    const lastOverall = iters.at(-1)?.overall ?? null;
    const viewIds = views.map((v) => v.id);
    const row = (it) => `| ${it.iteration}${it.name === best?.name ? ' (best)' : ''} | ${it.overall ?? 'n/a'} | ${viewIds.map((id) => it.views?.find((x) => x.view === id)?.overall ?? '-').join(' | ')} | ${it.scores?.palette?.score ?? '-'} | ${it.scores?.layout?.score ?? '-'} | ${it.scores?.clip?.score ?? '-'} | ${it.scores?.aesthetic?.score ?? '-'} | ${(it.diff ?? []).slice(0, 3).join('; ')} |`;
    const scoresMd = [`| iter | overall | ${viewIds.join(' | ')} | palette | layout | clip | aesthetic | top diffs |`, `|---|---|${viewIds.map(() => '---|').join('')}---|---|---|---|---|`, ...iters.map(row)].join('\n');
    writeFileSync(join(out, 'scores.md'), `# Scores - ${o.styleId} / ${tag}\n\n${scoresMd}\n\nOverall is the weighted mean of the views (${views.map((v) => `${v.id} ${v.weight}`).join(', ')}); metric weights are renormalised over the metrics that were available (FLAT_SCORE_WEIGHTS; default palette 0.3, layout 0.3, clip 0.3, aesthetic 0.1).\n${restored ? `\nThe session ended on ${restored.from} (${restored.lastOverall}); ${restored.to} (${restored.overall}) was better and is the scene kept (${restored.why}).\n` : ''}`);
    const summary = [
      `# Close the gap - ${o.styleId} / ${tag} (${new Date().toISOString()})`,
      o.dry ? `DRY RUN: scripted fake model, FakeImageProvider and a FAKE image service. The numbers and pictures below only prove the harness; they say nothing about quality. ${calls.length} tool calls (${errors} errors), ${minutes} min.` : `cost $${costUsd.toFixed(2)} (cap $${o.maxUsd}), ${turns} turns, ${calls.length} tool calls (${errors} errors), ${minutes} min (cap ${o.maxMinutes})${timedOut ? ' - STOPPED BY THE TIME CAP' : ''}.`,
      '',
      `Views: ${views.map((v) => `${v.id} (${v.label}, weight ${v.weight})`).join('; ')}.`,
      `Overall score: ${first ?? 'n/a'} -> ${lastOverall ?? 'n/a'} over ${iters.length} scored iteration(s); best ${best ? `${best.name} (${best.overall})` : 'n/a'}.${restored ? ` Restored the best: ${restored.why}.` : ''}`,
      '',
      scoresMd,
      '',
      ...(dryNotes.length ? ['## Dry-run notes', ...dryNotes.map((n) => `- ${n}`), ''] : []),
      '## Files',
      '`contact-sheet.png` (one row per view: target | before | iterations | final), `views-contact-sheet.png` (the cameras), `score-curve.png`, `plan.json` (zones, views, layout intent), `scene.flat.json` (final scene of this target), `views/<view>/{before,target,final}.png`, `target.png` (hero), `descriptor.json`, `gap-report.md`, `bom.md`, `final.png`, `visualisation.png` (AI-edited, labelled), `references/`, `iterations/` (each with the scene that was scored).',
      '',
      '## Model brief',
      result?.result ?? '(no final message)',
    ].join('\n');
    writeFileSync(join(out, 'summary.md'), summary);
    writeFileSync(join(out, 'transcript.json'), JSON.stringify(calls, null, 1));
    const record = {
      styleId: o.styleId,
      roomId: o.roomId,
      ...(o.zone ? { zone: o.zone } : {}),
      dry: Boolean(o.dry),
      views: views.map((v) => ({ id: v.id, zone: v.zone, label: v.label, weight: v.weight })),
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
      last: lastOverall,
      best: best ? { iteration: best.name, overall: best.overall } : null,
      restored: restored ?? null,
      totalEur: bomJson.totalEur ?? null,
      sceneFile: sceneFile ?? null,
      files: { contactSheet: join(out, 'contact-sheet.png'), viewsSheet: join(out, 'views-contact-sheet.png'), scoreCurve: join(out, 'score-curve.png'), final: existsSync(join(out, 'final.png')) ? join(out, 'final.png') : null, visualisation: visFile ? join(out, 'visualisation.png') : null, target: existsSync(join(out, 'target.png')) ? join(out, 'target.png') : null },
      out,
    };
    writeFileSync(join(out, 'result.json'), JSON.stringify(record, null, 2));
    log(`done: overall ${first ?? 'n/a'} -> ${lastOverall ?? 'n/a'} (best ${best?.overall ?? 'n/a'}), ${iters.length} iteration(s), ${minutes} min, $${costUsd.toFixed(2)}; ${out}`);
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

/** A plain room name that has several zones (séjour: living + kitchen) becomes one target per zone. Uses a short-lived scene server. */
async function expandTargets(specs, startScene, imagegenUrl) {
  if (!specs.some((s) => !s.zone)) return specs;
  const dataDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'flat-closegap-plan-'));
  const server = await startServer(dataDir, { FLAT_PROVIDERS: 'mock', FLAT_ENV_FILE: '/dev/null' });
  let reader;
  try {
    const put = await fetch(`${server.url}/api/scene`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: startScene });
    if (!put.ok) throw new Error(`could not load the scene: ${put.status}`);
    reader = await connectLikeClaudeCode({ serverUrl: server.url, clientName: 'design-plan', env: { IMAGEGEN_URL: imagegenUrl } });
    const out = [];
    for (const s of specs) {
      if (s.zone) {
        out.push(s);
        continue;
      }
      const r = await reader.client.callTool({ name: 'describe_room', arguments: { roomId: s.roomId, plan: true } });
      if (r.isError) throw new Error(`unknown room "${s.roomId}": ${textOf(r).slice(0, 200)}`);
      const zones = (r.structuredContent?.zones ?? []).map((z) => z.id);
      if (zones.length > 1) out.push(...zones.map((zone) => ({ roomId: s.roomId, zone })));
      else out.push(s);
    }
    return out;
  } finally {
    await reader?.close().catch(() => {});
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * `o`: { styleId, rooms[] (strings room or room:zone), viewsSpec, iterations, budget, dry, dryRegress, maxUsd (per target), maxTotalUsd, maxMinutes (per target),
 * root, claude, skipPrereqs, noVisualisation, resume (scene file to start from), publish (url) }. Targets run in order, each starting from the
 * previous one's final scene, so the last scene holds all of them. Returns the process exit code.
 */
export async function closeGapMain(o) {
  const dryRoot = join(ROOT, '.tmp/design-closegap-dry');
  const root = o.root || (o.dry ? dryRoot : join(ROOT, '.tmp/design-closegap'));
  const styleDir = join(root, o.styleId);
  let fake;
  let imagegenUrl = (process.env.IMAGEGEN_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '');
  if (o.dry) {
    fake = await startFakeSidecar();
    imagegenUrl = fake.url;
    console.log(`DRY RUN: scripted fake model, FakeImageProvider (IMAGE_PROVIDER=fake) and a FAKE image service at ${fake.url} (colour-histogram embeddings, made-up aesthetic scores). Nothing is generated, nothing costs money.`);
  }
  try {
    if (o.publish && o.dry) {
      console.error('--publish is refused in a dry run (the scene is not a real design).');
      return 2;
    }
    if (!o.skipPrereqs) {
      const pre = await checkPrerequisites({ imagegenUrl, token: process.env.IMAGEGEN_TOKEN, dry: o.dry, claude: o.claude });
      for (const i of pre.info) console.log(`ok: ${i}`);
      for (const w of pre.warnings) console.log(`WARNING: ${w}`);
      if (pre.problems.length) {
        console.error(`\nPrerequisites missing (nothing was started, nothing was spent):\n${pre.problems.map((p) => `  - ${p}`).join('\n')}\n\nFix these and run the same command again.`);
        return 3;
      }
    }
    let scene = readFileSync(o.resume ? o.resume : FIXTURE, 'utf8');
    const targets = await expandTargets(o.rooms.map(parseRoomSpec), scene, imagegenUrl);
    const label = (t) => (t.zone ? `${t.roomId}:${t.zone}` : t.roomId);
    const totalCap = o.maxTotalUsd ?? o.maxUsd * targets.length;
    console.log(`close-gap: style ${o.styleId}, targets ${targets.map(label).join(', ')}, up to ${o.iterations} iteration(s) each, views ${o.viewsSpec === undefined ? 'auto' : Array.isArray(o.viewsSpec) ? o.viewsSpec.join(',') : `${o.viewsSpec} per zone`}; ${o.dry ? 'dry (no model, no cost)' : `caps: $${o.maxUsd} and ${o.maxMinutes} min per target, $${totalCap} in total`}; each target starts from the previous result; output ${styleDir}/<target>/`);
    const results = [];
    let spent = 0;
    for (const t of targets) {
      const remaining = totalCap - spent;
      if (!o.dry && remaining < 0.5) {
        console.log(`[${o.styleId}/${label(t)}] SKIPPED: the total cost cap ($${totalCap}) is used up ($${spent.toFixed(2)})`);
        results.push({ target: label(t), error: 'skipped: total cost cap reached' });
        continue;
      }
      try {
        const rec = await runRoom({ ...o, ...t, startScene: scene, out: join(styleDir, safeName(t.zone ? `${t.roomId}-${t.zone}` : t.roomId)), imagegenUrl, maxUsd: Math.min(o.maxUsd, remaining) });
        spent += rec.costUsd;
        results.push({ target: label(t), record: rec });
        if (rec.sceneFile) scene = readFileSync(rec.sceneFile, 'utf8');
      } catch (e) {
        results.push({ target: label(t), error: e instanceof Error ? e.message : String(e) });
        console.log(`[${o.styleId}/${label(t)}] FAILED: ${results.at(-1).error}`);
      }
    }
    mkdirSync(styleDir, { recursive: true });
    const okAny = results.some((r) => r.record);
    const finalScene = join(styleDir, 'final-scene.flat.json');
    if (okAny) writeFileSync(finalScene, scene);
    // the cameras of every target on one sheet
    const camTiles = results.flatMap((r) => (r.record ? r.record.views.map((v) => ({ label: `${r.target}: ${v.id}`, sub: `weight ${v.weight}`, img: join(r.record.out, 'views', v.id, 'before.png') })) : []));
    if (camTiles.length) await contactSheetRows({ rows: Array.from({ length: Math.ceil(camTiles.length / 5) }, (_, i) => ({ tiles: camTiles.slice(i * 5, i * 5 + 5) })), file: join(styleDir, 'cameras.png') });
    const lines = [
      `# Close the gap - ${o.styleId} (${new Date().toISOString()})`,
      o.dry ? 'DRY RUN (scripted model, fake image service): proves the harness only.' : `Caps: $${o.maxUsd} and ${o.maxMinutes} min per target, $${totalCap} total. Spent $${spent.toFixed(2)}.`,
      okAny ? `Final scene (all targets chained): \`final-scene.flat.json\`; per target: \`<target>/scene.flat.json\`. Cameras of every view: \`cameras.png\`.` : 'No target finished: no final scene.',
      '',
      '| target | status | views | overall first -> last (best) | iterations | cost | minutes | furniture (BOM) | contact sheet |',
      '|---|---|---|---|---|---|---|---|---|',
      ...results.map((r) => (r.record ? `| ${r.target} | ok${r.record.timedOut ? ' (time cap)' : ''}${r.record.restored ? ` (best kept: ${r.record.restored.to})` : ''} | ${r.record.views.map((v) => v.id).join(', ')} | ${r.record.first ?? 'n/a'} -> ${r.record.last ?? 'n/a'} (${r.record.best?.overall ?? 'n/a'}) | ${r.record.iterations} | ${o.dry ? 'dry' : `$${r.record.costUsd.toFixed(2)}`} | ${r.record.minutes} | ${r.record.totalEur === null ? 'n/a' : `${Math.round(r.record.totalEur)} EUR`} | ${basename(r.record.out)}/contact-sheet.png |` : `| ${r.target} | FAILED: ${String(r.error).slice(0, 100)} | | | | | | | |`)),
    ];
    writeFileSync(join(styleDir, 'summary.md'), lines.join('\n'));
    console.log(`\n${lines.join('\n')}\n\nsaved to ${styleDir}`);
    const failed = results.some((r) => r.error);
    if (o.publish) {
      if (!okAny || failed) console.log(`NOT PUBLISHED: ${failed ? 'a target failed' : 'nothing finished'}; fix it and publish the saved scene by hand if you want (${finalScene}).`);
      else {
        const p = await publishScene({ url: o.publish, scene, outDir: styleDir });
        console.log(`PUBLISHED the final scene to ${p.base}/api/scene. The scene it replaced is saved at ${p.backup} (restore it with PUT /api/scene).`);
      }
    }
    return failed ? 1 : 0;
  } finally {
    await fake?.stop();
  }
}

export { sleep };
