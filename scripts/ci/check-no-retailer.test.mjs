import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findHosts, gitFiles, globToRegExp, loadConfig, scanDist, scanTracked } from './check-no-retailer.mjs';

const cfg = loadConfig();

describe('helpers', () => {
  it('matches globs', () => {
    expect(globToRegExp('**/*.glb').test('a.glb')).toBe(true);
    expect(globToRegExp('**/*.glb').test('a/b/c.glb')).toBe(true);
    expect(globToRegExp('**/*.glb').test('a/b/c.glbx')).toBe(false);
    expect(globToRegExp('apps/web/public/models/**/*.glb').test('apps/web/public/models/x.glb')).toBe(true);
    expect(globToRegExp('docs/**').test('docs/a/b.md')).toBe(true);
    expect(globToRegExp('**/.env.*').test('apps/server/.env.local')).toBe(true);
  });
  it('finds hosts as hostname suffixes, not inside other words', () => {
    expect(findHosts('fetch("https://www.IKEA.com/fr/p/1")', cfg.hosts)).toEqual(['ikea.com']);
    expect(findHosts('https://sik.ikea-static.com/x', cfg.hosts)).toContain('ikea-static.com');
    expect(findHosts('about.fr, robut.fr, whatever.example', cfg.hosts)).toEqual([]);
  });
});

describe('dist scan (synthetic leaks)', () => {
  function dist(files) {
    const d = mkdtempSync(join(tmpdir(), 'dist-'));
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(d, p.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
      writeFileSync(join(d, p), c);
    }
    return d;
  }
  const catalog = JSON.stringify([{ file: 'sofa.glb' }]);
  it('passes a clean build with the committed library', () => {
    expect(scanDist(dist({ 'index.html': '<html></html>', 'assets/a.js': 'fetch("/api/x")', 'models/catalog.json': catalog, 'models/sofa.glb': 'bin' }), cfg)).toEqual([]);
  });
  it('flags a retailer host in a bundle', () => {
    expect(scanDist(dist({ 'assets/a.js': 'x="https://www.ikea.com/p"', 'models/catalog.json': catalog }), cfg)).toEqual(['assets/a.js: mentions retailer host ikea.com']);
  });
  it('flags GLB / GLTF outside the catalog', () => {
    const p = scanDist(dist({ 'models/catalog.json': catalog, 'models/sofa.glb': 'ok', 'models/leak.glb': 'x', 'assets/other.gltf': '{}' }), cfg);
    expect(p).toEqual(expect.arrayContaining(['models/leak.glb: model file in the build that is not in the models catalog', 'assets/other.gltf: model file in the build that is not in the models catalog']));
    expect(p).toHaveLength(2);
  });
});

describe('tracked files scan (synthetic leaks)', () => {
  const read = (map) => (f) => map[f];
  it('allows the library, .env.example and allowPaths', () => {
    const files = ['apps/web/public/models/sofa.glb', 'apps/web/public/models/thumbs/a.webp', '.env.example', 'docs/notes.md', 'apps/server/src/providers/ikea.ts', 'scripts/ci/x.mjs'];
    const text = { 'docs/notes.md': 'see ikea.com', 'apps/server/src/providers/ikea.ts': 'https://www.ikea.com', 'scripts/ci/x.mjs': 'leroymerlin.fr' };
    expect(scanTracked(files, cfg, read(text))).toEqual([]);
  });
  it('flags stray models, env files and 3D-FUTURE content', () => {
    const p = scanTracked(['tools/sofa.glb', 'apps/web/src/room.gltf', 'apps/server/.env', 'apps/server/.env.local', 'apps/server/local-assets/3d-future/catalog.json', 'models/local/a.txt', 'data/3D-FUTURE-model/x.obj'], cfg, () => undefined);
    expect(p.map((x) => x.split(':')[0]).sort()).toEqual(['apps/server/.env', 'apps/server/.env.local', 'apps/server/local-assets/3d-future/catalog.json', 'apps/web/src/room.gltf', 'data/3D-FUTURE-model/x.obj', 'models/local/a.txt', 'tools/sofa.glb'].sort());
  });
  it('flags a retailer host outside allowPaths only', () => {
    const files = ['apps/web/src/leak.ts', 'apps/server/src/providers/ok.ts', 'README.md'];
    const text = { 'apps/web/src/leak.ts': 'const u = "https://www.castorama.fr/x"', 'apps/server/src/providers/ok.ts': 'castorama.fr', 'README.md': 'castorama.fr' };
    expect(scanTracked(files, cfg, read(text))).toEqual(['apps/web/src/leak.ts: mentions retailer host castorama.fr']);
  });
  it('lists git files of a repository', () => {
    const d = mkdtempSync(join(tmpdir(), 'repo-'));
    execFileSync('git', ['init', '-q'], { cwd: d });
    writeFileSync(join(d, 'a.txt'), 'a');
    writeFileSync(join(d, 'b.txt'), 'b');
    execFileSync('git', ['add', 'a.txt'], { cwd: d });
    expect(gitFiles({ cwd: d })).toEqual(['a.txt']);
    expect(gitFiles({ cwd: d, worktree: true }).sort()).toEqual(['a.txt', 'b.txt']);
  });
});
