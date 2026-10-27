import { describe, expect, it } from 'vitest';
import { applyCommand, makeEnvelope } from '../commands';
import type { Item, Scene } from '../schema';
import { parseScene } from '../parse';
import { solvePlacement } from './solve';
import { supportTop } from './support';
import { validateLayout } from './validateLayout';
import { BARE_CHARME, mkItem, withItems } from './testUtil';

const d = (w: number, dd: number, h: number) => ({ w, d: dd, h });
const nightstand = mkItem('stand', { position: [8, 1], roomId: 'ch1', dims: d(0.45, 0.4, 0.55), product: product('bedside', d(0.45, 0.4, 0.55)) });
const table = mkItem('tbl', { position: [8, 3], roomId: 'ch1', dims: d(1.2, 0.7, 0.74), product: product('table', d(1.2, 0.7, 0.74)) });
const sofa = mkItem('sofa', { position: [8, 2], roomId: 'ch1', dims: d(2, 0.9, 0.85), product: product('sofa', d(2, 0.9, 0.85)) });
const rug = mkItem('rug', { position: [8, 2], roomId: 'ch1', dims: d(2, 3, 0.01), product: product('rug', d(2, 3, 0.01)) });
const wallShelf = mkItem('hung', { position: [8, 0.2], roomId: 'ch1', mount: 'wall', elevation: 1.2, dims: d(0.6, 0.2, 0.2) });

function product(category: string, dims: { w: number; d: number; h: number }): Item['product'] {
  return { provider: 'mock', sku: `${category}-1`, name: category, url: 'https://example.test/p', price: 10, currency: 'EUR', dims, category: category as never, snapshotAt: '2026-10-27T10:00:00.000Z' };
}
const scene = (...items: Item[]): Scene => withItems(BARE_CHARME, items);
const on = (itemId: string, extra: object = {}) => ({ kind: 'on' as const, itemId, ...extra });

