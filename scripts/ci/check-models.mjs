/* global console, process */
// Model library gates (M5.15, model parts), run after the web build:
//  - every file in public/models (and dist/models) is listed in catalog.json (GLB, thumbnail) with the recorded sha256;
//  - budgets: <= 300 KB per model, <= 6 MiB in total, <= 20k triangles, <= 4 materials;
//  - the lazy HD tier (public/models-hd and dist/models-hd, M5R step 2) is checked the same way against its own
//    budgets: <= 2 MiB per model, <= 60 MiB in total, <= 40k triangles, <= 20 materials, textures <= 1024 px, and
//    every entry says `tier: "hd"`;
//  - credits: every entry has a licence (CC0-1.0 or CC-BY-4.0) and a credit line, and docs/MODELS-CREDITS.md lists it;
//  - licence evidence: every entry records HOW the licence was verified (basis, needle, source URL, date);
//  - the GLBs themselves are parsed (`checkGlbFiles`, with @gltf-transform/core): catalog.json is not trusted for
//    triangles, materials, texture sizes (<= 1024), Meshopt compression, a bottom at y = 0, a centred footprint
//    (+- 2 cm) or the nativeDims it declares (+- 2 cm).
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BUDGETS = { modelBytes: 300 * 1024, totalBytes: 6 * 1024 * 1024, triangles: 20_000, materials: 4, textureSize: 1024 };
/** The lazy `models-hd/` tier: hero models, fetched only when placed. */
export const HD_BUDGETS = { modelBytes: 2 * 1024 * 1024, totalBytes: 60 * 1024 * 1024, triangles: 40_000, materials: 20, textureSize: 1024 };
/** How far (m) the model's bottom may be from y = 0, its footprint centre from the origin, and its measured size from `nativeDims`. */
/** Library thumbnails of the parametric generators (`pnpm assets:thumbs`): generated, not catalogued, small. */
export const PARAM_THUMB = /^thumbs\/param-[A-Za-z0-9]+\.webp$/;
export const PARAM_THUMB_MAX_BYTES = 8 * 1024;
export const FRAME_TOLERANCE_M = 0.02;
const ALLOWED_LICENCES = new Set(['CC0-1.0', 'CC-BY-4.0']);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push({ path: rel, bytes: statSync(join(dir, entry.name)).size });
  }
  return out;
}

