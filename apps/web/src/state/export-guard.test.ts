import { describe, expect, it } from 'vitest';
import { applyCommand, makeEnvelope, parseScene, serializeScene } from '@flat/scene';
import type { Scene } from '@flat/scene';
import { readFileSync } from 'node:fs';
import { findExportViolations } from './export-guard';

const charme = JSON.parse(readFileSync(new URL('../../../../packages/scene/fixtures/charme-3205.flat.json', import.meta.url), 'utf8')) as Record<string, unknown>;

function withBed(): Scene {
  const base = parseScene(charme);
  if (!base.ok) throw new Error('fixture');
  const cmd = {
    type: 'item.place',
    item: {
      assetId: 'product:mock',
      position: [8.2, 2],
      roomId: 'ch1',
      mount: 'floor',
      dims: { w: 1.6, d: 2, h: 0.9 },
      mesh: { kind: 'provider' },
      productRef: { provider: 'mock', sku: 'MOCK-BED-160' },
      product: { provider: 'mock', sku: 'MOCK-BED-160', name: 'Bed', url: 'https://shop.mock.example/p/mock-bed-160', price: 299, currency: 'EUR', dims: { w: 1.6, d: 2, h: 0.9 }, category: 'bed', snapshotAt: '2026-10-27T10:00:00.000Z' },
    },
  };
  const r = applyCommand(base.scene, makeEnvelope(cmd as never, { id: 'e1', ts: 1, author: { kind: 'user' } }));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.scene;
}

describe('export allow-list', () => {
  it('a flat with a placed product exports only the reference and the snapshot', () => {
    const text = serializeScene(withBed());
    expect(text).toContain('MOCK-BED-160');
    expect(findExportViolations(JSON.parse(text))).toEqual([]);
  });
  it('the plain Charme flat is clean', () => {
    expect(findExportViolations(charme)).toEqual([]);
  });
  it('flags photos, models, other URLs and unknown product fields', () => {
    const doc = JSON.parse(serializeScene(withBed())) as { items: Record<string, unknown>[] };
    const bed = doc.items.at(-1) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    bed['product'].photoUrl = 'https://cdn.example/bed.jpg';
    bed['product'].extra = 1;
    bed['modelRef'] = 'x';
    bed['thumb'] = 'data:image/png;base64,AAAA';
    doc.items[0]!['note'] = 'see https://example.com';
    const found = findExportViolations(doc).join('\n');
    expect(found).toContain('photoUrl: forbidden key');
    expect(found).toContain('product.extra: not a snapshot field');
    expect(found).toContain('modelRef: forbidden key');
    expect(found).toContain('a URL or file reference');
    expect(found).toContain('items.0.note: not an item field');
    // the buy link itself is allowed
    expect(found).not.toMatch(/product\.url/);
  });
});
