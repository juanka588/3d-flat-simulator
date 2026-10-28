import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLocalCatalog, servedRecord } from './catalog';
import { entryFor, makeGlb, tinyWebp, writeCatalog } from './fixtures';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flat-localcat-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-28T12:00:00Z');

describe('local catalogue reader', () => {
  it('is absent when the folder or catalog.json is missing or invalid', async () => {
    expect(await openLocalCatalog(join(dir, 'nope'))).toBeUndefined();
    await writeFile(join(dir, 'catalog.json'), '{"marker":"nope"}');
    const logs: string[] = [];
    expect(await openLocalCatalog(dir, { log: (_l, m) => logs.push(m) })).toBeUndefined();
    expect(logs.join()).toMatch(/not valid/);
  });

  it('serves records with modelRef only for products that really have a model, and photoUrl only with a photo', async () => {
    const glb = await makeGlb({ size: [1, 0.5, 0.5] });
    await writeCatalog(
      dir,
      [entryFor({ sku: '10000001', name: 'A table', has3d: true, photoUrl: 'https://www.ikea.com/p.jpg' }), entryFor({ sku: '10000002', name: 'B table', has3d: false, noModelReason: 'the product page lists no 3D model', photoUrl: 'https://www.ikea.com/q.jpg' })],
      { models: { '10000001': glb }, photos: { '10000001': await tinyWebp() } },
    );
    const cat = (await openLocalCatalog(dir, { now: () => NOW }))!;
    expect(cat.info()).toMatchObject({ id: 'ikea-fr-local', count: 2, withModels: 1, builtAt: '2026-10-27T12:00:00.000Z', stale: false });
    const a = cat.get('10000001')!;
    expect(a.modelRef).toBe('local:10000001');
    expect(a.photoUrl).toBe('https://www.ikea.com/p.jpg');
    const b = cat.get('10000002')!;
    expect(b.modelRef).toBeUndefined();
    expect(b.photoUrl).toBeUndefined(); // no local photo: nothing for the photo proxy to chase
    expect(cat.get('99999999')).toBeUndefined();
    expect(servedRecord(entryFor({ sku: '10000003', name: 'x' })).modelRef).toBeUndefined();
  });

  it('reads models and photos from disk; a no-model product says why instead of failing', async () => {
    const glb = await makeGlb({ size: [1, 0.5, 0.5] });
    const webp = await tinyWebp();
    await writeCatalog(dir, [entryFor({ sku: '10000001', name: 'A', has3d: true }), entryFor({ sku: '10000002', name: 'B', noModelReason: 'proportions do not match' })], { models: { '10000001': glb }, photos: { '10000001': webp } });
    const cat = (await openLocalCatalog(dir))!;
    const m = await cat.readModel('10000001');
    expect(m).toMatchObject({ state: 'ready' });
    expect(m?.state === 'ready' && m.bytes.byteLength).toBe(glb.byteLength);
    expect(await cat.readModel('10000002')).toEqual({ state: 'none', reason: 'proportions do not match' });
    expect(await cat.readModel('99999999')).toBeUndefined();
    expect((await cat.readPhoto('10000001'))?.byteLength).toBe(webp.byteLength);
    expect(await cat.readPhoto('10000002')).toBeUndefined();
  });

  it('never offers a model whose file is missing or changed since the build (nothing 404s)', async () => {
    const glb = await makeGlb({ size: [1, 0.5, 0.5] });
    await writeCatalog(dir, [entryFor({ sku: '10000001', name: 'A', has3d: true }), entryFor({ sku: '10000002', name: 'B', has3d: true })], { models: { '10000001': glb } });
    // 10000002 lists a model but has no file; 10000001 is truncated after the build
    await writeFile(join(dir, 'models/10000001.glb'), glb.slice(0, 50));
    const logs: string[] = [];
    const cat = (await openLocalCatalog(dir, { log: (_l, m) => logs.push(m) }))!;
    expect(cat.info()).toMatchObject({ count: 2, withModels: 0 });
    expect(cat.get('10000001')!.modelRef).toBeUndefined();
    expect(await cat.readModel('10000002')).toMatchObject({ state: 'none' });
    expect(logs.join()).toMatch(/2 model file\(s\) missing/);
  });

  it('flags prices older than 30 days', async () => {
    await writeCatalog(dir, [entryFor({ sku: '10000001', name: 'A', fetchedAt: '2026-08-01T10:00:00.000Z' }), entryFor({ sku: '10000002', name: 'B', fetchedAt: '2026-10-20T10:00:00.000Z' })]);
    const cat = (await openLocalCatalog(dir, { now: () => NOW }))!;
    expect(cat.isStale('10000001')).toBe(true);
    expect(cat.isStale('10000002')).toBe(false);
    expect(cat.isStale('99999999')).toBe(false);
    expect(cat.info()?.stale).toBe(false); // the newest record is fresh
  });

  it('reloads when the build rewrites catalog.json', async () => {
    let t = NOW;
    await writeCatalog(dir, [entryFor({ sku: '10000001', name: 'First' })]);
    const cat = (await openLocalCatalog(dir, { now: () => t }))!;
    expect(cat.search('first', { limit: 5 })).toHaveLength(1);
    await writeCatalog(dir, [entryFor({ sku: '10000001', name: 'First' }), entryFor({ sku: '10000002', name: 'Second' })]);
    await utimes(join(dir, 'catalog.json'), new Date(NOW + 5000), new Date(NOW + 5000));
    await cat.refresh();
    expect(cat.search('second', { limit: 5 })).toHaveLength(0); // within the 1 s check interval: not looked at yet
    t += 2000;
    await cat.refresh();
    expect(cat.search('second', { limit: 5 }).map((r) => r.sku)).toEqual(['10000002']);
  });
});
