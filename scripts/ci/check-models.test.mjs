/* global Buffer */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkModelsDir } from './check-models.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const glb = Buffer.from('glTF-pretend-model');
const thumb = Buffer.from('thumb');
const entry = (over = {}) => ({
  id: 'polyhaven:chair', file: 'chair.glb', thumb: 'thumbs/chair.webp', sha256: sha(glb), thumbSha256: sha(thumb), bytes: glb.length,
  licence: 'CC0-1.0', credit: '"Chair" by A, Poly Haven, CC0-1.0', triangles: 100, materials: 1, ...over,
});
function make(entries = [entry()], extra) {
  const dir = mkdtempSync(join(tmpdir(), 'models-'));
  mkdirSync(join(dir, 'thumbs'));
  writeFileSync(join(dir, 'chair.glb'), glb);
  writeFileSync(join(dir, 'thumbs/chair.webp'), thumb);
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(entries));
  extra?.(dir);
  return dir;
}
const credits = '| Chair (`polyhaven:chair`) |';

describe('models directory gate', () => {
  it('accepts a directory that matches its catalog', () => {
    expect(checkModelsDir(make(), { credits }).problems).toEqual([]);
  });
  it('flags stray, missing and altered files', () => {
    expect(checkModelsDir(make(undefined, (d) => writeFileSync(join(d, 'stray.glb'), 'x')), { credits }).problems).toEqual(['stray.glb: not listed in catalog.json']);
    expect(checkModelsDir(make(undefined, (d) => writeFileSync(join(d, 'chair.glb'), glb.toString() + '!')), { credits }).problems).toEqual(
      expect.arrayContaining(['chair.glb: sha256 differs from catalog.json']),
    );
    expect(checkModelsDir(make([entry({ file: 'gone.glb', sha256: 'a'.repeat(64) }), ]), { credits }).problems).toContain('gone.glb: listed in catalog.json but missing');
  });
  it('enforces the budgets', () => {
    expect(checkModelsDir(make([entry({ triangles: 20_001 })]), { credits }).problems).toContain('polyhaven:chair: 20001 triangles exceed 20000');
    expect(checkModelsDir(make([entry({ materials: 5 })]), { credits }).problems).toContain('polyhaven:chair: 5 materials exceed 4');
    const tiny = { modelBytes: 5, totalBytes: 5, triangles: 20_000, materials: 4 };
    const p = checkModelsDir(make(), { credits, budgets: tiny }).problems;
    expect(p.some((x) => x.includes('per model'))).toBe(true);
    expect(p.some((x) => x.includes('models total'))).toBe(true);
  });
  it('requires licence, credit and a credits-document row', () => {
    expect(checkModelsDir(make([entry({ licence: 'CC-BY-NC-4.0' })]), { credits }).problems[0]).toMatch(/not CC0-1.0 or CC-BY-4.0/);
    expect(checkModelsDir(make([entry({ credit: '' })]), { credits }).problems).toContain('polyhaven:chair: no credit line');
    expect(checkModelsDir(make([entry({ licence: 'CC-BY-4.0', credit: 'Chair, Sketchfab' })]), { credits }).problems[0]).toMatch(/needs an author/);
    expect(checkModelsDir(make(), { credits: 'nothing' }).problems[0]).toMatch(/missing from docs\/MODELS-CREDITS.md/);
  });
});
