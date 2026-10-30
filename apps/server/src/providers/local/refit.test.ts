import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { entryFor, makeGlb, writeCatalog } from './fixtures';
import { bakeQuarterTurn, getIO, measureDocument, readGlb } from './normalise';
import { refitCatalog } from './refit';
import { LocalCatalogFile } from './schema';

// Synthetic boxes only (no retailer data). The "old build" is simulated by baking the turn the way it did.
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const tmp = async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'refit-'));
  dirs.push(dir);
  return dir;
};

interface Item {
  sku: string;
  /** Authored box [x, y, z]. */
  size: [number, number, number];
  dims: { w: number; d: number; h: number };
  category: string;
  typeName: string;
  name: string;
  /** The old build baked a quarter turn into the file. */
  turned: boolean;
}

async function catalogOf(items: Item[]): Promise<string> {
  const dir = await tmp();
  const models: Record<string, Uint8Array> = {};
  const entries = [];
  for (const it of items) {
    let bytes: Uint8Array = await makeGlb({ size: it.size });
    let fitSize = it.size;
    if (it.turned) {
      const doc = await readGlb(bytes);
      bakeQuarterTurn(doc);
      bytes = new Uint8Array(await (await getIO()).writeBinary(doc));
      fitSize = [it.size[2], it.size[1], it.size[0]];
    }
    models[it.sku] = bytes;
    const e = entryFor({ sku: it.sku, name: it.name, category: it.category, typeName: it.typeName, dims: it.dims, has3d: true });
    entries.push({
      ...e,
      model: { ...e.model!, fit: { quarterTurn: it.turned, distortion: 0.04, size: fitSize } },
      flags: it.turned ? ['quarter turn baked in (the model ran along the other axis than the listed width/depth)', 'a dimension missing on the page was derived from the 3D model'] : [],
    });
  }
  await writeCatalog(dir, entries, { models });
  return dir;
}

const sizeOf = async (dir: string, sku: string) => measureDocument(await readGlb(new Uint8Array(await readFile(join(dir, `models/${sku}.glb`))))).size;
const readCatalog = async (dir: string) => LocalCatalogFile.parse(JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8')));

describe('catalog:refit (offline, from the baked GLBs)', () => {
  it('turns a wrongly turned bed back, takes the dims from the model, rewrites the file, and a second run is a no-op', async () => {
    const dir = await catalogOf([{ sku: '10000003', size: [2.4, 0.835, 2.056], dims: { w: 1.6, d: 2.02, h: 0.676 }, category: 'bed', typeName: 'Structure lit avec tête de lit', name: 'TESTBED Structure lit', turned: true }]);
    const dry = await refitCatalog(dir, { dryRun: true });
    expect(dry.changes).toHaveLength(1);
    expect(dry.changes[0]).toMatchObject({ sku: '10000003', turn: { from: true, to: false }, dims: { to: { w: 2.4, d: 2.056, h: 0.835 } } });
    expect((await readCatalog(dir)).entries[0]!.model!.fit.quarterTurn).toBe(true); // the dry run wrote nothing

    await refitCatalog(dir);
    const out = (await readCatalog(dir)).entries[0]!;
    expect(out.record.dims).toEqual({ w: 2.4, d: 2.056, h: 0.835 });
    expect(out.record.dimsSource).toBe('model');
    expect(out.model!.fit).toMatchObject({ quarterTurn: false, size: [2.4, 0.835, 2.056] });
    expect(out.flags.join()).toMatch(/overall size taken from the 3D model/);
    expect(out.flags.join()).not.toMatch(/quarter turn baked/);
    const size = await sizeOf(dir, '10000003');
    expect(size[0]).toBeCloseTo(2.4, 3);
    expect(size[2]).toBeCloseTo(2.056, 3);
    expect((await refitCatalog(dir, { dryRun: true })).changes).toEqual([]);
  });

  it('turns a genuinely sideways model and leaves a correct turn and a correct authored bed alone', async () => {
    const dir = await catalogOf([
      { sku: '10000004', size: [2.02, 0.676, 1.6], dims: { w: 1.6, d: 2.02, h: 0.676 }, category: 'bed', typeName: 'Cadre de lit', name: 'TESTBED sideways', turned: false },
      { sku: '10000005', size: [1.26, 0.9, 0.77], dims: { w: 0.77, d: 1.26, h: 0.9 }, category: 'table', typeName: 'Ilot', name: 'TESTISLAND', turned: true },
      { sku: '10000008', size: [1.6, 0.676, 2.02], dims: { w: 1.6, d: 2.02, h: 0.676 }, category: 'bed', typeName: 'Cadre de lit', name: 'TESTBED fine', turned: false },
    ]);
    const r = await refitCatalog(dir);
    expect(r.changes.map((c) => [c.sku, c.turn.from, c.turn.to])).toEqual([['10000004', false, true]]);
    expect((await readCatalog(dir)).entries[0]!.model!.fit).toMatchObject({ quarterTurn: true, size: [1.6, 0.676, 2.02] });
    const size = await sizeOf(dir, '10000004');
    expect(size[0]).toBeCloseTo(1.6, 3);
    expect(size[2]).toBeCloseTo(2.02, 3);
  });

  it('a desk listed length-as-depth is un-turned and its width and depth swapped', async () => {
    const dir = await catalogOf([{ sku: '10000009', size: [1.4, 0.735, 0.6], dims: { w: 0.6, d: 1.4, h: 0.73 }, category: 'desk', typeName: 'Bureau', name: 'TESTDESK', turned: true }]);
    await refitCatalog(dir);
    const out = (await readCatalog(dir)).entries[0]!;
    expect(out.record.dims).toEqual({ w: 1.4, d: 0.6, h: 0.73 });
    expect(out.record.dimsSource).toBe('structured');
    expect(out.model!.fit.quarterTurn).toBe(false);
    expect(out.flags.join()).toMatch(/width and depth swapped/);
  });

  it('--sku limits the run', async () => {
    const dir = await catalogOf([
      { sku: '10000006', size: [2.02, 0.676, 1.6], dims: { w: 1.6, d: 2.02, h: 0.676 }, category: 'bed', typeName: 'Cadre de lit', name: 'A', turned: false },
      { sku: '10000007', size: [2.02, 0.676, 1.6], dims: { w: 1.6, d: 2.02, h: 0.676 }, category: 'bed', typeName: 'Cadre de lit', name: 'B', turned: false },
    ]);
    expect((await refitCatalog(dir, { dryRun: true, sku: '10000007' })).changes.map((c) => c.sku)).toEqual(['10000007']);
  });
});
