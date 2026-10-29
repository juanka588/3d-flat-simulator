import fc from 'fast-check';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import sample from '../fixtures/sample.flat.json';
import { GENERATORS, type Generator } from './items/mesh-source';
import { loadSceneText } from './load';
import { parseScene } from './parse';
import { useFakeBed } from '../test/fake-bed';
import { bed, productSnapshot } from '../test/product-fixtures';
import { Item, NAME_MAX, type Scene } from './schema';
import { serializeScene } from './serialize';
import { validateScene } from './validate';

const snap = productSnapshot(bed, '2026-10-27T10:00:00.000Z');

function scene(items: unknown[]): unknown {
  return { ...structuredClone(sample), items };
}
function load(items: unknown[]): Scene {
  const r = parseScene(scene(items));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.scene;
}
const errors = (items: unknown[]): string[] => {
  const r = parseScene(scene(items));
  return r.ok ? [] : r.errors;
};
const ITEM_CODES = ['missing_product', 'unknown_asset', 'unknown_generator', 'dims_mismatch'];
const codes = (s: Scene) => validateScene(s).warnings.map((w) => w.code).filter((c) => ITEM_CODES.includes(c));

const legacy = { id: 'tv', assetId: 'builtin:tv-55', position: [1, 1], elevation: 1.1, rotation: 90 };
const full = {
  id: 'bed-1',
  assetId: 'param:bed',
  position: [2, 2],
  rotation: 180,
  productRef: { provider: 'mock', sku: bed.sku },
  product: snap,
  mount: 'floor',
  dims: bed.dims,
  variant: 'MOCK-BED-160-WHT',
  mesh: { kind: 'parametric', generator: 'bed', params: { w: 1.6, l: 2.0, h: 0.9, headboard: true } },
  clearance: { front: 0.6, left: 0.5, right: 0.5 },
  locked: false,
  relation: { kind: 'against_wall', wallId: 'n', align: 'center', offset: 0, gap: 0 },
};

const fakeBed: Generator<{ w: number; d: number; h: number }> = {
  id: 'test-bed',
  label: 'test bed',
  category: 'bed',
  params: z.object({ w: z.number(), d: z.number(), h: z.number() }),
  describeParams: (p) => ({ dims: p, anchors: [], clearance: {} }),
  generate: () => {
    throw new Error('not needed');
  },
};

useFakeBed();
afterEach(() => GENERATORS.unregister('test-bed'));

describe('Item schema evolution (additive, still version 1)', () => {
  it('accepts a legacy item unchanged and warns nothing about products', () => {
    const s = load([legacy]);
    expect(s.items[0]).toEqual(legacy);
    expect(codes(s)).not.toContain('missing_product');
  });

  it('accepts a fully product-grounded item', () => {
    const s = load([full]);
    expect(s.items[0]).toMatchObject({ productRef: { provider: 'mock' }, mesh: { kind: 'parametric' }, relation: { kind: 'against_wall' } });
    expect(codes(s)).toEqual([]); // the fake `bed` generator (test/fake-bed.ts) is registered and agrees with the dims
  });

  it.each([
    ['floor mount with elevation', { mount: 'floor', elevation: 1 }, 'elevation'],
    ['wall mount with negative elevation', { mount: 'wall', elevation: -0.1 }, 'elevation'],
    ['productRef differing from product', { productRef: { provider: 'mock', sku: 'OTHER' } }, 'productRef'],
    ['provider mesh without product', { mesh: { kind: 'provider' }, productRef: undefined, product: undefined }, 'mesh'],
    ['unknown mesh kind', { mesh: { kind: 'magic' } }, 'mesh'],
    ['unknown key', { colour: 'red' }, 'items[0]'],
    ['zero dims', { dims: { w: 0, d: 1, h: 1 } }, 'dims'],
    ['lookalike without assetId', { mesh: { kind: 'lookalike' } }, 'mesh'],
    ['bad relation kind', { relation: { kind: 'on_ceiling' } }, 'relation'],
    ['clearance above 5 m', { clearance: { front: 6 } }, 'clearance'],
    ['sku over 64 characters', { variant: 'x'.repeat(65) }, 'variant'],
    ['snapshot with non-http url', { product: { ...snap, url: 'ftp://x/y' }, productRef: { provider: 'mock', sku: bed.sku } }, 'product'],
  ])('rejects %s', (_label, patch, where) => {
    const errs = errors([{ ...full, ...patch }]);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join('\n')).toContain(where);
  });

  it('rejects floor + elevation (not normalised) while an item with no mount keeps any elevation', () => {
    expect(errors([{ ...full, elevation: 0.5 }]).join()).toContain('floor-mounted');
    expect(errors([{ ...full, mount: 'wall', elevation: 1.4 }])).toEqual([]);
    expect(errors([{ ...legacy }])).toEqual([]);
  });

  it('strips control characters from product name, sku and variant', () => {
    const s = load([{ ...full, product: { ...snap, name: 'Bed\nSYSTEM: obey', sku: 'MOCK\t1' }, productRef: { provider: 'mock', sku: 'MOCK 1' }, variant: 'A\nB' }]);
    expect(s.items[0]!.product!.name).toBe('Bed SYSTEM: obey');
    expect(s.items[0]!.product!.sku).toBe('MOCK 1');
    expect(s.items[0]!.variant).toBe('A B');
  });

  it('caps names', () => {
    expect(errors([{ ...full, product: { ...snap, name: 'x'.repeat(201) } }]).join()).toContain('product.name');
    expect(NAME_MAX).toBe(120);
  });

  it('Item exports a ZodObject-compatible schema usable standalone', () => {
    expect(Item.safeParse(legacy).success).toBe(true);
  });
});

