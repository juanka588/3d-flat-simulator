import { describe, expect, it } from 'vitest';
import { applyCommand, makeEnvelope, parseScene } from '@flat/scene';
import { ProductRecord } from '@flat/assets';
import { readFileSync } from 'node:fs';
import { commandForKey, generatorSource, itemKeyAction, libraryModelSource, moveCommand, nudged, placeCommand, productSource, snapshotOf } from './place';

const charme = parseScene(JSON.parse(readFileSync(new URL('../../../../packages/scene/fixtures/charme-3205.flat.json', import.meta.url), 'utf8')));
if (!charme.ok) throw new Error('fixture');
const products = (JSON.parse(readFileSync(new URL('../../../../packages/scene/fixtures/products.json', import.meta.url), 'utf8')) as unknown[]).map((p) => ProductRecord.parse(p));
const bedRecord = products.find((p) => p.sku === 'MOCK-BED-160')!;
const env = (cmd: never) => makeEnvelope(cmd, { id: 'e', ts: 1, author: { kind: 'user' } });
const key = (k: string, extra: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => itemKeyAction({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

describe('the command built from a drop', () => {
  it('places a product with its snapshot from the server record, as one item.place', () => {
    const source = productSource({ provider: 'mock', productId: 'mock:MOCK-BED-160', name: bedRecord.name, dims: bedRecord.dims, mount: 'floor', has3d: true });
    expect(source.productRef).toEqual({ provider: 'mock', sku: 'MOCK-BED-160' });
    expect(source.mesh).toEqual({ kind: 'provider' });
    const snapshot = snapshotOf({ ...bedRecord, fetchedAt: '2026-10-27T10:00:00.000Z' });
    expect(snapshot).toMatchObject({ price: 299, snapshotAt: '2026-10-27T10:00:00.000Z' });
    const cmd = placeCommand(source, { position: [8.2, 2], rotation: 0, elevation: 0 }, 'ch1', snapshot);
    const r = applyCommand(charme.scene, env(cmd as never));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const item = r.scene.items.at(-1)!;
      expect(item).toMatchObject({ roomId: 'ch1', dims: bedRecord.dims, productRef: { provider: 'mock', sku: 'MOCK-BED-160' }, mesh: { kind: 'provider' } });
      expect(item.product).not.toHaveProperty('photoUrl');
    }
  });
  it('refuses a non-TTC record', () => {
    expect(() => snapshotOf({ ...bedRecord, priceTtc: false })).toThrow(RangeError);
  });
  it('library items carry no product and are flagged', () => {
    const g = generatorSource({ id: 'bed', label: 'Bed' }, { w: 1.6, l: 2, h: 0.9, headboard: true }, { w: 1.6, d: 2, h: 0.9 });
    expect(g).toMatchObject({ assetId: 'param:bed', noProduct: true });
    const cmd = placeCommand(g, { position: [8.2, 2], rotation: 0, elevation: 0 }, 'ch1');
    const r = applyCommand(charme.scene, env(cmd as never));
    expect(r.ok).toBe(true);
    const m = libraryModelSource({ id: 'kenney:kenney_bed_double', name: 'Double Bed', nativeDims: { w: 1.7214, d: 2.0249, h: 0.675 } });
    expect(m.dims).toEqual({ w: 1.721, d: 2.025, h: 0.675 });
    expect(m.mesh).toEqual({ kind: 'lookalike', assetId: 'kenney:kenney_bed_double' });
  });
  it('wall mounts get an elevation, floor items stay at 0', () => {
    const wall = productSource({ provider: 'mock', sku: 'M', name: 'Mirror', dims: { w: 0.5, d: 0.03, h: 1.5 }, mount: 'wall' });
    expect(wall.elevation).toBe(1.2);
    expect((placeCommand(wall, { position: [1, 1], rotation: 0, elevation: 1 }, 'r') as { item: { elevation: number } }).item.elevation).toBe(1);
    const floor = productSource({ provider: 'mock', sku: 'F', name: 'Bed', dims: { w: 1, d: 1, h: 1 }, mount: 'floor' });
    expect((placeCommand(floor, { position: [1, 1], rotation: 0, elevation: 1 }, 'r') as { item: { elevation: number } }).item.elevation).toBe(0);
  });
  it('move steps keep the same patch keys so they coalesce', () => {
    const a = moveCommand('x', { position: [1, 1], rotation: 0, elevation: 0 }, false);
    const b = moveCommand('x', { position: [2, 1], rotation: 0, elevation: 0 }, false);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });
});

describe('keyboard actions', () => {
  it('maps R, Delete and the arrows', () => {
    expect(key('r')).toEqual({ kind: 'rotate', deltaDeg: 90 });
    expect(key('R', { shiftKey: true })).toEqual({ kind: 'rotate', deltaDeg: -90 });
    expect(key('Delete')).toEqual({ kind: 'remove' });
    expect(key('ArrowRight')).toEqual({ kind: 'nudge', dx: 0.01, dy: 0 });
    expect(key('ArrowUp', { shiftKey: true })).toEqual({ kind: 'nudge', dx: 0, dy: -0.05 });
    expect(key('z')).toBeNull();
    expect(key('r', { ctrlKey: true })).toBeNull();
  });
  it('builds the command for the selected item', () => {
    const item = { id: 'i', position: [1, 2] as [number, number], rotation: 270 };
    expect(commandForKey(item, { kind: 'rotate', deltaDeg: 90 })!.cmd).toEqual({ type: 'item.rotate', id: 'i', rotation: 0 });
    expect(commandForKey(item, { kind: 'remove' })!.cmd).toEqual({ type: 'item.remove', id: 'i' });
    const n = commandForKey(item, { kind: 'nudge', dx: 0.01, dy: 0 })!;
    expect(n.coalesce).toBe(true);
    expect(n.cmd).toEqual({ type: 'item.move', id: 'i', position: [1.01, 2] });
    expect(nudged([0.1, 0.2], 0.01, -0.05)).toEqual([0.11, 0.15]);
  });
});

describe('a placement from a cached record', () => {
  it('carries the record date, so an old cached record can go stale', () => {
    const old = { ...bedRecord, fetchedAt: '2026-01-01T00:00:00.000Z' };
    expect(snapshotOf(old).snapshotAt).toBe('2026-01-01T00:00:00.000Z');
    expect(snapshotOf(old, 'oak').snapshotAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