/** Problems of a models directory against its catalog (and, when given, the credits document text). */
export function checkModelsDir(dir, { credits, budgets = BUDGETS, tier = 'light' } = {}) {
  const problems = [];
  const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
  if (!Array.isArray(catalog)) return { problems: ['catalog.json is not an array'], bytes: 0 };
  const listed = new Map([['catalog.json', undefined]]);
  const ids = new Set();
  let glbTotal = 0;
  for (const e of catalog) {
    if (ids.has(e.id)) problems.push(`${e.id}: duplicate id`);
    ids.add(e.id);
    if (e.file) listed.set(e.file, e.sha256);
    if (e.thumb) listed.set(e.thumb, e.thumbSha256);
    if (tier === 'hd' && e.tier !== 'hd') problems.push(`${e.id}: an entry of the HD tier must say tier "hd"`);
    if (tier !== 'hd' && e.tier === 'hd') problems.push(`${e.id}: tier "hd" entries belong in models-hd/`);
    if (!ALLOWED_LICENCES.has(e.licence)) problems.push(`${e.id}: licence "${e.licence}" is not CC0-1.0 or CC-BY-4.0`);
    if (!e.credit || !String(e.credit).trim()) problems.push(`${e.id}: no credit line`);
    if (e.licence === 'CC-BY-4.0' && !/\bby\b/i.test(String(e.credit ?? ''))) problems.push(`${e.id}: CC-BY needs an author in the credit`);
    const ev = e.licenseEvidence;
    if (!ev || typeof ev !== 'object' || !ev.basis || !ev.needle || !ev.checkedAt || !(ev.packUrl || ev.policyUrl || ev.assetApiUrl || ev.url)) {
      problems.push(`${e.id}: no licence evidence (licenseEvidence needs basis, needle, checkedAt and the source URL)`);
    }
    if (credits !== undefined && !credits.includes(`\`${e.id}\``)) problems.push(`${e.id}: missing from docs/MODELS-CREDITS.md (run pnpm models:credits)`);
    if (e.triangles > budgets.triangles) problems.push(`${e.id}: ${e.triangles} triangles exceed ${budgets.triangles}`);
    if (e.materials > budgets.materials) problems.push(`${e.id}: ${e.materials} materials exceed ${budgets.materials}`);
    const p = e.file && join(dir, e.file);
    if (p && existsSync(p)) {
      const size = statSync(p).size;
      glbTotal += size;
      if (size > budgets.modelBytes) problems.push(`${e.file}: ${size} B exceeds ${budgets.modelBytes} B per model`);
      if (e.bytes !== undefined && e.bytes !== size) problems.push(`${e.file}: catalog says ${e.bytes} B, file is ${size} B`);
    }
  }
  const found = listFiles(dir);
  for (const f of found) {
    if (PARAM_THUMB.test(f.path)) {
      const head = readFileSync(join(dir, f.path)).subarray(0, 12);
      if (f.bytes > PARAM_THUMB_MAX_BYTES) problems.push(`${f.path}: ${f.bytes} B exceeds ${PARAM_THUMB_MAX_BYTES} B per generator thumbnail`);
      if (head.subarray(0, 4).toString('latin1') !== 'RIFF' || head.subarray(8, 12).toString('latin1') !== 'WEBP') problems.push(`${f.path}: not a WebP file`);
    } else if (!listed.has(f.path)) problems.push(`${f.path}: not listed in catalog.json`);
  }
  for (const [path, hash] of listed) {
    const p = join(dir, path);
    if (!existsSync(p)) problems.push(`${path}: listed in catalog.json but missing`);
    else if (hash && sha(readFileSync(p)) !== hash) problems.push(`${path}: sha256 differs from catalog.json`);
  }
  if (glbTotal > budgets.totalBytes) problems.push(`models total ${glbTotal} B exceeds ${budgets.totalBytes} B`);
  return { problems, bytes: found.reduce((n, f) => n + f.bytes, 0) };
}

let ioPromise;
async function getIO() {
  ioPromise ??= MeshoptDecoder.ready.then(() => new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder }));
  return ioPromise;
}

/** Facts measured from a GLB (a Buffer / Uint8Array), not read from the catalog. */
export async function inspectGlb(bytes) {
  const doc = await (await getIO()).readBinary(new Uint8Array(bytes));
  doc.setLogger(new Logger(Logger.Verbosity.SILENT));
  const root = doc.getRoot();
  let tris = 0;
  for (const mesh of root.listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      const idx = p.getIndices();
      tris += idx ? idx.getCount() / 3 : (p.getAttribute('POSITION')?.getCount() ?? 0) / 3;
    }
  }
  const scene = root.listScenes()[0];
  const b = scene ? getBounds(scene) : { min: [0, 0, 0], max: [0, 0, 0] };
  return {
    triangles: Math.round(tris),
    materials: root.listMaterials().length,
    textures: root.listTextures().map((t) => t.getSize()),
    meshopt: root.listExtensionsUsed().some((x) => x.extensionName === 'EXT_meshopt_compression'),
    hasMesh: root.listMeshes().length > 0,
    min: b.min,
    max: b.max,
  };
}