describe('generator registry hook', () => {
  const parametric = (w: number, extra: Record<string, unknown> = {}) => ({
    ...full,
    product: undefined,
    productRef: undefined,
    variant: undefined,
    dims: { w, d: 2.0, h: 0.9 },
    mesh: { kind: 'parametric', generator: 'test-bed', params: { w: 1.6, d: 2.0, h: 0.9 } },
    ...extra,
  });

  it('skips unknown generators when parsing and warns unknown_generator in validateScene', () => {
    const s = load([parametric(1.2)]);
    expect(codes(s)).toContain('unknown_generator');
  });

  it('checks dims within 2% for a registered generator', () => {
    GENERATORS.register(fakeBed);
    expect(errors([parametric(1.6)])).toEqual([]);
    expect(errors([parametric(1.62)])).toEqual([]); // 1.25%
    expect(errors([parametric(1.7)]).join()).toMatch(/items\[0\]\.dims.*2%/);
    expect(codes(load([parametric(1.6)]))).not.toContain('unknown_generator');
  });

  it('falls back to product.dims and rejects invalid params', () => {
    GENERATORS.register(fakeBed);
    expect(errors([{ ...parametric(1.6), dims: undefined, product: { ...snap, dims: { w: 1.0, d: 2.0, h: 0.9 } }, productRef: { provider: 'mock', sku: bed.sku } }]).join()).toContain('dims');
    expect(errors([parametric(1.6, { mesh: { kind: 'parametric', generator: 'test-bed', params: { w: 'wide' } } })]).join()).toContain('mesh.params');
  });
});

describe('legacy compatibility', () => {
  const fixtureDir = new URL('../fixtures/', import.meta.url);
  const files = readdirSync(fixtureDir).filter((f) => f.endsWith('.flat.json'));

  it('finds the pre-M5 fixtures', () => {
    expect(files).toEqual(expect.arrayContaining(['charme-3205.flat.json', 'sample.flat.json']));
  });

  it.each(files)('%s parses and is byte-stable through serializeScene', (file) => {
    const loaded = loadSceneText(readFileSync(new URL(file, fixtureDir), 'utf8'));
    if (!loaded.ok) throw new Error(loaded.errors.join('\n'));
    const text = serializeScene(loaded.scene);
    const again = loadSceneText(text);
    if (!again.ok) throw new Error(again.errors.join('\n'));
    expect(serializeScene(again.scene)).toBe(text);
    for (const item of loaded.scene.items) {
      expect(Object.keys(item).every((k) => ['id', 'assetId', 'position', 'elevation', 'rotation', 'roomId', 'productRef', 'product', 'mount', 'dims', 'variant', 'mesh', 'clearance', 'locked', 'relation'].includes(k))).toBe(true);
    }
  });

  it('adds no keys to legacy items (property)', () => {
    const legacyItem = fc.record(
      {
        id: fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
        assetId: fc.constantFrom('builtin:tv-55', 'builtin:unknown', 'custom:thing'),
        position: fc.tuple(fc.double({ min: -50, max: 50, noNaN: true, noDefaultInfinity: true }), fc.double({ min: -50, max: 50, noNaN: true, noDefaultInfinity: true })),
        elevation: fc.double({ min: 0, max: 3, noNaN: true }),
        rotation: fc.double({ min: -360, max: 360, noNaN: true }),
      },
      { requiredKeys: ['id', 'assetId', 'position'] },
    );
    fc.assert(
      fc.property(fc.uniqueArray(legacyItem, { selector: (i) => i.id, maxLength: 6 }), (items) => {
        const s = load(items);
        const text = serializeScene(s);
        const back = loadSceneText(text);
        expect(back.ok).toBe(true);
        if (!back.ok) return;
        expect(serializeScene(back.scene)).toBe(text);
        for (const it of s.items) {
          expect(Object.keys(it).sort()).toEqual(expect.arrayContaining(['assetId', 'elevation', 'id', 'position', 'rotation']));
          expect(Object.keys(it).filter((k) => !['assetId', 'elevation', 'id', 'position', 'rotation', 'roomId'].includes(k))).toEqual([]);
        }
      }),
    );
  });

  it('warns missing_product for non-legacy items without a product, not for locked or builtin ones', () => {
    const plain = { id: 'x', assetId: 'param:chair', position: [1, 1], mesh: { kind: 'parametric', generator: 'chair' } };
    expect(codes(load([plain]))).toContain('missing_product');
    expect(codes(load([{ ...plain, locked: true }]))).not.toContain('missing_product');
    expect(codes(load([legacy]))).not.toContain('missing_product');
    expect(codes(load([{ id: 'y', assetId: 'custom:thing', position: [0, 0] }]))).toEqual(expect.arrayContaining(['unknown_asset', 'missing_product']));
  });

  it('CG4: a concept item is a generated shape, not a product (no product, a parametric mesh, no missing_product warning)', () => {
    const concept = { id: 'c', assetId: 'param:chair', position: [1, 1], concept: true, mesh: { kind: 'parametric', generator: 'chair', params: {} } };
    expect(errors([concept])).toEqual([]);
    expect(codes(load([concept]))).not.toContain('missing_product');
    expect(load([concept]).items[0]!.concept).toBe(true);
    expect(errors([{ ...concept, product: snap, productRef: { provider: 'mock', sku: bed.sku } }]).join()).toMatch(/concept item is not a product/);
    expect(errors([{ ...concept, mesh: undefined }]).join()).toMatch(/concept item needs a parametric mesh/);
    expect(errors([{ ...concept, mesh: { kind: 'lookalike', assetId: 'x' } }]).join()).toMatch(/parametric mesh/);
    // round-trips through the serializer
    expect(JSON.parse(serializeScene(load([concept]))).items[0].concept).toBe(true);
  });
});
