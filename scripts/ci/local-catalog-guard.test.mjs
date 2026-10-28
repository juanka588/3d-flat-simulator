/* global URL */
// The local product catalogue (`pnpm catalog:build`, apps/server/local-assets/ikea-fr) is personal-use data: it must never be
// committed or end up in the Pages build. These tests pin the three guards: .gitignore, the CI scan of tracked files, the scan of dist.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, scanDist, scanTracked } from './check-no-retailer.mjs';

const cfg = loadConfig();
const root = new URL('../../', import.meta.url).pathname;
const mkdist = (files) => {
  const d = mkdtempSync(join(tmpdir(), 'dist-cat-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
};

describe('the local product catalogue stays local', () => {
  it('fails when a file of the catalogue folder is tracked (catalog.json, models, photos)', () => {
    const files = ['apps/server/local-assets/ikea-fr/catalog.json', 'apps/server/local-assets/ikea-fr/models/80275887.glb', 'apps/server/local-assets/ikea-fr/photos/80275887.webp'];
    const p = scanTracked(files, cfg, () => undefined);
    for (const f of files) expect(p.some((x) => x.startsWith(`${f}:`) && /forbidden/.test(x)), f).toBe(true);
  });

  it('fails when a tracked file carries the catalogue marker outside the allowed code and docs', () => {
    const p = scanTracked(['apps/web/src/leak.ts', 'apps/server/src/providers/local/schema.ts'], cfg, () => 'const m = "flat-local-catalog"');
    expect(p).toEqual(['apps/web/src/leak.ts: carries the local-only marker "flat-local-catalog"']);
  });

  it('fails when the built dist holds the folder, a catalogue file under any name, or a stray model', () => {
    expect(scanDist(mkdist({ 'local-assets/ikea-fr/photos/a.webp': 'x' }), cfg).join('\n')).toMatch(/forbidden folder local-assets/);
    expect(scanDist(mkdist({ 'data/products.json': '{"marker":"flat-local-catalog","version":1}' }), cfg)).toEqual(['data/products.json: carries the local-only marker "flat-local-catalog"']);
    expect(scanDist(mkdist({ 'models/80275887.glb': 'glTF....' }), cfg).join('\n')).toMatch(/model file in the build/);
    expect(scanDist(mkdist({ 'index.html': '<html></html>' }), cfg)).toEqual([]);
  });

  it('is ignored by version control, so it cannot be committed by accident', () => {
    for (const f of ['apps/server/local-assets/ikea-fr/catalog.json', 'apps/server/local-assets/ikea-fr/models/80275887.glb', 'apps/server/local-assets/ikea-fr/photos/80275887.webp']) {
      expect(() => execFileSync('git', ['check-ignore', '-q', f], { cwd: root }), f).not.toThrow();
    }
  });
});
