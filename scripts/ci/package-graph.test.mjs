// Package-graph gate (docs/architecture/modules.md section 2.3). It reads every packages/*/package.json and
// apps/*/package.json and holds them to the TARGET matrix, so it already knows packages that do not exist yet
// (assets, site, viewer, capture): the migration lanes only add packages, they never edit this file.
//
//   1. workspace dependency edges (dependencies, devDependencies, peerDependencies) are a subset of the matrix;
//   2. the graph has no cycle;
//   3. every `@flat/<x>[/<sub>]` specifier in a package's src/ and test/ is a declared dependency, the <sub> is one of the
//      target's `exports`, and the (importing entry -> imported entry) pair is allowed by the matrix;
//   4. no file imports another package by a relative path (small allow-list for temporary cases).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The matrix, one row per ENTRY (a package can have a universal entry and a node-only one). Each row lists the entries
 * it may import. Entry names: `scene`, `assets`, `assets/node`, `site`, `site/node`, `capture`, `viewer`,
 * `viewer/testing`, and the apps `web`, `server`, `mcp`. (`viewer/internal`, the temporary subpath of steps V7/V8, is
 * folded into `viewer` here; the ESLint rules keep it to the web shims.)
 */
export const MATRIX = {
  scene: [],
  assets: ['scene'],
  'assets/node': ['scene', 'assets'],
  site: ['scene'],
  'site/node': ['scene', 'site'],
  capture: ['scene', 'site'],
  viewer: ['scene', 'assets'],
  // `viewer/testing` is allowed from apps/web/src/testHook*.ts only (see TESTING_FILES).
  web: ['scene', 'assets', 'site', 'capture', 'viewer'],
  server: ['scene', 'assets', 'assets/node', 'site', 'site/node', 'capture'],
  // `server` is allowed from apps/mcp/src/testing/** only, as a devDependency (see DEV_ONLY).
  mcp: ['scene', 'assets', 'site', 'site/node'],
};
/** Edges allowed in addition to the matrix, only as devDependencies and only from the named directory. */
export const DEV_ONLY = [{ from: 'mcp', to: 'server', dir: 'src/testing/' }];
/** Importing `viewer/testing` is allowed only from these files of apps/web. */
const TESTING_FILES = /^src\/testHook[^/]*\.ts$/;
/** Relative cross-package imports that exist today or are planned (paths relative to the repo root). Shrink this list, never grow it. */
export const RELATIVE_ALLOW = [
  'packages/scene/test/generators.setup.ts', // temporary until step 11: scene tests run against the real generators
  'apps/server/src/providers/local/fit.test.ts', // temporary until step A5: cross-checks the viewer's model-math checkDims
];

const pkgOfEntry = (entry) => entry.split('/')[0];
const shortName = (name) => name.replace(/^@flat\//, '');

/** Every workspace package: `{ dir, short, json }`. */
export function loadPackages(base = root) {
  const out = [];
  for (const group of ['packages', 'apps']) {
    const gdir = join(base, group);
    if (!existsSync(gdir)) continue;
    for (const name of readdirSync(gdir)) {
      const dir = join(gdir, name);
      if (!existsSync(join(dir, 'package.json'))) continue;
      const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      out.push({ dir, json, short: shortName(json.name) });
    }
  }
  return out;
}

/** Workspace edges declared in a package.json: `[{ to, kind }]`. */
export function declaredEdges(json) {
  const edges = [];
  for (const kind of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(json[kind] ?? {})) if (dep.startsWith('@flat/')) edges.push({ to: shortName(dep), kind });
  }
  return edges;
}

/** Package-level edges the matrix allows: the union of a package's entry rows, minus self edges. */
export function allowedPackageEdges() {
  const allowed = new Map();
  for (const [entry, may] of Object.entries(MATRIX)) {
    const set = allowed.get(pkgOfEntry(entry)) ?? new Set();
    for (const t of may) if (pkgOfEntry(t) !== pkgOfEntry(entry)) set.add(pkgOfEntry(t));
    allowed.set(pkgOfEntry(entry), set);
  }
  return allowed;
}

/** Edge violations of a list of `{ short, json }` packages against the matrix. */
export function edgeViolations(pkgs) {
  const allowed = allowedPackageEdges();
  const bad = [];
  for (const p of pkgs) {
    for (const { to, kind } of declaredEdges(p.json)) {
      if (to === p.short) continue;
      if (allowed.get(p.short)?.has(to)) continue;
      if (DEV_ONLY.some((d) => d.from === p.short && d.to === to) && kind === 'devDependencies') continue;
      bad.push(`${p.short} -> ${to} (${kind}) is not allowed by the matrix`);
    }
  }
  return bad;
}

