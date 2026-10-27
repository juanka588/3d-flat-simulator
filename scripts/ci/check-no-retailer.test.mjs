import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findHosts, gitFiles, globToRegExp, isGltfContent, loadConfig, normaliseDots, scanDist, scanTracked } from './check-no-retailer.mjs';

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

describe('evasions: escaped dots, wasm, glTF under other names, .mts/.cts, .envrc', () => {
  it('finds hosts written with escaped or encoded dots', () => {
    for (const t of [
      'new RegExp("www\\\\.ikea\\\\.com")', // "www\\.ikea\\.com" in source
      '/www\\.ikea\\.com/',
      'ikea\\u002ecom',
      'ikea\\x2ecom',
      'ikea&#46;com',
      'ikea&#x2E;com',
      'ikea&period;com',
      'ikea%2Ecom',
      'ikea[.]com',
      'IKEA\\.COM',
    ]) {
      expect([t, findHosts(t, cfg.hosts)]).toEqual([t, ['ikea.com']]);
    }
    expect(normaliseDots('a\\.b')).toBe('a.b');
    expect(findHosts('robut\\.fr and about&#46;fr', cfg.hosts)).toEqual([]);
  });

  const dist = (files) => {
    const d = mkdtempSync(join(tmpdir(), 'dist-ev-'));
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(d, p.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
      writeFileSync(join(d, p), c);
    }
    return d;
  };
  // a minimal wasm module: magic + version, then a data section that holds the host as plain bytes
  const wasmWith = (text) => Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0x0b, text.length + 4, 1, 0, 0x41, 0, 0x0b]), Buffer.from(text, 'latin1')]);

  it('flags a retailer host inside a .wasm module (dist and tracked)', () => {
    expect(scanDist(dist({ 'assets/m.wasm': wasmWith('https://www.ikea.com/fr/fr/p/') }), cfg)).toEqual(['assets/m.wasm: mentions retailer host ikea.com']);
    expect(scanDist(dist({ 'assets/m.wasm': wasmWith('nothing to see') }), cfg)).toEqual([]);
    expect(scanTracked(['apps/web/src/m.wasm'], cfg, () => wasmWith('x.leroymerlin.fr/y').toString('latin1'))).toEqual(['apps/web/src/m.wasm: mentions retailer host leroymerlin.fr']);
  });

  it('flags a binary glTF whatever its name (.bin, .dat, no extension), but not the listed library', () => {
    const glb = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0x4a, 0x53, 0x4f, 0x4e])]);
    const p = scanDist(dist({ 'models/catalog.json': JSON.stringify([{ file: 'sofa.glb' }]), 'models/sofa.glb': glb, 'assets/leak.bin': glb, 'assets/leak.dat': glb, 'assets/noext': glb }), cfg);
    expect(p.sort()).toEqual(['assets/leak.bin: glTF content under a non-model name (not in the models catalog)', 'assets/leak.dat: glTF content under a non-model name (not in the models catalog)', 'assets/noext: glTF content under a non-model name (not in the models catalog)']);
  });

  it('flags JSON glTF (asset + version) under any name, but not ordinary JSON or JS that mentions "asset"', () => {
    const gltf = JSON.stringify({ asset: { version: '2.0', generator: 'x' }, scenes: [] });
    expect(scanDist(dist({ 'assets/scene.bin': gltf, 'assets/scene.json': '  \n' + gltf, 'assets/trunc.dat': '{"asset": {"generator":"g", "version": "2.0"}, "scenes": [' }), cfg).map((x) => x.split(':')[0]).sort()).toEqual(['assets/scene.bin', 'assets/scene.json', 'assets/trunc.dat']);
    expect(
      scanDist(
        dist({
          'assets/app.js': 'if(!json.asset||!json.asset.version)throw 1;const k="asset",v="version";',
          'assets/manifest.webmanifest': JSON.stringify({ name: 'x', version: '1.0', assets: ['a'] }),
          'assets/cat.json': JSON.stringify([{ asset: 'a', version: 1 }]),
          'assets/other.json': JSON.stringify({ asset: 'a-string', version: 1 }),
        }),
        cfg,
      ),
    ).toEqual([]);
    expect(isGltfContent(Buffer.from('{"asset":{"version":"2.0"}}'))).toBe(true);
    expect(isGltfContent(Buffer.from('{"asset":"x","version":"2.0"}'))).toBe(false);
    expect(isGltfContent(Buffer.from('gltf'))).toBe(false);
  });

  it('scans escaped hosts in a bundle and .mts / .cts sources', () => {
    expect(scanDist(dist({ 'assets/a.js': 'const r=/shop\\.leroymerlin\\.fr/' }), cfg)).toEqual(['assets/a.js: mentions retailer host leroymerlin.fr']);
    const text = { 'apps/web/src/a.mts': 'fetch("https://www.castorama.fr/x")', 'apps/web/src/b.cts': 'const h = "conforama.fr"', 'apps/web/src/c.ts': 'maisonsdumonde.com' };
    expect(scanTracked(Object.keys(text), cfg, (f) => text[f])).toEqual([
      'apps/web/src/a.mts: mentions retailer host castorama.fr',
      'apps/web/src/b.cts: mentions retailer host conforama.fr',
      'apps/web/src/c.ts: mentions retailer host maisonsdumonde.com',
    ]);
  });

  it('forbids .envrc (tracked) and any .env* file in the build, but not .env.example', () => {
    expect(scanTracked(['.envrc', 'apps/server/.envrc', '.env.example'], cfg, () => 'FLAT_TOKEN=x').map((x) => x.split(':')[0])).toEqual(['.envrc', 'apps/server/.envrc']);
    expect(scanDist(dist({ '.envrc': 'export A=1', '.env.local': 'A=1', 'assets/.env': 'A=1' }), cfg).map((x) => x.split(':')[0]).sort()).toEqual(['.env.local', '.envrc', 'assets/.env']);
    expect(scanTracked(['.envrc'], cfg, () => 'export X=https://www.ikea.com')).toEqual(expect.arrayContaining(['.envrc: mentions retailer host ikea.com']));
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
  it('passes the lazy HD tier when it is listed in its own catalog, and flags HD files that are not', () => {
    const files = { 'models/catalog.json': catalog, 'models/sofa.glb': 'bin', 'models-hd/catalog.json': JSON.stringify([{ file: 'hero.glb' }]), 'models-hd/hero.glb': 'bin' };
    expect(scanDist(dist(files), cfg)).toEqual([]);
    expect(scanDist(dist({ ...files, 'models-hd/leak.glb': 'x' }), cfg)).toEqual(['models-hd/leak.glb: model file in the build that is not in the models catalog']);
    expect(scanDist(dist({ 'models/catalog.json': catalog, 'models/sofa.glb': 'bin', 'models-hd/hero.glb': 'x' }), cfg)).toHaveLength(1);
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
    const files = ['apps/web/public/models/sofa.glb', 'apps/web/public/models-hd/hero.glb', 'apps/web/public/models-hd/thumbs/a.webp', 'apps/web/public/models/thumbs/a.webp', '.env.example', 'docs/notes.md', 'apps/server/src/providers/ikea.ts', 'scripts/ci/x.mjs'];
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
