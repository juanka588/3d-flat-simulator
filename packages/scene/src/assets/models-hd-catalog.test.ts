import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MeshAsset } from './catalog';

// Validation of the committed HD (hero) model tier (apps/web/public/models-hd, built by `pnpm models:hd`).
const repo = resolve(__dirname, '../../../..');
const dir = resolve(repo, 'apps/web/public/models-hd');
const raw = JSON.parse(readFileSync(resolve(dir, 'catalog.json'), 'utf8')) as Record<string, unknown>[];
const ASSET_KEYS = ['id', 'name', 'source', 'licence', 'credit', 'category', 'styleTags', 'nativeDims', 'anchor', 'front', 'file', 'generator', 'tier'];
const pick = (e: Record<string, unknown>) => Object.fromEntries(ASSET_KEYS.filter((k) => k in e).map((k) => [k, e[k]]));
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('public/models-hd/catalog.json', () => {
  it('holds at least 20 hero models that validate against MeshAsset with tier "hd"', () => {
    expect(raw.length).toBeGreaterThanOrEqual(20);
    for (const e of raw) {
      const r = MeshAsset.safeParse(pick(e));
      expect(r.success, `${String(e.id)}: ${r.success ? '' : r.error.message}`).toBe(true);
      expect(e.tier).toBe('hd');
    }
  });

  it('has unique ids, and a credit line (title, author, source URL, licence) for every model', () => {
    expect(new Set(raw.map((e) => e.id)).size).toBe(raw.length);
    for (const e of raw) {
      expect(['CC0-1.0', 'CC-BY-4.0']).toContain(e.licence);
      const credit = String(e.credit ?? '');
      expect(credit, String(e.id)).toMatch(/^".+" by .+, Sketchfab, CC(0|-BY)-[0-9.]+ \(https:\/\/sketchfab\.com\/3d-models\/[^)\s]+\)$/);
      expect(credit.length).toBeLessThanOrEqual(300);
      expect((e.licenseEvidence as { assetApiUrl?: string }).assetApiUrl).toMatch(/^https:\/\/api\.sketchfab\.com\/v3\/models\//);
    }
  });

  it('is in the item frame (front +z, anchor at the origin) with metre-sized dims', () => {
    for (const e of raw) {
      const a = MeshAsset.parse(pick(e));
      expect(a.front).toBe('+z');
      expect(a.anchor).toEqual([0, 0, 0]);
      expect(Math.max(a.nativeDims.w, a.nativeDims.d, a.nativeDims.h)).toBeLessThan(4);
    }
  });

  it('has its files with matching hashes, within the HD budgets (2 MB per model, 40k triangles, 60 MB in total)', () => {
    let total = 0;
    for (const e of raw) {
      const glb = resolve(dir, String(e.file));
      expect(existsSync(glb), String(e.file)).toBe(true);
      expect(existsSync(resolve(dir, String(e.thumb))), String(e.thumb)).toBe(true);
      expect(sha(glb)).toBe(e.sha256);
      const bytes = statSync(glb).size;
      total += bytes;
      expect(bytes).toBe(e.bytes);
      expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(e.triangles as number).toBeLessThanOrEqual(40_000);
    }
    expect(total).toBeLessThanOrEqual(60 * 1024 * 1024);
  });

  it('does not repeat an id of the light tier', () => {
    const light = JSON.parse(readFileSync(resolve(repo, 'apps/web/public/models/catalog.json'), 'utf8')) as { id: string }[];
    const ids = new Set(light.map((e) => e.id));
    for (const e of raw) expect(ids.has(String(e.id))).toBe(false);
  });
});