describe('relation "on" (decor on furniture)', () => {
  it('a table lamp stands on a nightstand: elevation is the top of the nightstand, centred on it', () => {
    const r = solvePlacement(scene(nightstand), { roomId: 'ch1', dims: d(0.2, 0.2, 0.4), category: 'lamp', relation: on('stand') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.placement.position).toEqual([8, 1]);
    expect(r.placement.elevation).toBeCloseTo(0.55, 4);
    expect(r.placement.relation).toMatchObject({ kind: 'on', itemId: 'stand' });
    expect(r.rationale.join(' ')).toMatch(/on top of "stand"/);
  });

  it('follows the rotation of the support and an offset in its frame', () => {
    const turned = { ...nightstand, rotation: 90 };
    const r = solvePlacement(scene(turned), { roomId: 'ch1', dims: d(0.1, 0.1, 0.3), category: 'vase', relation: on('stand', { offset: [0.1, 0] }) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.placement.rotation).toBe(90);
    // local +x at rotation 90 is plan -y
    expect(r.placement.position[0]).toBeCloseTo(8, 3);
    expect(r.placement.position[1]).toBeCloseTo(0.9, 3);
  });

  it('refuses a footprint that does not fit on the top, and says the size of the top', () => {
    const r = solvePlacement(scene(nightstand), { roomId: 'ch1', dims: d(0.7, 0.7, 0.4), category: 'lamp', relation: on('stand') });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations[0]).toMatchObject({ code: 'invalid_relation' });
    expect(r.violations[0]!.message).toMatch(/does not fit on top of "stand"/);
  });

  it('decor categories stand on furniture: lamp, vase, plant, frame, books (decor)', () => {
    for (const category of ['lamp', 'vase', 'plant', 'frame', 'decor'] as const) {
      expect(solvePlacement(scene(table), { roomId: 'ch1', dims: d(0.15, 0.15, 0.3), category, relation: on('tbl') }).ok, category).toBe(true);
    }
  });

  it('a floor lamp (over 0.8 m) does not stand on furniture; a sofa takes only cushions and throws; a rug takes nothing', () => {
    const floorLamp = solvePlacement(scene(table), { roomId: 'ch1', dims: d(0.3, 0.3, 1.5), category: 'lamp', relation: on('tbl') });
    expect(!floorLamp.ok && floorLamp.violations[0]!.message).toMatch(/floor lamp/);
    const vaseOnSofa = solvePlacement(scene(sofa), { roomId: 'ch1', dims: d(0.15, 0.15, 0.3), category: 'vase', relation: on('sofa') });
    expect(!vaseOnSofa.ok && vaseOnSofa.violations[0]!.message).toMatch(/only a cushion or throw/);
    const onRug = solvePlacement(scene(rug), { roomId: 'ch1', dims: d(0.15, 0.15, 0.3), category: 'vase', relation: on('rug') });
    expect(!onRug.ok && onRug.violations[0]!.message).toMatch(/floor covering/);
    const tableOnTable = solvePlacement(scene(table), { roomId: 'ch1', dims: d(0.5, 0.5, 0.7), category: 'table', relation: on('tbl') });
    expect(tableOnTable.ok).toBe(false);
    const hung = solvePlacement(scene(wallShelf), { roomId: 'ch1', dims: d(0.1, 0.1, 0.2), category: 'vase', relation: on('hung') });
    expect(hung.ok).toBe(true); // a shelf on the wall carries a vase
  });

  it('cushions and throws go on a sofa (seat height, towards the front) or a bed', () => {
    const c = solvePlacement(scene(sofa), { roomId: 'ch1', dims: d(0.4, 0.4, 0.12), category: 'cushion', relation: on('sofa') });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.placement.elevation).toBeCloseTo(Math.min(0.46, 0.85 * 0.55), 3);
    const t = solvePlacement(scene(sofa), { roomId: 'ch1', dims: d(1.3, 1.7, 0.02), category: 'throw', relation: on('sofa') });
    expect(t.ok).toBe(true); // a throw drapes over the edge: only its centre has to be on the sofa
    const bed = mkItem('bed', { position: [8, 2], roomId: 'ch1', dims: d(1.6, 2, 0.5), product: product('bed', d(1.6, 2, 0.5)) });
    const onBed = solvePlacement(scene(bed), { roomId: 'ch1', dims: d(0.6, 0.4, 0.15), category: 'cushion', relation: on('bed') });
    expect(onBed.ok && onBed.placement.elevation).toBeCloseTo(0.5, 3);
    const onTable = solvePlacement(scene(table), { roomId: 'ch1', dims: d(0.4, 0.4, 0.12), category: 'cushion', relation: on('tbl') });
    expect(!onTable.ok && onTable.violations[0]!.message).toMatch(/goes on a sofa/);
    expect(supportTop(sofa)).toBeCloseTo(0.46, 3);
  });

  it('unknown or self supports, wall mounts and other rooms are invalid_relation', () => {
    expect(solvePlacement(scene(table), { roomId: 'ch1', dims: d(0.2, 0.2, 0.3), category: 'vase', relation: on('nope') }).ok).toBe(false);
    const wallMounted = solvePlacement(scene(table), { roomId: 'ch1', dims: d(0.2, 0.05, 0.3), mount: 'wall', category: 'frame', relation: on('tbl') });
    expect(!wallMounted.ok && wallMounted.violations[0]!.message).toMatch(/wall-mounted item cannot stand/);
    const elsewhere = solvePlacement(scene({ ...table, roomId: 'ch2' }), { roomId: 'ch1', dims: d(0.2, 0.2, 0.3), category: 'vase', relation: on('tbl') });
    expect(!elsewhere.ok && elsewhere.violations[0]!.message).toMatch(/not in "ch1"/);
  });

  it('decor on furniture is accepted by the scene, the item.place command and validate_layout; a low rug-like item still does not collide', () => {
    const base = scene(nightstand);
    const r = solvePlacement(base, { roomId: 'ch1', dims: d(0.2, 0.2, 0.4), category: 'lamp', relation: on('stand') });
    if (!r.ok) throw new Error('not placed');
    const item = { assetId: 'param:test', position: r.placement.position, rotation: 0, elevation: r.placement.elevation, roomId: 'ch1', mount: 'floor', dims: d(0.2, 0.2, 0.4), relation: r.placement.relation, product: { ...product('lamp', d(0.2, 0.2, 0.4)), sku: 'lamp-1' } };
    const out = applyCommand(base, makeEnvelope({ type: 'item.place', item } as never, { id: 'c1', ts: 1, author: { kind: 'llm', name: 't' } }), { rev: 0 });
    expect(out.ok, JSON.stringify(out.ok ? '' : out.errors)).toBe(true);
    if (!out.ok) return;
    expect(parseScene(JSON.parse(JSON.stringify(out.scene))).ok).toBe(true);
    const report = validateLayout(out.scene, { roomId: 'ch1' });
    expect(report.violations.filter((v) => v.code === 'overlap')).toEqual([]);
  });

  it('a floor item at a height without the "on" relation is still invalid', () => {
    const r = parseScene({ ...JSON.parse(JSON.stringify(BARE_CHARME)), items: [{ id: 'x', assetId: 'param:test', position: [8, 2], rotation: 0, elevation: 0.5, mount: 'floor' }] });
    expect(r.ok).toBe(false);
  });
});
