import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Material } from '../schema';
import { Catalog, CatalogEntry, materialFromCatalog } from './catalog';

const repo = resolve(__dirname, '../../../..');
const dir = resolve(repo, 'apps/web/public/materials');
const raw: unknown = JSON.parse(readFileSync(resolve(dir, 'catalog.json'), 'utf8'));
const catalog = Catalog.parse(raw);
const first = catalog[0]!;

describe('material catalog.json', () => {
  it('validates and holds about two dozen materials', () => {
    expect(catalog.length).toBeGreaterThanOrEqual(20);
    expect(catalog.length).toBeLessThanOrEqual(30);
  });

  it('has CC0 licences, unique ids and positive tile sizes', () => {
    expect(new Set(catalog.map((e) => e.id)).size).toBe(catalog.length);
    for (const e of catalog) {
      expect(e.license).toBe('CC0-1.0');
      expect(e.tileSizeM).toBeGreaterThan(0);
    }
  });

  it('rejects duplicate ids and non-CC0 entries', () => {
    expect(Catalog.safeParse([first, first]).success).toBe(false);
    expect(CatalogEntry.safeParse({ ...first, license: 'CC-BY-4.0' }).success).toBe(false);
  });

  it('references files that exist, with matching sizes, within the byte budgets', () => {
    let total = 0;
    for (const e of catalog) {
      let sum = 0;
      for (const [map, file] of Object.entries(e.files)) {
        const p = resolve(dir, e.id, file);
        expect(existsSync(p), p).toBe(true);
        const size = statSync(p).size;
        expect(size, `${e.id}/${map}`).toBe((e.fileBytes as Record<string, number>)[map]);
        sum += size;
      }
      expect(Object.keys(e.files).sort()).toEqual(['color', 'normal', 'roughness', 'thumb']);
      expect(sum).toBe(e.bytes);
      expect(sum, e.id).toBeLessThanOrEqual(350 * 1024);
      total += sum;
    }
    expect(total).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('is credited with source URL and licence in docs/MATERIALS-CREDITS.md', () => {
    const credits = readFileSync(resolve(repo, 'docs/MATERIALS-CREDITS.md'), 'utf8');
    for (const e of catalog) {
      const row = credits.split('\n').find((l: string) => l.includes(`\`${e.id}\``));
      expect(row, e.id).toBeDefined();
      expect(row).toContain(e.sourceUrl);
      expect(row).toContain('CC0-1.0');
    }
  });
});

describe('materialFromCatalog', () => {
  it.each(catalog.map((e) => [e.id, e] as const))('%s yields a valid texture Material', (_id, entry) => {
    const m = materialFromCatalog(entry);
    expect(Material.safeParse(m).success).toBe(true);
    expect(m).toMatchObject({
      kind: 'texture',
      textureUrl: `lib:${entry.id}`,
      textureScale: entry.tileSizeM,
      color: entry.meanColor,
      roughness: entry.roughness,
    });
  });

  it('is deterministic and honours overrides', () => {
    const e = first;
    expect(materialFromCatalog(e)).toEqual(materialFromCatalog(e));
    expect(materialFromCatalog(e, { id: 'floor-1', roughness: 0.2 })).toMatchObject({ id: 'floor-1', roughness: 0.2 });
  });
});