/** A cycle as `a -> b -> a`, or null. `graph` maps a name to the names it depends on. */
export function findCycle(graph) {
  const state = new Map();
  const stack = [];
  const visit = (n) => {
    state.set(n, 1);
    stack.push(n);
    for (const m of graph.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m].join(' -> ');
      if (!state.has(m)) {
        const c = visit(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of graph.keys()) {
    if (state.has(n)) continue;
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

/** The entry a file belongs to, for the matrix: `assets/node` for packages/assets/src/node/**, otherwise the package. */
export function entryOfFile(p, relToPkg) {
  if ((p.short === 'assets' || p.short === 'site') && relToPkg.startsWith('src/node/')) return `${p.short}/node`;
  return p.short;
}

/** The target entry for a `@flat/...` specifier, or null when it is not a workspace specifier. */
export function entryOfSpecifier(spec) {
  const m = spec.match(/^@flat\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  const [, name, sub] = m;
  if (sub === 'node' || sub?.startsWith('node/')) return { entry: `${name}/node`, name, sub };
  if (name === 'viewer' && (sub === 'testing' || sub?.startsWith('testing/'))) return { entry: 'viewer/testing', name, sub };
  return { entry: name, name, sub };
}

/** Does an `exports` map expose `sub` (undefined = the root)? Supports `*` patterns like "./fixtures/*". */
export function exportsAllow(exportsField, sub) {
  if (exportsField === undefined) return true; // no `exports`: any path of the package resolves (server, mcp, web)
  const key = sub === undefined ? '.' : `./${sub}`;
  return Object.keys(exportsField).some((k) => k === key || (k.endsWith('*') && key.startsWith(k.slice(0, -1))));
}

const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bvi\.mock\s*\(\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;
const SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/;

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (SOURCE_RE.test(name)) yield path;
  }
}

export function specifiersOf(code) {
  return [...code.matchAll(SPEC_RE)].map((m) => m[2]);
}

/** Violations of rule 3 for one source file's specifiers. */
export function importViolations(p, relToPkg, specs, byName) {
  const bad = [];
  const from = entryOfFile(p, relToPkg);
  const declared = new Set(declaredEdges(p.json).map((e) => e.to));
  for (const spec of specs) {
    const t = entryOfSpecifier(spec);
    if (!t || t.name === p.short) continue; // not a workspace specifier, or a package importing itself by name
    const where = `${p.short}/${relToPkg} imports '${spec}'`;
    if (!declared.has(t.name)) bad.push(`${where}: ${t.name} is not a declared dependency`);
    const target = byName.get(t.name);
    if (target && !exportsAllow(target.json.exports, t.sub)) bad.push(`${where}: '${t.sub ?? '.'}' is not one of the exports of @flat/${t.name}`);
    const ok =
      (MATRIX[from] ?? []).includes(t.entry) ||
      (t.entry === 'viewer/testing' && from === 'web' && TESTING_FILES.test(relToPkg)) ||
      DEV_ONLY.some((d) => d.from === from && d.to === t.entry && relToPkg.startsWith(d.dir));
    if (!ok) bad.push(`${where}: ${from} -> ${t.entry} is not allowed by the matrix`);
  }
  return bad;
}

/** Rule 4: relative imports that resolve into another workspace package's src/ (data files such as fixtures and public catalogues are not code). */
export function relativeEscapes(p, file, specs, pkgs, base = root) {
  const bad = [];
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(file), spec);
    for (const q of pkgs) {
      if (q.dir === p.dir) continue;
      if (target === q.dir || target.startsWith(join(q.dir, 'src') + sep)) bad.push(`${relative(base, file)} imports '${spec}' (inside ${q.short})`);
    }
  }
  return bad;
}

const packages = loadPackages();
const byShort = new Map(packages.map((p) => [p.short, p]));

describe('package graph: the manifests', () => {
  it('finds the workspace packages', () => {
    expect(packages.map((p) => p.short)).toEqual(expect.arrayContaining(['scene', 'web', 'server', 'mcp']));
  });

  it('every workspace package has a row in the matrix', () => {
    for (const p of packages) expect(Object.keys(MATRIX).some((e) => pkgOfEntry(e) === p.short), `${p.short} has no row in MATRIX`).toBe(true);
  });

  it('1. workspace edges are a subset of the matrix (apps/mcp -> @flat/server is the dev-only exception)', () => {
    expect(edgeViolations(packages)).toEqual([]);
  });

  it('2. the graph has no cycle', () => {
    const graph = new Map(packages.map((p) => [p.short, declaredEdges(p.json).map((e) => e.to)]));
    expect(findCycle(graph)).toBeNull();
  });

  it('the dev-only exception really is dev-only today', () => {
    const mcp = byShort.get('mcp');
    expect(mcp.json.dependencies?.['@flat/server']).toBeUndefined();
    expect(mcp.json.devDependencies?.['@flat/server']).toBeDefined();
  });
});

describe('package graph: the sources', () => {
  const violations = [];
  const escapes = [];
  for (const p of packages) {
    for (const sub of ['src', 'test']) {
      for (const file of walk(join(p.dir, sub))) {
        const specs = specifiersOf(readFileSync(file, 'utf8'));
        const rel = relative(p.dir, file).split(sep).join('/');
        violations.push(...importViolations(p, rel, specs, byShort));
        escapes.push(...relativeEscapes(p, file, specs, packages).filter((e) => !RELATIVE_ALLOW.some((a) => e.startsWith(a))));
      }
    }
  }
  it('3. every @flat/* specifier is a declared dependency, an exported subpath and an allowed entry pair', () => {
    expect(violations).toEqual([]);
  });
  it('4. no file imports another package by a relative path (outside the allow-list)', () => {
    expect(escapes).toEqual([]);
  });
});

describe('package graph: the checks do detect violations', () => {
  const mk = (short, deps = {}, dev = {}, exportsField) => ({ short, dir: `/x/${short}`, json: { name: `@flat/${short}`, dependencies: deps, devDependencies: dev, exports: exportsField } });
  it('rejects an edge outside the matrix', () => {
    expect(edgeViolations([mk('scene', { '@flat/assets': '*' })])).toHaveLength(1);
    expect(edgeViolations([mk('assets', { '@flat/viewer': '*' })])).toHaveLength(1);
    expect(edgeViolations([mk('viewer', { '@flat/site': '*' })])).toHaveLength(1);
    expect(edgeViolations([mk('server', { '@flat/viewer': '*' })])).toHaveLength(1);
    expect(edgeViolations([mk('web', { '@flat/server': '*' })])).toHaveLength(1);
    expect(edgeViolations([mk('mcp', { '@flat/viewer': '*' })])).toHaveLength(1);
  });
  it('accepts the target edges, and apps/mcp -> server only as a devDependency', () => {
    expect(edgeViolations([mk('web', { '@flat/viewer': '*', '@flat/capture': '*', '@flat/site': '*' }), mk('capture', { '@flat/site': '*', '@flat/scene': '*' })])).toEqual([]);
    expect(edgeViolations([mk('mcp', {}, { '@flat/server': '*' })])).toEqual([]);
    expect(edgeViolations([mk('mcp', { '@flat/server': '*' })])).toHaveLength(1);
  });
  it('finds cycles', () => {
    expect(findCycle(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]))).toBe('a -> b -> c -> a');
    expect(findCycle(new Map([['a', ['b']], ['b', []]]))).toBeNull();
  });
  it('checks subpaths against exports and entries against the matrix', () => {
    const assets = mk('assets', {}, {}, { '.': './src/index.ts', './node': './src/node/index.ts' });
    const by = new Map([['assets', assets]]);
    expect(importViolations(mk('site', { '@flat/scene': '*' }), 'src/x.ts', ['@flat/assets'], by).length).toBeGreaterThan(0);
    const server = mk('server', { '@flat/assets': '*' });
    expect(importViolations(server, 'src/x.ts', ['@flat/assets/node'], by)).toEqual([]);
    expect(importViolations(server, 'src/x.ts', ['@flat/assets/nope'], by)).toHaveLength(1);
    expect(importViolations(mk('viewer', { '@flat/assets': '*' }), 'src/x.ts', ['@flat/assets/node'], by).length).toBeGreaterThan(0);
    const viewerPkg = mk('viewer', {}, {}, { '.': './src/index.ts', './testing': './src/testing/index.ts' });
    const by2 = new Map([['viewer', viewerPkg]]);
    const web = mk('web', { '@flat/viewer': '*' });
    expect(importViolations(web, 'src/ui/X.tsx', ['@flat/viewer/testing'], by2)).toHaveLength(1);
    expect(importViolations(web, 'src/testHook.ts', ['@flat/viewer/testing'], by2)).toEqual([]);
    const mcp = mk('mcp', {}, { '@flat/server': '*' });
    const by3 = new Map([['server', mk('server')]]);
    expect(importViolations(mcp, 'src/testing/harness.ts', ['@flat/server/src/server'], by3)).toEqual([]);
    expect(importViolations(mcp, 'src/tools/x.ts', ['@flat/server/src/server'], by3)).toHaveLength(1);
  });
  it('flags a relative import into another package', () => {
    const a = { short: 'assets', dir: '/r/packages/assets' };
    const s = { short: 'scene', dir: '/r/packages/scene' };
    expect(relativeEscapes(a, '/r/packages/assets/src/x.ts', ['../../scene/src/y'], [a, s], '/r')).toHaveLength(1);
    expect(relativeEscapes(a, '/r/packages/assets/src/x.ts', ['./y', '../z'], [a, s], '/r')).toEqual([]);
  });
});
