/* global Buffer */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compare, measure } from './bundle-size.mjs';
import { checkDirectory } from './check-materials.mjs';

const baseline = { baseline: { js: 400_000, css: 4_000 }, budgetBytes: { js: 30_000, css: 5_000 } };

describe('bundle-size gate', () => {
  it('passes within budget and fails above it, per kind', () => {
    expect(compare(baseline, { js: 429_999, css: 8_999 }).every((r) => r.ok)).toBe(true);
    const over = compare(baseline, { js: 430_001, css: 4_000 });
    expect(over.find((r) => r.kind === 'js')).toMatchObject({ ok: false, growth: 30_001 });
    expect(over.find((r) => r.kind === 'css')?.ok).toBe(true);
    expect(compare(baseline, { js: 100, css: 100 }).every((r) => r.ok)).toBe(true);
  });

  it('measures gzip of js and css only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeFileSync(join(dir, 'a.js'), 'x'.repeat(10_000));
    writeFileSync(join(dir, 'b.css'), 'y'.repeat(10_000));
    writeFileSync(join(dir, 'c.map'), 'z'.repeat(10_000));
    const m = measure(dir);
    expect(m.js).toBeGreaterThan(0);
    expect(m.js).toBeLessThan(200);
    expect(m.css).toBeGreaterThan(0);
  });
});

describe('materials directory gate', () => {
  const make = (extra) => {
    const dir = mkdtempSync(join(tmpdir(), 'mat-'));
    mkdirSync(join(dir, 'm1'));
    const data = Buffer.from('hello');
    writeFileSync(join(dir, 'm1', 'color.webp'), data);
    const sha = createHash('sha256').update(data).digest('hex');
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify([{ id: 'm1', files: { color: 'color.webp' }, sha256: { color: sha } }]));
    extra?.(dir);
    return dir;
  };
  it('accepts a directory that matches its catalog', () => {
    expect(checkDirectory(make()).problems).toEqual([]);
  });
  it('flags unlisted, missing and altered files', () => {
    expect(checkDirectory(make((d) => writeFileSync(join(d, 'm1', 'stray.webp'), 'x'))).problems).toEqual(['m1/stray.webp: not listed in catalog.json']);
    expect(checkDirectory(make((d) => writeFileSync(join(d, '.DS_Store'), 'x'))).problems).toEqual(['.DS_Store: not listed in catalog.json']);
    expect(checkDirectory(make((d) => writeFileSync(join(d, 'm1', 'color.webp'), 'changed'))).problems).toEqual(['m1/color.webp: sha256 differs from catalog.json']);
    const missing = make();
    writeFileSync(join(missing, 'catalog.json'), JSON.stringify([{ id: 'm2', files: { color: 'color.webp' }, sha256: { color: 'a'.repeat(64) } }]));
    expect(checkDirectory(missing).problems).toContain('m2/color.webp: listed in catalog.json but missing');
  });
});
