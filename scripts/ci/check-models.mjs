/* global console, process */
// Model library gates (M5.15, model parts), run after the web build:
//  - every file in public/models (and dist/models) is listed in catalog.json (GLB, thumbnail) with the recorded sha256;
//  - budgets: <= 300 KB per model, <= 6 MiB in total, <= 20k triangles, <= 4 materials;
//  - credits: every entry has a licence (CC0-1.0 or CC-BY-4.0) and a credit line, and docs/MODELS-CREDITS.md lists it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BUDGETS = { modelBytes: 300 * 1024, totalBytes: 6 * 1024 * 1024, triangles: 20_000, materials: 4 };
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
export function checkModelsDir(dir, { credits, budgets = BUDGETS } = {}) {
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
    if (!ALLOWED_LICENCES.has(e.licence)) problems.push(`${e.id}: licence "${e.licence}" is not CC0-1.0 or CC-BY-4.0`);
    if (!e.credit || !String(e.credit).trim()) problems.push(`${e.id}: no credit line`);
    if (e.licence === 'CC-BY-4.0' && !/\bby\b/i.test(String(e.credit ?? ''))) problems.push(`${e.id}: CC-BY needs an author in the credit`);
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
  for (const f of found) if (!listed.has(f.path)) problems.push(`${f.path}: not listed in catalog.json`);
  for (const [path, hash] of listed) {
    const p = join(dir, path);
    if (!existsSync(p)) problems.push(`${path}: listed in catalog.json but missing`);
    else if (hash && sha(readFileSync(p)) !== hash) problems.push(`${path}: sha256 differs from catalog.json`);
  }
  if (glbTotal > budgets.totalBytes) problems.push(`models total ${glbTotal} B exceeds ${budgets.totalBytes} B`);
  return { problems, bytes: found.reduce((n, f) => n + f.bytes, 0) };
}

function main() {
  let failed = false;
  const creditsPath = resolve(root, 'docs/MODELS-CREDITS.md');
  const credits = existsSync(creditsPath) ? readFileSync(creditsPath, 'utf8') : undefined;
  if (credits === undefined) { console.error('docs/MODELS-CREDITS.md is missing (run pnpm models:credits)'); failed = true; }
  for (const rel of ['apps/web/public/models', 'apps/web/dist/models']) {
    const dir = resolve(root, rel);
    if (!existsSync(dir)) {
      if (rel.includes('dist')) { console.error(`${rel} missing: build the web app first`); process.exit(2); }
      console.error(`${rel} missing`);
      failed = true;
      continue;
    }
    const { problems, bytes } = checkModelsDir(dir, { credits });
    console.log(`${rel}: ${(bytes / 1024 / 1024).toFixed(2)} MiB, ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    if (problems.length) failed = true;
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
