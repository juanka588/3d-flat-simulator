/* global console, process */
// Material library gates (M3.14), run after the web build:
//  - apps/web/dist/materials is at most 8 MiB;
//  - public/materials (and dist/materials) hold no file that catalog.json does not list, and every listed file
//    exists with the recorded sha256;
// Fails with the offending paths.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MAX_BYTES = 8 * 1024 * 1024;

/** Every file under `dir` as `{ path (relative, posix), bytes }`. */
export function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push({ path: rel, bytes: statSync(join(dir, entry.name)).size });
  }
  return out;
}

/** Problems of a materials directory against its catalog: unlisted files, missing files, wrong hashes. */
export function checkDirectory(dir) {
  const problems = [];
  const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
  const listed = new Map([['catalog.json', undefined]]);
  for (const e of catalog) for (const [map, file] of Object.entries(e.files)) listed.set(`${e.id}/${file}`, e.sha256[map]);
  const found = listFiles(dir);
  for (const f of found) if (!listed.has(f.path)) problems.push(`${f.path}: not listed in catalog.json`);
  for (const [path, sha] of listed) {
    if (!existsSync(join(dir, path))) problems.push(`${path}: listed in catalog.json but missing`);
    else if (sha && createHash('sha256').update(readFileSync(join(dir, path))).digest('hex') !== sha) problems.push(`${path}: sha256 differs from catalog.json`);
  }
  return { problems, bytes: found.reduce((n, f) => n + f.bytes, 0) };
}

function main() {
  let failed = false;
  for (const rel of ['apps/web/public/materials', 'apps/web/dist/materials']) {
    const dir = resolve(root, rel);
    if (!existsSync(dir)) {
      if (rel.includes('dist')) {
        console.error(`${rel} missing: build the web app first`);
        process.exit(2);
      }
      continue;
    }
    const { problems, bytes } = checkDirectory(dir);
    console.log(`${rel}: ${(bytes / 1024 / 1024).toFixed(2)} MiB, ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    if (problems.length) failed = true;
    if (rel.includes('dist') && bytes > MAX_BYTES) {
      console.error(`  ${rel} is ${bytes} B, over the ${MAX_BYTES} B (8 MiB) budget`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