/** Problems found by parsing every GLB listed in the catalog of `dir` (missing files are reported by `checkModelsDir`). */
export async function checkGlbFiles(dir, { budgets = BUDGETS, tolerance = FRAME_TOLERANCE_M } = {}) {
  const problems = [];
  const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
  for (const e of Array.isArray(catalog) ? catalog : []) {
    const p = e.file && join(dir, e.file);
    if (!p || !existsSync(p)) continue;
    let g;
    try {
      g = await inspectGlb(readFileSync(p));
    } catch (error) {
      problems.push(`${e.file}: cannot be parsed as GLB (${error instanceof Error ? error.message : error})`);
      continue;
    }
    const at = (msg) => problems.push(`${e.file}: ${msg}`);
    if (!g.hasMesh) at('has no mesh');
    if (g.triangles > budgets.triangles) at(`${g.triangles} triangles (measured) exceed ${budgets.triangles}`);
    if (e.triangles !== undefined && e.triangles !== g.triangles) at(`catalog says ${e.triangles} triangles, the file has ${g.triangles}`);
    if (g.materials > budgets.materials) at(`${g.materials} materials (measured) exceed ${budgets.materials}`);
    for (const size of g.textures) {
      if (!size) at('a texture has an unreadable size');
      else if (Math.max(size[0], size[1]) > budgets.textureSize) at(`a ${size[0]}x${size[1]} texture exceeds ${budgets.textureSize} px`);
    }
    if (g.hasMesh && !g.meshopt) at('is not Meshopt-compressed (EXT_meshopt_compression missing)');
    const cx = (g.min[0] + g.max[0]) / 2;
    const cz = (g.min[2] + g.max[2]) / 2;
    if (Math.abs(g.min[1]) > tolerance) at(`bottom is at y = ${g.min[1].toFixed(3)} m, not 0 (+- ${tolerance * 100} cm)`);
    if (Math.abs(cx) > tolerance || Math.abs(cz) > tolerance) at(`footprint centre is at (${cx.toFixed(3)}, ${cz.toFixed(3)}), not the origin (+- ${tolerance * 100} cm)`);
    const d = e.nativeDims;
    if (d) {
      const w = g.max[0] - g.min[0];
      const dd = g.max[2] - g.min[2];
      const h = g.max[1] - g.min[1];
      if (Math.abs(w - d.w) > tolerance || Math.abs(dd - d.d) > tolerance || Math.abs(h - d.h) > tolerance) {
        at(`measures ${w.toFixed(3)} x ${dd.toFixed(3)} x ${h.toFixed(3)} m but the catalog says ${d.w} x ${d.d} x ${d.h} m`);
      }
    }
    // The front axis cannot be derived from geometry alone: it stays a declared, reviewed catalog field (+z after normalisation).
    if (e.front !== undefined && e.front !== '+z' && e.normalisation) at(`front is "${e.front}": a normalised model must face +z`);
  }
  return problems;
}

async function main() {
  let failed = false;
  const creditsPath = resolve(root, 'docs/MODELS-CREDITS.md');
  const credits = existsSync(creditsPath) ? readFileSync(creditsPath, 'utf8') : undefined;
  if (credits === undefined) { console.error('docs/MODELS-CREDITS.md is missing (run pnpm models:credits)'); failed = true; }
  const hdSource = existsSync(resolve(root, 'apps/web/public/models-hd/catalog.json'));
  const targets = [
    { rel: 'apps/web/public/models', budgets: BUDGETS, tier: 'light' },
    { rel: 'apps/web/dist/models', budgets: BUDGETS, tier: 'light' },
    // The HD tier is optional, but once its source folder exists the Pages build must carry it too.
    ...(hdSource ? [{ rel: 'apps/web/public/models-hd', budgets: HD_BUDGETS, tier: 'hd' }, { rel: 'apps/web/dist/models-hd', budgets: HD_BUDGETS, tier: 'hd' }] : []),
  ];
  for (const { rel, budgets, tier } of targets) {
    const dir = resolve(root, rel);
    if (!existsSync(dir)) {
      if (rel.includes('dist')) { console.error(`${rel} missing: build the web app first`); process.exit(2); }
      console.error(`${rel} missing`);
      failed = true;
      continue;
    }
    const { problems, bytes } = checkModelsDir(dir, { credits, budgets, tier });
    if (existsSync(join(dir, 'catalog.json'))) problems.push(...(await checkGlbFiles(dir, { budgets })));
    console.log(`${rel}: ${(bytes / 1024 / 1024).toFixed(2)} MiB, ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    if (problems.length) failed = true;
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
