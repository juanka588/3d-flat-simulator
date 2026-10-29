import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLocalCatalog } from './catalog';
import { entryFor, writeCatalog } from './fixtures';
import { reclassifyCatalog } from './reclassify';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flat-reclass-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entries = () => [
  entryFor({ sku: '10000001', name: 'ORRSJÖN Vasque avec siphon - blanc 82x49 cm', typeName: 'Vasque avec siphon', category: 'other', mount: 'floor' }),
  entryFor({ sku: '10000002', name: 'ÄNGSJÖN Meuble lavabo avec tiroirs - blanc 80x48x63 cm', typeName: 'Meuble lavabo avec tiroirs', category: 'drawers', mount: 'floor' }),
  entryFor({ sku: '10000003', name: 'ENUDDEN Porte-serviettes avec 2 barres - blanc', typeName: 'Porte-serviettes avec 2 barres', category: 'shelf', mount: 'floor' }),
  entryFor({ sku: '10000004', name: 'KIVIK Canapé 3 places', typeName: 'Canapé 3 places', category: 'sofa', mount: 'floor' }),
];

describe('local catalogue re-classification', () => {
  it('the reader re-classifies on read, so search by the new categories works without rebuilding', async () => {
    await writeCatalog(dir, entries());
    const cat = (await openLocalCatalog(dir))!;
    expect(cat.get('10000001')).toMatchObject({ category: 'washbasin', mount: 'wall' });
    expect(cat.get('10000002')?.category).toBe('vanity');
    expect(cat.search('', { category: 'washbasin', limit: 10 }).map((r) => r.sku)).toEqual(['10000001']);
    expect(cat.search('', { category: 'towel_rail', limit: 10 }).map((r) => r.sku)).toEqual(['10000003']);
    expect(cat.search('vasque', { limit: 10 }).map((r) => r.sku)).toContain('10000001');
    expect(cat.get('10000004')).toMatchObject({ category: 'sofa', mount: 'floor' });
  });

  it('catalog:reclassify rewrites only category and mount, is idempotent and honours --dry', async () => {
    await writeCatalog(dir, entries());
    const path = join(dir, 'catalog.json');
    const before = JSON.parse(await readFile(path, 'utf8'));
    const dry = await reclassifyCatalog(dir, { dryRun: true });
    expect(dry.changes.map((c) => `${c.sku} ${c.from.category}->${c.to.category}/${c.to.mount}`)).toEqual(['10000001 other->washbasin/wall', '10000002 drawers->vanity/floor', '10000003 shelf->towel_rail/wall']);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(before);
    const real = await reclassifyCatalog(dir);
    expect(real.changes).toHaveLength(3);
    const after = JSON.parse(await readFile(path, 'utf8'));
    for (const [i, e] of after.entries.entries()) {
      expect({ ...e.record, category: 'x', mount: 'x' }).toEqual({ ...before.entries[i].record, category: 'x', mount: 'x' });
      expect(e.record.category).toBe(['washbasin', 'vanity', 'towel_rail', 'sofa'][i]);
      expect(e.record.mount).toBe(['wall', 'floor', 'wall', 'floor'][i]);
    }
    expect((await reclassifyCatalog(dir)).changes).toHaveLength(0);
  });
});
