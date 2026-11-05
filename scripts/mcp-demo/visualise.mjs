/* global process, console, fetch, setTimeout */
/**
 * Regenerates the labelled "visualisation" of finished close-the-gap targets WITHOUT redesigning anything: for each target folder
 * (`<root>/<style>/<target>/` with scene.flat.json, final.png, plan.json, result.json, references/) it loads the target's final scene
 * into a throw-away scene server, asks `generate_reference` {mode visualisation} for the hero view (prompt v2, fidelity check, up to 2
 * edits), scores the OLD visualisation with the same rules against the same camera, and writes
 *   <out>/<target>/visualisation.png (labelled), <out>/<target>/old-visualisation.png, <out>/fidelity.json, <out>/overview-<n>.png
 * (rows: target | final | old visualisation | new visualisation).
 *
 *   pnpm mcp:demo:visualise -- --root <design-closegap> --style french-parisian --out <dir> [--targets alcove,balcon] [--seed 1]
 *   Needs the image service (IMAGEGEN_URL, default http://127.0.0.1:8790; use your own port) and `pnpm mcp:setup`. Run it under
 *   `caffeinate -dimsu` on a Mac: one image at a time, about a minute each.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contactSheetRows, labelVisualisation, renderWithRetry } from './close-gap.mjs';
import { ROOT, connectLikeClaudeCode, startServer } from './lib.mjs';
import { fidelityRef, scoreFidelity } from '../../apps/mcp/src/imagegen/fidelity.ts';
import { viewFacts } from '../../apps/mcp/src/reference/facts.ts';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const ROOT_DIR = opt('--root', join(ROOT, '.tmp/design-closegap'));
const STYLE = opt('--style', 'french-parisian');
const OUT = opt('--out', join(ROOT, '.tmp/design-closegap/visualisation-v2'));
const ONLY = opt('--targets')?.split(',').map((x) => x.trim()).filter(Boolean);
const SEED = Number(opt('--seed', '1'));
const IMAGEGEN_URL = (process.env.IMAGEGEN_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '');

const jsonIn = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
};
const newest = (dir, re) => {
  if (!existsSync(dir)) return undefined;
  const hits = readdirSync(dir).filter((f) => re.test(f)).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
  return hits.length ? join(dir, hits.at(-1).f) : undefined;
};
const textOf = (r) => (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const r3 = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n);

async function oneTarget(name, dir, out) {
  const result = jsonIn(join(dir, 'result.json'));
  const plan = jsonIn(join(dir, 'plan.json'));
  const sceneText = readFileSync(join(dir, 'scene.flat.json'), 'utf8');
  const scene = JSON.parse(sceneText);
  const heroOld = plan.views[0];
  const roomId = result.roomId;
  const room = scene.rooms.find((r) => r.id === roomId);
  const outDir = join(out, name);
  mkdirSync(outDir, { recursive: true });
  const dataDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'flat-visualise-'));
  const server = await startServer(dataDir, { FLAT_PROVIDERS: 'ikea-fr,pasted-url', FLAT_ENV_FILE: '/dev/null' });
  const designOut = join(outDir, 'run');
  mkdirSync(designOut, { recursive: true });
  let mcp;
  try {
    const put = await fetch(`${server.url}/api/scene`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: sceneText });
    if (!put.ok) throw new Error(`could not load the scene: ${put.status} ${await put.text()}`);
    mcp = await connectLikeClaudeCode({ serverUrl: server.url, clientName: 'visualise', env: { FLAT_DESIGN_OUT: designOut, IMAGEGEN_URL, FLAT_EXCLUDE_CATEGORIES: 'curtain' } });
    const call = (n, a) => mcp.client.callTool({ name: n, arguments: a }, { timeout: 600_000 });

    // the hero view of the FINAL scene (the media view follows the TV)
    const planNow = (await call('describe_room', { roomId, plan: true })).structuredContent ?? {};
    const hero = (planNow.views ?? []).find((v) => v.id === heroOld.id && v.zone === heroOld.zone) ?? planNow.views?.[0];
    const sameCamera = Math.hypot(hero.eye[0] - heroOld.eye[0], hero.eye[1] - heroOld.eye[1]) < 0.05 && Math.abs(hero.headingDeg - heroOld.headingDeg) < 1;
    const pose = { mode: 'walk', position: hero.eye, eyeHeight: 1.55, headingDeg: hero.headingDeg, pitchDeg: 0, fovDeg: hero.fovDeg };

    // the passes of that camera: what both visualisations are scored against
    // a cold machine starts Chromium and fetches the shop models: warm up with the runner's render retry, then ask for the passes
    await renderWithRetry((a) => call('render_view', a), { view: 'walk', roomId, pose, preset: planNow.windowless ? 'evening' : 'day', size: { width: 1024, height: 768 }, waitForModelsS: 120 }, { log: (m) => console.log(`[${name}] ${m}`) });
    let passes;
    for (let t = 0; t < 3; t++) {
      passes = await call('render_passes', { view: 'walk', roomId, pose, kinds: ['ids', 'edgesItems'] });
      if (!passes.isError) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    const imgs = {};
    const c = passes.content ?? [];
    for (let i = 0; i < c.length - 1; i++) if (c[i].type === 'text' && ['ids', 'edgesItems'].includes(c[i].text) && c[i + 1].type === 'image') imgs[c[i].text] = c[i + 1].data;
    if (!imgs.ids || !imgs.edgesItems) throw new Error(`no passes for ${name}: ${textOf(passes).slice(0, 200)}`);
    const facts = viewFacts(scene, roomId, pose);
    const outdoor = room.type === 'balcony';
    const ref = fidelityRef(imgs.ids, imgs.edgesItems, { windowless: !outdoor && facts.windowless, outdoor });
    const score = (file) => {
      const f = scoreFidelity(readFileSync(file), ref, { visualisation: true });
      return { score: r3(f.score), ok: f.ok, edgeRecall: r3(f.edgeRecall), ceilingPale: f.ceilingPale === null ? null : r3(f.ceilingPale), ceilingClutter: f.ceilingClutter == null ? null : r3(f.ceilingClutter), skyOpen: f.skyOpen == null ? null : r3(f.skyOpen), windowPatch: f.windowPatch == null ? null : r3(f.windowPatch), reasons: f.reasons };
    };

    // the old visualisation (raw, unlabelled) of the run
    const oldRaw = newest(join(dir, 'references'), /^visualisation-.*-\d+\.png$/);
    const oldScore = oldRaw ? score(oldRaw) : undefined;
    if (oldRaw) copyFileSync(oldRaw, join(outDir, 'old-visualisation.png'));
    else if (existsSync(join(dir, 'visualisation.png'))) copyFileSync(join(dir, 'visualisation.png'), join(outDir, 'old-visualisation.png'));

    // the new one: prompt v2, the tool checks it and edits again (max 2 tries) when it fails
    const gen = await call('generate_reference', { roomId, styleId: STYLE, mode: 'visualisation', view: hero.id, seed: SEED, waitS: 280 });
    let sc = gen.structuredContent ?? {};
    for (let k = 0; k < 6 && sc.status && sc.status !== 'done' && sc.jobId; k++) sc = (await call('generate_reference', { jobId: sc.jobId, waitS: 280 })).structuredContent ?? {};
    if (gen.isError || sc.status !== 'done') throw new Error(`generate_reference failed for ${name}: ${textOf(gen).slice(0, 400)}`);
    const picked = sc.images?.[0];
    const newRaw = picked?.path;
    const newScore = newRaw ? score(newRaw) : undefined;
    if (newRaw) {
      copyFileSync(newRaw, join(outDir, 'new-visualisation-raw.png'));
      await labelVisualisation(newRaw, join(outDir, 'visualisation.png'));
    }
    const finalScore = existsSync(join(dir, 'final.png')) ? score(join(dir, 'final.png')) : undefined;
    return { target: name, roomId, style: STYLE, hero: hero.id, sameCameraAsRun: sameCamera, prompt: sc.prompt, attempts: sc.attempts, note: sc.note, old: oldScore, new: newScore, finalRender: finalScore, seed: sc.seed };
  } finally {
    await mcp?.close().catch(() => {});
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const base = join(ROOT_DIR, STYLE);
  const all = readdirSync(base).filter((d) => existsSync(join(base, d, 'scene.flat.json')) && existsSync(join(base, d, 'result.json')));
  const names = ONLY?.length ? ONLY : all;
  const unknown = names.filter((n) => !all.includes(n));
  if (unknown.length) throw new Error(`unknown target(s) ${unknown.join(', ')}; have ${all.join(', ')}`);
  mkdirSync(OUT, { recursive: true });
  const results = [];
  for (const n of names) {
    console.log(`[${n}] visualising...`);
    try {
      const r = await oneTarget(n, join(base, n), OUT);
      results.push(r);
      console.log(`[${n}] old ${r.old?.score} ${r.old?.ok ? 'ok' : 'FAIL'} -> new ${r.new?.score} ${r.new?.ok ? 'ok' : 'FAIL'} (attempts ${r.attempts?.length ?? 1})`);
    } catch (e) {
      console.log(`[${n}] FAILED: ${e.message}`);
      results.push({ target: n, error: e.message });
    }
    writeFileSync(join(OUT, 'fidelity.json'), `${JSON.stringify(results, null, 2)}\n`);
  }
  const rows = results
    .filter((r) => !r.error)
    .map((r) => {
      const d = join(base, r.target);
      const sub = (s) => (s ? `fidelity ${s.score}${s.ok ? '' : ' FAIL'}` : '');
      return {
        tiles: [
          { label: `${r.target}: target`, sub: 'AI reference image', img: join(d, 'target.png') },
          { label: `${r.target}: final`, sub: 'honest 3D render', img: join(d, 'final.png') },
          { label: 'old visualisation', sub: sub(r.old), img: join(OUT, r.target, 'old-visualisation.png') },
          { label: 'new visualisation (v2)', sub: sub(r.new), img: join(OUT, r.target, 'new-visualisation-raw.png') },
        ],
      };
    });
  for (let i = 0; i * 3 < rows.length; i++) await contactSheetRows({ rows: rows.slice(i * 3, i * 3 + 3), file: join(OUT, `overview-${i + 1}.png`) });
  const md = [
    `# Visualisation v2 - ${STYLE}`,
    '',
    '| target | old fidelity | new fidelity | new attempts | ceiling clutter old -> new | sky open old -> new |',
    '|---|---|---|---|---|---|',
    ...results.map((r) => (r.error ? `| ${r.target} | FAILED: ${r.error.slice(0, 80)} | | | | |` : `| ${r.target} | ${r.old?.score ?? 'n/a'}${r.old && !r.old.ok ? ' FAIL' : ''} | ${r.new?.score ?? 'n/a'}${r.new && !r.new.ok ? ' FAIL' : ''} | ${r.attempts?.length ?? 1} | ${r.old?.ceilingClutter ?? '-'} -> ${r.new?.ceilingClutter ?? '-'} | ${r.old?.skyOpen ?? '-'} -> ${r.new?.skyOpen ?? '-'} |`)),
    '',
  ].join('\n');
  writeFileSync(join(OUT, 'summary.md'), md);
  console.log(`\n${md}\nsaved to ${OUT}`);
  return results.some((r) => r.error) ? 1 : 0;
}

process.exit(await main().catch((e) => (console.error(e.message), 2)));
