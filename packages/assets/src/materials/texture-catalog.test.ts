import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Material } from '@flat/scene';
import { Catalog, CatalogEntry, materialFromCatalog } from './texture-catalog';

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

  it('has the sha256 of every file recorded in the catalog', () => {
    for (const e of catalog) {
      for (const [map, file] of Object.entries(e.files)) {
        const digest = createHash('sha256').update(readFileSync(resolve(dir, e.id, file))).digest('hex');
        expect(digest, `${e.id}/${map}`).toBe(e.sha256[map as keyof typeof e.sha256]);
      }
    }
  });

  it('ships no file the catalog does not list', () => {
    const listed = new Set<string>(['catalog.json']);
    for (const e of catalog) for (const file of Object.values(e.files)) listed.add(`${e.id}/${file}`);
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) for (const f of readdirSync(resolve(dir, entry.name))) found.push(`${entry.name}/${f}`);
      else found.push(entry.name);
    }
    expect(found.filter((f) => !listed.has(f))).toEqual([]);
  });

  it('records what was checked for the licence and pins the downloaded originals', () => {
    for (const e of catalog) {
      expect(e.licenseEvidence, e.id).toBeDefined();
      expect(e.licenseEvidence!.needle).toContain('creativecommons.org/publicdomain/zero');
      expect(e.licenseEvidence!.assetApiUrl, e.id).toContain(encodeURIComponent(e.sourceId));
      expect(Object.keys(e.sourceSha256 ?? {}).length, e.id).toBeGreaterThan(0);
    }
    const manifest = JSON.parse(readFileSync(resolve(repo, 'scripts/materials/manifest.json'), 'utf8')) as { slug: string; sourceSha256?: Record<string, string> }[];
    for (const m of manifest) expect(m.sourceSha256, m.slug).toEqual(catalog.find((e) => e.id === m.slug)?.sourceSha256);
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
