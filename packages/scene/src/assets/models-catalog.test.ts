import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MeshAsset } from './mesh-catalog';

// Validation of the committed CC0 / CC-BY model library (apps/web/public/models, built by `pnpm models:build`).
const repo = resolve(__dirname, '../../../..');
const dir = resolve(repo, 'apps/web/public/models');
const raw = JSON.parse(readFileSync(resolve(dir, 'catalog.json'), 'utf8')) as Record<string, unknown>[];

/** The catalog entries carry extras (sha256, bytes, ...) next to the `MeshAsset` fields; loaders pick the latter. */
const ASSET_KEYS = ['id', 'name', 'source', 'licence', 'credit', 'category', 'styleTags', 'nativeDims', 'anchor', 'front', 'file', 'generator'];
const pick = (e: Record<string, unknown>) => Object.fromEntries(ASSET_KEYS.filter((k) => k in e).map((k) => [k, e[k]]));
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('public/models/catalog.json', () => {
  it('holds 30-40 entries that validate against MeshAsset', () => {
    expect(raw.length).toBeGreaterThanOrEqual(30);
    expect(raw.length).toBeLessThanOrEqual(40);
    for (const e of raw) {
      const r = MeshAsset.safeParse(pick(e));
      expect(r.success, `${String(e.id)}: ${r.success ? '' : r.error.message}`).toBe(true);
    }
  });

  it('covers the furniture categories the placement needs', () => {
    const cats = new Set(raw.map((e) => e.category));
    for (const c of ['bed', 'sofa', 'armchair', 'table', 'chair', 'desk', 'shelf', 'wardrobe', 'drawers', 'bedside', 'lamp', 'rug', 'mirror', 'tv_unit', 'sideboard', 'kitchen']) {
      expect(cats.has(c), `category ${c}`).toBe(true);
    }
  });

  it('has unique ids, cc0 source, cc0 or cc-by licences, and a credit line', () => {
    expect(new Set(raw.map((e) => e.id)).size).toBe(raw.length);
    for (const e of raw) {
      expect(e.source).toBe('cc0');
      expect(['CC0-1.0', 'CC-BY-4.0']).toContain(e.licence);
      expect(String(e.credit ?? '').length).toBeGreaterThan(0);
      if (e.licence === 'CC-BY-4.0') expect(String(e.credit)).toMatch(/\bby\b/i);
      expect(e.licenseEvidence).toBeTruthy();
    }
  });

  it('is in the item frame: front +z, anchor at the origin, metre-sized dims', () => {
    for (const e of raw) {
      const a = MeshAsset.parse(pick(e));
      expect(a.front).toBe('+z');
      expect(a.anchor).toEqual([0, 0, 0]);
      expect(Math.max(a.nativeDims.w, a.nativeDims.d, a.nativeDims.h)).toBeLessThan(4);
    }
  });

  it('has its files, with matching hashes, within the budgets', () => {
    let total = 0;
    for (const e of raw) {
      const glb = resolve(dir, String(e.file));
      const thumb = resolve(dir, String(e.thumb));
      expect(existsSync(glb), String(e.file)).toBe(true);
      expect(existsSync(thumb), String(e.thumb)).toBe(true);
      expect(sha(glb)).toBe(e.sha256);
      const bytes = statSync(glb).size;
      total += bytes;
      expect(bytes).toBe(e.bytes);
      expect(bytes).toBeLessThanOrEqual(300 * 1024);
      expect(e.triangles as number).toBeLessThanOrEqual(20_000);
      expect(e.materials as number).toBeLessThanOrEqual(4);
    }
    expect(total).toBeLessThanOrEqual(6 * 1024 * 1024);
  });

  it('rejects an entry with an unknown category or a non-relative file', () => {
    const e = pick(raw[0]!);
    expect(MeshAsset.safeParse({ ...e, category: 'spaceship' }).success).toBe(false);
    expect(MeshAsset.safeParse({ ...e, file: '../x.glb' }).success).toBe(false);
  });
});
