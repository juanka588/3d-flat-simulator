/* global console, process, Buffer, setTimeout */
// HD (hero) model tier: pnpm models:hd [--preview] [--only slug,slug] [--out dir]
// Reads manifest-hd.json (Sketchfab CC0 / CC-BY models, hand-picked), verifies the licence from the Sketchfab API,
// downloads the glTF with the user's token (cached, sequential), normalises to the item frame (pivot bottom-centre,
// front +z, metres; unit scale is auto-detected from `maxDimM`), Meshopt + WebP <= 1024 px, <= 40k triangles, and writes
// GLB + thumbnail + catalog.json to apps/web/public/models-hd. Output is staged and swapped in only on full success.
//  --preview   renders a 4-view sheet per model to /tmp/m5r-hd/preview (no output written) so the front axis,
//              the scale and the look can be judged before a model is accepted.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBounds } from '@gltf-transform/functions';
import sharp from 'sharp';
import { HD_BUDGETS, documentFromFile, normalise } from './normalise.mjs';
import { renderThumb } from './render.mjs';
import { creditsPath, renderCredits, readCatalog } from './credits.mjs';
import { assertPlausibleSize, budgetProblems, checkPins, cleanTags, creditLine, sha256, stableTimestamp } from './lib.mjs';
import { downloadModel, fetchMeta, loadToken, redact, sketchfabCacheDir } from './sketchfab.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
export const hdOutDir = resolve(root, 'apps/web/public/models-hd');
const stagingDir = resolve(root, '.cache/models-hd-staging');
const manifestPath = join(here, 'manifest-hd.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (name) => process.argv.includes(name);

async function metaFor(uid, now) {
  const p = join(sketchfabCacheDir, uid, 'meta.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const m = await fetchMeta(uid, now);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 2));
  await sleep(400);
  return m;
}

/** The unit scale that brings the largest raw extent into `maxDimM` (1 = already metres, then cm, mm, inch, dm, m*100). `fitMaxM` (manifest) forces the largest extent for models authored without a unit. */
export function detectUnitScale(rawMax, [lo, hi], explicit, fitMaxM) {
  if (explicit !== undefined) return explicit;
  if (fitMaxM !== undefined) return fitMaxM / rawMax; // unit-less model: scaled so its largest extent is the real-world size
  for (const s of [1, 0.01, 0.001, 0.0254, 0.1, 100]) {
    const m = rawMax * s;
    if (m >= lo && m <= hi) return s;
  }
  throw new Error(`raw largest extent ${rawMax} fits ${lo}-${hi} m at no common unit scale (1, 0.01, 0.001, 0.0254, 0.1, 100); set unitScale in the manifest`);
}

async function rawMaxExtent(path) {
  const doc = await documentFromFile(path);
  const b = getBounds(doc.getRoot().listScenes()[0]);
  return Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
}

/**
 * Heuristic front of a furniture model with the front declared +z: the backrest, headboard or wall side is the upper
 * part, so the front is the direction from the centroid of the top third of the vertices to the footprint centre.
 * Informational (previews only): a human still confirms the front from the 4-view sheet.
 */
export function frontHint(doc) {
  const pts = [];
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    for (let i = 0; i < pos.getCount(); i++) pts.push(pos.getElement(i, []));
  }
  if (!pts.length) return '?';
  const ys = pts.map((p) => p[1]).sort((a, b) => a - b);
  const cut = ys[Math.floor(ys.length * 0.66)];
  const top = pts.filter((p) => p[1] >= cut);
  const cx = top.reduce((n, p) => n + p[0], 0) / top.length;
  const cz = top.reduce((n, p) => n + p[2], 0) / top.length;
  if (Math.hypot(cx, cz) < 0.03) return 'symmetric';
  return Math.abs(cx) > Math.abs(cz) ? (cx > 0 ? '-x' : '+x') : (cz > 0 ? '-z' : '+z');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const VIEWS = [['+z', 0], ['+x', Math.PI / 2], ['-z', Math.PI], ['-x', -Math.PI / 2]];
const SHEET_SIZE = 260;

/** Four renders of the stage-A document (camera on the +z/+x, +x/-z, -z/-x, -x/+z sides), as PNG buffers. */
async function renderViews(doc) {
  return Promise.all(VIEWS.map(async ([, yaw]) => sharp(await renderThumb(doc, SHEET_SIZE, { yaw })).flatten({ background: '#f4f1ec' }).png().toBuffer()));
}

async function previewSheet(entry, images, info, size = SHEET_SIZE) {
  const parts = [];
  for (const [i, [label]] of VIEWS.entries()) {
    const img = images[i];
    parts.push({ input: img, left: i * size, top: 18 });
    parts.push({ input: Buffer.from(`<svg width="${size}" height="18" xmlns="http://www.w3.org/2000/svg"><text x="6" y="13" font-size="12" font-family="Helvetica" fill="#a33">camera side ${label}</text></svg>`), left: i * size, top: 0 });
  }
  const d = info.dims;
  const foot = `${info.hint ? `[front hint ${info.hint}] ` : ''}${entry.slug}  ${entry.category}  ${d.w} x ${d.d} x ${d.h} m  ${info.triangles} tris (source ${info.sourceTriangles})  ${(info.bytes / 1024) | 0} KB  tex ${info.textureMax}  ${info.materials} mat`;
  parts.push({ input: Buffer.from(`<svg width="${size * 4}" height="20" xmlns="http://www.w3.org/2000/svg"><text x="6" y="14" font-size="12" font-family="Helvetica" fill="#222">${esc(foot)}</text></svg>`), left: 0, top: size + 18 });
  return sharp({ create: { width: size * 4, height: size + 38, channels: 3, background: '#f4f1ec' } }).composite(parts).png().toBuffer();
}

async function main() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const preview = flag('--preview');
  const only = arg('--only')?.split(',');
  const pins = { update: flag('--update-pins'), changed: false };
  const token = loadToken();
  const now = new Date().toISOString();
  const previous = new Map();
  try { for (const e of JSON.parse(readFileSync(join(hdOutDir, 'catalog.json'), 'utf8'))) previous.set(e.id, e); } catch { /* first build */ }

  const slugs = new Set();
  for (const e of manifest.models) { if (slugs.has(e.slug)) throw new Error(`duplicate slug ${e.slug}`); slugs.add(e.slug); }
  const wanted = manifest.models.filter((e) => (only ? only.includes(e.slug) : preview ? e.status !== 'rejected' : e.status === 'accepted'));
  if (preview) mkdirSync('/tmp/m5r-hd/preview', { recursive: true });
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(join(stagingDir, 'thumbs'), { recursive: true });
  const catalog = [];
  let total = 0;

  for (const entry of wanted) {
    process.stdout.write(`${entry.slug} (sketchfab:${entry.sourceId}) ... `);
    const meta = await metaFor(entry.sourceId, now);
    const fresh = !existsSync(join(sketchfabCacheDir, entry.sourceId, '.source.json'));
    const dl = await downloadModel(entry.sourceId, { token });
    if (fresh) await sleep(1500);
    const pinned = checkPins(entry.slug, entry.sourceSha256, { archive: dl.archiveSha256 }, { update: pins.update });
    if (pinned.changed) { entry.sourceSha256 = pinned.pins; pins.changed = true; }

    const raw = await rawMaxExtent(dl.path);
    let unitScale;
    try {
      unitScale = detectUnitScale(raw, entry.maxDimM, entry.unitScale, entry.fitMaxM);
    } catch (err) {
      if (!preview) throw err;
      unitScale = ((entry.maxDimM[0] + entry.maxDimM[1]) / 2) / raw; // preview only: judge the look, then set fitMaxM or unitScale
      process.stdout.write(`[raw ${raw.toFixed(3)}: no unit fits, previewing at the range midpoint] `);
    }
    let thumb;
    let views;
    let hint;
    const res = await normalise(() => documentFromFile(dl.path), {
      front: entry.front ?? '+z',
      unitScale,
      texMax: entry.texMax ?? HD_BUDGETS.textureSize,
      maxTris: entry.maxTris ?? 30_000,
      maxBytes: HD_BUDGETS.modelBytes - 64 * 1024,
      onStageA: async (doc) => { if (preview) { views = await renderViews(doc); hint = frontHint(doc); } else thumb = await renderThumb(doc, 256); },
    });
    assertPlausibleSize(entry.slug, res.dims, entry.maxDimM);
    res.bytes = res.glb.length;
    if (preview) {
      writeFileSync(`/tmp/m5r-hd/preview/${entry.slug}.png`, await previewSheet(entry, views, { ...res, hint }));
      console.log(`hint ${hint}; ${res.dims.w}x${res.dims.d}x${res.dims.h} m, ${res.triangles} tris (from ${res.sourceTriangles}), ${(res.bytes / 1024) | 0} KB, unit x${unitScale}, ${res.materials} mat, ${meta.licence}`);
      continue;
    }
    const file = `${entry.slug}.glb`;
    const thumbFile = `thumbs/${entry.slug}.webp`;
    writeFileSync(join(stagingDir, file), res.glb);
    writeFileSync(join(stagingDir, thumbFile), thumb);
    const id = `sketchfab:${entry.slug}`;
    const outSha = sha256(res.glb);
    const record = {
      id,
      name: entry.name,
      source: 'cc0',
      tier: 'hd',
      licence: meta.licence,
      credit: creditLine({ name: meta.name ?? entry.name, author: meta.author, source: 'sketchfab', sourceUrl: meta.sourceUrl, licence: meta.licence }),
      category: entry.category,
      styleTags: cleanTags(entry.styleTags),
      nativeDims: res.dims,
      anchor: [0, 0, 0],
      front: '+z',
      file,
      thumb: thumbFile,
      thumbSha256: sha256(thumb),
      provider: 'sketchfab',
      sourceId: entry.sourceId,
      sourceUrl: meta.sourceUrl,
      author: meta.author ?? null,
      sha256: outSha,
      bytes: res.bytes,
      triangles: res.triangles,
      materials: res.materials,
      textureMax: res.textureMax,
      normalisation: { sourceFront: entry.front ?? '+z', unitScale, sourcePivot: res.sourceAnchor, sourceTriangles: res.sourceTriangles },
      licenseEvidence: meta.evidence,
      sourceSha256: entry.sourceSha256,
      retrievedAt: stableTimestamp(previous.get(id), { source: 'sketchfab', sha256: outSha }, meta.evidence.checkedAt ?? now),
    };
    const problems = budgetProblems(record, HD_BUDGETS.modelBytes ? { modelBytes: HD_BUDGETS.modelBytes, triangles: HD_BUDGETS.triangles, materials: HD_BUDGETS.materials } : {});
    if (problems.length) throw new Error(problems.join('; '));
    total += res.bytes;
    catalog.push(record);
    console.log(`${(res.bytes / 1024) | 0} KB, ${res.triangles} tris, ${res.dims.w}x${res.dims.d}x${res.dims.h} m, ${meta.licence}`);
  }
  if (preview) return;
  if (total > HD_BUDGETS.totalBytes) throw new Error(`HD tier is ${total} B, over the ${HD_BUDGETS.totalBytes} B budget`);
  catalog.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(stagingDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  const backup = hdOutDir + '.old';
  rmSync(backup, { recursive: true, force: true });
  if (existsSync(hdOutDir)) renameSync(hdOutDir, backup);
  try { renameSync(stagingDir, hdOutDir); } catch (err) { if (existsSync(backup)) renameSync(backup, hdOutDir); throw err; }
  rmSync(backup, { recursive: true, force: true });
  writeFileSync(creditsPath, renderCredits(readCatalog('light'), manifestPacks(), catalog));
  if (pins.changed) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\n${catalog.length} HD models, ${(total / 1024 / 1024).toFixed(2)} MB -> ${hdOutDir}`);
}

function manifestPacks() {
  try { return JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8')).packs ?? {}; } catch { return {}; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    rmSync(stagingDir, { recursive: true, force: true });
    console.error(`\nmodels:hd failed: ${redact(err.stack ?? err, loadToken())}`);
    process.exit(1);
  });
}
