/* global console, process */
// D4 local-only guard (M5.15): retailer data and models must never reach the Pages build or the repository.
//  1. the Pages dist build (BASE_PATH=/3d-flat-simulator/ pnpm build) holds none of the deny-list hosts (retailer-hosts.json);
//  2. no .glb / .gltf / .usdz in dist outside the committed model library (dist/models and the lazy HD tier dist/models-hd, each listed in its catalog.json),
//     and no file of ANY name (.bin, .dat, no extension...) that is a glTF by content: binary `glTF` magic, or JSON with
//     asset.version; no .env* file; `.wasm` modules are scanned for hosts too;
//     The gitignored local product catalogue (apps/server/local-assets/..., `pnpm catalog:build`) must not be in dist either: no path under a
//     `denyDirs` folder and no text file carrying a `denyContent` marker.
//  3. `git ls-files` holds no model file outside apps/web/public/models and models-hd, no .env / .envrc file (except .env.example), nothing
//     under the 3D-FUTURE folders, and no deny-list host outside `allowPaths`.
// Flags: --dist <dir>, --worktree (also scan untracked, non-ignored files: for local runs before committing).
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.json', '.html', '.htm', '.css', '.svg', '.map', '.txt', '.md', '.yml', '.yaml', '.webmanifest', '.xml', '.toml', '.env', '.example', '']);
const MODEL_EXT = /\.(glb|gltf|usdz)$/i;
/** Binary formats whose strings (data segments) are searched for hosts as latin1 text. */
const BINARY_SCAN_EXT = new Set(['.wasm']);
const GLTF_MAGIC = Buffer.from('glTF');

