import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProductCategory } from '@flat/scene';
import { LocalCatalogFile } from './schema';
import { reclassifyEntry } from './catalog';

export interface ReclassifyChange {
  sku: string;
  name: string;
  typeName: string;
  from: { category: ProductCategory; mount: string };
  to: { category: ProductCategory; mount: string };
}

/**
 * Offline re-classification of an existing catalogue: rewrites ONLY `record.category` and `record.mount` of the entries the
 * current classifier (`../category.ts`) sees differently. Nothing is downloaded; models, photos and prices are untouched.
 * `dryRun` reports without writing. The server also re-classifies in memory on read, so this only persists the result.
 */
export async function reclassifyCatalog(dir: string, options: { dryRun?: boolean } = {}): Promise<{ total: number; changes: ReclassifyChange[] }> {
  const path = join(dir, 'catalog.json');
  const text = await readFile(path, 'utf8');
  const file = LocalCatalogFile.parse(JSON.parse(text));
  const raw = JSON.parse(text) as { entries: { record: { category: ProductCategory; mount: string } }[] };
  const changes: ReclassifyChange[] = [];
  file.entries.forEach((entry, i) => {
    const next = reclassifyEntry(entry);
    if (next === entry) return;
    changes.push({ sku: entry.record.sku, name: entry.record.name, typeName: entry.typeName, from: { category: entry.record.category, mount: entry.record.mount }, to: { category: next.record.category, mount: next.record.mount } });
    const rec = raw.entries[i]!.record;
    rec.category = next.record.category;
    rec.mount = next.record.mount;
  });
  if (changes.length > 0 && !options.dryRun) {
    LocalCatalogFile.parse(raw); // never write something the reader would refuse
    const tmp = `${path}.reclassify.tmp`;
    await writeFile(tmp, JSON.stringify(raw, null, 2) + '\n');
    await rename(tmp, path);
  }
  return { total: file.entries.length, changes };
}