export function loadConfig(path = resolve(root, 'scripts/ci/retailer-hosts.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Glob with `**`, `*`, `?` to RegExp; `**\/` matches zero or more directories. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path));

/**
 * Undoes the usual ways of writing a dot so `ikea\\.com` (a regex source or an escaped string in a bundle), `ikea\\u002ecom`,
 * `ikea\\x2ecom`, `ikea&#46;com`, `ikea&#x2e;com`, `ikea&period;com`, `ikea%2ecom` and `ikea[.]com` all read as `ikea.com`.
 */
export function normaliseDots(text) {
  return text
    .replace(/\\+\.|\\+u002e|\\+x2e|&#0*46;|&#x0*2e;|&period;|%2e|\[\.\]/gi, '.');
}

/** Deny-list hosts found in `text` (case-insensitive; a host also matches as the suffix of a longer hostname; escaped dots count). */
export function findHosts(text, hosts) {
  const lower = normaliseDots(text.toLowerCase());
  const found = [];
  for (const h of hosts) {
    const re = new RegExp(`(?<![a-z0-9])${h.replace(/\./g, '\\.')}(?![a-z0-9-])`);
    if (re.test(lower)) found.push(h);
  }
  return found;
}

function walk(dir, prefix = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

/** True when `buf` is a glTF by content, whatever its file name: binary `glTF` magic, or JSON whose `asset.version` is set. */
export function isGltfContent(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(GLTF_MAGIC)) return true;
  if (buf.length > 8 * 1024 * 1024) return false;
  let i = 0;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3; // BOM
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)) i++;
  if (buf[i] !== 0x7b) return false; // JSON glTF is an object; JS bundles that merely mention "asset" do not start with "{"
  const text = buf.toString('utf8');
  try {
    const j = JSON.parse(text);
    return typeof j === 'object' && j !== null && typeof j.asset === 'object' && j.asset !== null && 'version' in j.asset;
  } catch {
    return /"asset"\s*:\s*\{[^}]*"version"/.test(text); // truncated or hand-edited JSON still carrying the glTF header
  }
}

/** Problems of a built dist directory: retailer hosts, glTF content under any name, .env files, and model files outside the committed library. */
export function scanDist(dist, cfg) {
  const problems = [];
  const listed = new Set();
  // The committed library: the light tier (models/) and the lazy HD tier (models-hd/), each listed in its own catalog.json.
  for (const folder of ['models', 'models-hd']) {
    try {
      const cat = JSON.parse(readFileSync(join(dist, folder, 'catalog.json'), 'utf8'));
      for (const e of cat) listed.add(`${folder}/${e.file}`);
    } catch {
      // no such tier in dist: every model file below it is a stray
    }
  }
  for (const rel of walk(dist)) {
    const ext = extname(rel).toLowerCase();
    const base = rel.split('/').pop();
    const segs = rel.split('/');
    for (const d of cfg.denyDirs ?? []) {
      const parts = d.split('/');
      if (segs.some((_, i) => parts.every((p, k) => segs[i + k] === p))) { problems.push(`${rel}: inside forbidden folder ${d} (local-only data in the build)`); break; }
    }
    if (/^\.env/i.test(base) && base !== '.env.example') problems.push(`${rel}: environment file in the build`);
    if (MODEL_EXT.test(rel) && !listed.has(rel)) problems.push(`${rel}: model file in the build that is not in the models catalog`);
    const buf = readFileSync(join(dist, rel));
    if (!MODEL_EXT.test(rel) && isGltfContent(buf)) problems.push(`${rel}: glTF content under a non-model name (not in the models catalog)`);
    if (TEXT_EXT.has(ext)) {
      const text = buf.toString('utf8');
      for (const h of findHosts(text, cfg.hosts)) problems.push(`${rel}: mentions retailer host ${h}`);
      for (const m of cfg.denyContent ?? []) if (text.includes(m)) problems.push(`${rel}: carries the local-only marker "${m}"`);
    } else if (BINARY_SCAN_EXT.has(ext)) {
      for (const h of findHosts(buf.toString('latin1'), cfg.hosts)) problems.push(`${rel}: mentions retailer host ${h}`);
    }
  }
  return problems;
}

/** Problems of a list of repository files (relative posix paths). `read(path)` returns text, or undefined for binary/missing. */
export function scanTracked(files, cfg, read) {
  const problems = [];
  for (const f of files) {
    const segments = f.split('/');
    const allowedFile = matchesAny(f, cfg.allowFiles ?? []);
    if (!allowedFile && matchesAny(f, cfg.denyFiles ?? [])) problems.push(`${f}: forbidden file (model / env / 3D-FUTURE) outside its allowed place`);
    const inFuture = segments.slice(0, -1).some((seg) => /3d-future/i.test(seg));
    if (inFuture) problems.push(`${f}: inside a 3D-FUTURE folder`);
    for (const d of inFuture ? [] : (cfg.denyDirs ?? [])) {
      const parts = d.split('/');
      const hit = segments.some((_, i) => parts.every((p, k) => segments[i + k] === p) && i + parts.length < segments.length);
      if (hit) { problems.push(`${f}: inside forbidden folder ${d}`); break; }
    }
    if (MODEL_EXT.test(f) && !/^apps\/web\/public\/models(-hd)?\//.test(f)) {
      if (!problems.some((p) => p.startsWith(`${f}:`))) problems.push(`${f}: model file outside apps/web/public/models`);
    }
    if (matchesAny(f, cfg.allowPaths ?? [])) continue;
    const ext = extname(f).toLowerCase();
    if (!TEXT_EXT.has(ext) && !BINARY_SCAN_EXT.has(ext)) continue;
    const text = read(f);
    if (text === undefined) continue;
    for (const h of findHosts(text, cfg.hosts)) problems.push(`${f}: mentions retailer host ${h}`);
    for (const m of cfg.denyContent ?? []) if (text.includes(m)) problems.push(`${f}: carries the local-only marker "${m}"`);
  }
  return problems;
}

export function gitFiles({ worktree = false, cwd = root } = {}) {
  const args = worktree ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard'] : ['ls-files', '-z'];
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
}

function main() {
  const cfg = loadConfig();
  const argv = process.argv.slice(2);
  const distArg = argv.indexOf('--dist');
  const dist = resolve(root, distArg >= 0 ? argv[distArg + 1] : 'apps/web/dist');
  if (!existsSync(dist)) { console.error(`${dist} missing: build the web app first (BASE_PATH=/3d-flat-simulator/ pnpm build)`); process.exit(2); }
  const problems = scanDist(dist, cfg).map((p) => `dist/${p}`);
  const files = gitFiles({ worktree: argv.includes('--worktree') }).filter((f) => existsSync(join(root, f)));
  problems.push(
    ...scanTracked(files, cfg, (f) => {
      const p = join(root, f);
      if (statSync(p).size > 5 * 1024 * 1024) return undefined;
      const buf = readFileSync(p);
      if (BINARY_SCAN_EXT.has(extname(f).toLowerCase())) return buf.toString('latin1');
      return buf.includes(0) ? undefined : buf.toString('utf8');
    }),
  );
  console.log(`check-no-retailer: ${files.length} files, dist ${dist.replace(root + '/', '')}, ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  if (problems.length) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
