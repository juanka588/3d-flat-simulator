import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import './index'; // fills GENERATORS
import {
  EMPTY_MESH_CATALOG,
  GENERATORS,
  createMeshCatalog,
  defaultParametricFor,
  parametricMeshAssets,
  scaleToDims,
  MAX_LOOKALIKE_DISTORTION,
  MeshAsset,
  MeshSource,
  checkParametricMesh,
  createGeneratorRegistry,
  meshAssetId,
  pickLookalike,
  resolveMesh,
  type Generator,
} from './catalog';
import { ProductCategory } from '../products';

const asset = {
  id: 'polyhaven:sofa_03',
  name: 'Sofa 03',
  source: 'cc0',
  licence: 'CC0-1.0',
  credit: 'Poly Haven',
  category: 'sofa',
  styleTags: ['modern'],
  nativeDims: { w: 2.1, d: 0.95, h: 0.8 },
  file: 'sofa_03.glb',
};

describe('MeshAsset', () => {
  it('parses with defaults for anchor and front', () => {
    const a = MeshAsset.parse(asset);
    expect([a.anchor, a.front]).toEqual([[0, 0, 0], '+z']);
  });
  it('parametric assets need a generator, library assets a file', () => {
    expect(MeshAsset.safeParse({ ...asset, source: 'parametric', file: undefined, generator: 'sofa' }).success).toBe(true);
    expect(MeshAsset.safeParse({ ...asset, source: 'parametric', file: undefined }).success).toBe(false);
    expect(MeshAsset.safeParse({ ...asset, file: undefined }).success).toBe(false);
  });
  it.each([
    ['unknown source', { source: 'sketchfab' }],
    ['path traversal', { file: '../secret.glb' }],
    ['absolute url', { file: 'https://x.example/a.glb' }],
    ['wrong extension', { file: 'sofa.obj' }],
    ['bad front', { front: 'up' }],
    ['zero dims', { nativeDims: { w: 0, d: 1, h: 1 } }],
    ['unknown key', { price: 10 }],
  ])('rejects %s', (_l, patch) => {
    expect(MeshAsset.safeParse({ ...asset, ...patch }).success).toBe(false);
  });
});

describe('MeshSource', () => {
  it('is a discriminated union of provider / lookalike / parametric', () => {
    expect(MeshSource.parse({ kind: 'provider' })).toEqual({ kind: 'provider' });
    expect(MeshSource.parse({ kind: 'lookalike', assetId: 'polyhaven:sofa_03' })).toEqual({ kind: 'lookalike', assetId: 'polyhaven:sofa_03' });
    expect(MeshSource.parse({ kind: 'parametric', generator: 'bed' })).toEqual({ kind: 'parametric', generator: 'bed', params: {} });
  });
  it('rejects non-scalar params, too many params and extra keys', () => {
    expect(MeshSource.safeParse({ kind: 'parametric', generator: 'bed', params: { a: { nested: 1 } } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, i]));
    expect(MeshSource.safeParse({ kind: 'parametric', generator: 'bed', params: many }).success).toBe(false);
    expect(MeshSource.safeParse({ kind: 'provider', url: 'https://x.example' }).success).toBe(false);
  });
  it('meshAssetId follows the item.assetId convention', () => {
    expect(meshAssetId({ kind: 'provider' }, { provider: 'ikea-fr' })).toBe('product:ikea-fr');
    expect(meshAssetId({ kind: 'lookalike', assetId: 'a:b' })).toBe('a:b');
    expect(meshAssetId({ kind: 'parametric', generator: 'bed', params: {} })).toBe('param:bed');
  });
});

describe('generator registry', () => {
  const g: Generator<{ w: number }> = {
    id: 'box',
    label: 'Box',
    category: 'decor',
    params: z.object({ w: z.number().positive() }),
    describeParams: ({ w }) => ({ dims: { w, d: 0.5, h: 0.5 }, anchors: [{ name: 'back-centre', position: [0, 0.25, -0.25] }], clearance: { front: 0.3 } }),
    generate: () => {
      throw new Error('unused');
    },
  };
  afterEach(() => GENERATORS.unregister('box'));

  it('the process-wide registry holds the real generators once the assets barrel is imported', () => {
    expect(GENERATORS.get('wardrobe')?.id).toBe('wardrobe');
  });
  it('registers, lists in id order and refuses duplicates', () => {
    const r = createGeneratorRegistry();
    r.register(g);
    expect(r.get('box')).toBe(g);
    expect(() => r.register(g)).toThrow(/already registered/);
    r.unregister('box');
    expect(r.get('box')).toBeUndefined();
  });
  it('checkParametricMesh: unknown, ok, invalid params, dims mismatch (2% with 1 mm floor)', () => {
    const r = createGeneratorRegistry();
    expect(checkParametricMesh({ generator: 'box', params: { w: 1 } }, undefined, r).status).toBe('unknown_generator');
    r.register(g);
    expect(checkParametricMesh({ generator: 'box', params: { w: 1 } }, undefined, r)).toMatchObject({ status: 'ok', dims: { w: 1, d: 0.5, h: 0.5 } });
    expect(checkParametricMesh({ generator: 'box', params: { w: 'x' } }, undefined, r).status).toBe('invalid_params');
    expect(checkParametricMesh({ generator: 'box', params: { w: 1 } }, { w: 1.019, d: 0.5, h: 0.5 }, r).status).toBe('ok');
    expect(checkParametricMesh({ generator: 'box', params: { w: 1 } }, { w: 1.03, d: 0.5, h: 0.5 }, r).status).toBe('dims_mismatch');
    expect(checkParametricMesh({ generator: 'box', params: { w: 0.01 } }, { w: 0.0105, d: 0.5, h: 0.5 }, r).status).toBe('ok');
  });
});

describe('empty catalog and parametric assets', () => {
  it('the empty catalog has nothing', () => {
    expect(EMPTY_MESH_CATALOG.list()).toEqual([]);
    expect(EMPTY_MESH_CATALOG.get('x')).toBeUndefined();
    expect(EMPTY_MESH_CATALOG.search({ category: 'sofa' })).toEqual([]);
  });
  it('parametricMeshAssets lists one valid asset per generator with its default dims', () => {
    const assets = parametricMeshAssets();
    expect(assets).toHaveLength(GENERATORS.list().length);
    expect(assets.find((a) => a.id === 'param:wardrobe')).toMatchObject({ source: 'parametric', generator: 'wardrobe', category: 'wardrobe', nativeDims: { w: 1.8, d: 0.6, h: 2.4 } });
  });
});

const lib = (id: string, category: MeshAsset['category'], nativeDims: MeshAsset['nativeDims'], styleTags: string[] = []): MeshAsset =>
  MeshAsset.parse({ ...asset, id, category, nativeDims, styleTags });

describe('createMeshCatalog', () => {
  const cat = createMeshCatalog([lib('b:sofa2', 'sofa', { w: 2, d: 0.9, h: 0.8 }, ['modern']), lib('a:sofa1', 'sofa', { w: 2, d: 0.9, h: 0.8 }, ['classic']), lib('c:bed', 'bed', { w: 1.6, d: 2, h: 0.9 })]);
  it('lists in id order, gets by id and refuses duplicate ids', () => {
    expect(cat.list().map((a) => a.id)).toEqual(['a:sofa1', 'b:sofa2', 'c:bed']);
    expect(cat.get('c:bed')?.category).toBe('bed');
    expect(() => createMeshCatalog([lib('x', 'bed', asset.nativeDims), lib('x', 'bed', asset.nativeDims)])).toThrow(/duplicate/);
  });
  it('searches by category, best style matches first, with a limit', () => {
    expect(cat.search({ category: 'sofa' }).map((a) => a.id)).toEqual(['a:sofa1', 'b:sofa2']);
    expect(cat.search({ category: 'sofa', styleTags: ['Modern'] }).map((a) => a.id)).toEqual(['b:sofa2', 'a:sofa1']);
    expect(cat.search({ category: 'sofa', limit: 1 })).toHaveLength(1);
    expect(cat.search({})).toHaveLength(3);
  });
});

describe('pickLookalike', () => {
  const product = { category: 'sofa' as const, dims: { w: 2.0, d: 0.9, h: 0.85 } };
  it('scales per axis and measures the distortion against uniform scaling', () => {
    expect(scaleToDims({ w: 1, d: 1, h: 1 }, { w: 2, d: 2, h: 2 }).distortion).toBeCloseTo(0, 12);
    const { scale, distortion } = scaleToDims({ w: 2.1, d: 0.95, h: 0.8 }, product.dims);
    expect(scale).toEqual([2 / 2.1, 0.85 / 0.8, 0.9 / 0.95]);
    expect(distortion).toBeGreaterThan(0.05);
    expect(distortion).toBeLessThan(0.1);
  });
  it('rejects more than 25% distortion and other categories, and ignores parametric assets', () => {
    expect(pickLookalike(product, [lib('s:long', 'sofa', { w: 3.5, d: 0.9, h: 0.85 })])).toBeUndefined(); // 3.5 -> 2.0 is far from 0.9 -> 0.9
    expect(pickLookalike(product, [lib('s:bed', 'bed', product.dims)])).toBeUndefined();
    expect(pickLookalike(product, parametricMeshAssets())).toBeUndefined();
    expect(pickLookalike(product, [])).toBeUndefined();
  });
  it('ranks category, then style tags, then proportions, then id; order of the input does not matter', () => {
    const exact = lib('z:exact', 'sofa', { w: 2, d: 0.9, h: 0.85 });
    const close = lib('y:close', 'sofa', { w: 2.2, d: 0.9, h: 0.85 });
    const tagged = lib('x:tagged', 'sofa', { w: 2.2, d: 0.9, h: 0.85 }, ['modern', 'grey']);
    const armchair = lib('w:arm', 'armchair', { w: 2, d: 0.9, h: 0.85 }, ['modern', 'grey']);
    const withTags = { ...product, styleTags: ['MODERN', 'grey'] };
    expect(pickLookalike(product, [close, exact])?.asset.id).toBe('z:exact');
    expect(pickLookalike(withTags, [exact, close, tagged])?.asset.id).toBe('x:tagged');
    expect(pickLookalike(withTags, [armchair, exact])?.asset.id).toBe('z:exact'); // exact category beats related with tags
    expect(pickLookalike(withTags, [armchair])?.asset.id).toBe('w:arm'); // related category is a fallback
    const twin = lib('a:twin', 'sofa', { w: 2, d: 0.9, h: 0.85 });
    expect(pickLookalike(product, [exact, twin])?.asset.id).toBe('a:twin');
    expect(pickLookalike(product, [twin, exact])?.asset.id).toBe('a:twin');
    const m = pickLookalike(product, [exact])!;
    expect(m).toMatchObject({ distortion: 0, scale: [1, 1, 1] });
    expect(m.distortion).toBeLessThanOrEqual(MAX_LOOKALIKE_DISTORTION);
  });
});

describe('defaultParametricFor', () => {
  const typical: Partial<Record<(typeof ProductCategory.options)[number], { w: number; d: number; h: number }>> = {
    bed: { w: 1.6, d: 2, h: 0.9 },
    sofa: { w: 2, d: 0.9, h: 0.85 },
    armchair: { w: 0.8, d: 0.85, h: 0.85 },
    chair: { w: 0.45, d: 0.5, h: 0.85 },
    rug: { w: 2, d: 1.4, h: 0.012 },
    mirror: { w: 0.6, d: 0.03, h: 1.6 },
    wardrobe: { w: 1.5, d: 0.6, h: 2.2 },
    wall_cabinet: { w: 0.6, d: 0.35, h: 0.7 },
    kitchen: { w: 0.6, d: 0.6, h: 0.9 },
    bedside: { w: 0.45, d: 0.4, h: 0.5 },
  };
  it('maps every category to a registered generator whose params the schema accepts, or to nothing', () => {
    for (const category of ProductCategory.options) {
      const dims = typical[category] ?? { w: 1.2, d: 0.6, h: 0.9 };
      const d = defaultParametricFor(category, dims);
      if (!d) {
        expect(['lamp', 'appliance', 'decor', 'other', 'curtain', 'plant', 'vase', 'frame', 'cushion', 'throw']).toContain(category);
        continue;
      }
      const g = GENERATORS.get(d.generator)!;
      expect(g, category).toBeDefined();
      const parsed = g.params.parse(d.params);
      expect(g.category === category || ['armchair', 'drawers'].includes(category), category).toBe(true);
      // Exact dims, except for the fixed-depth mirror and fixed-thickness rug.
      const out = g.describeParams(parsed).dims;
      expect(out.w).toBeCloseTo(dims.w, 9);
      if (category !== 'mirror' && category !== 'rug') expect(out).toEqual(dims);
    }
  });
});

describe('resolveMesh', () => {
  const dims = { w: 1.6, d: 2.0, h: 0.9 };
  const snapshot = {
    provider: 'mock',
    sku: 'MOCK-BED-160',
    name: 'Bed',
    url: 'https://shop.mock.example/p/bed',
    price: 299,
    currency: 'EUR',
    dims,
    category: 'bed' as const,
    snapshotAt: '2026-10-27T10:00:00.000Z',
  };
  const sofaLib = lib('lib:bed', 'bed', { w: 1.5, d: 1.9, h: 0.85 });
  const catalog = createMeshCatalog([sofaLib]);
  const ctx = { catalog, generators: GENERATORS, providerModelAvailable: (id: string) => id === 'mock:MOCK-BED-160' };
  const base = { assetId: 'x', product: snapshot, productRef: { provider: 'mock', sku: 'MOCK-BED-160' }, dims } as const;

  it('legacy builtin items resolve to builtin at the asset dims', () => {
    expect(resolveMesh({ assetId: 'builtin:tv-55' }, ctx)).toMatchObject({ source: 'builtin', dims: { w: 1.23, d: 0.05, h: 0.71 } });
  });
  it('a provider mesh wins when the local server has the model', () => {
    const r = resolveMesh({ ...base, mesh: { kind: 'provider' } }, ctx);
    expect(r).toMatchObject({ source: 'provider', product: 'mock:MOCK-BED-160', dims });
  });
  it('degrades provider -> lookalike -> parametric -> placeholder', () => {
    const noModel = { ...ctx, providerModelAvailable: () => false };
    const r1 = resolveMesh({ ...base, mesh: { kind: 'provider' } }, noModel);
    expect(r1).toMatchObject({ source: 'lookalike', asset: { id: 'lib:bed' }, dims });
    expect(r1.distortion).toBeLessThanOrEqual(MAX_LOOKALIKE_DISTORTION);
    expect(r1.scale[0]).toBeCloseTo(1.6 / 1.5, 9);
    const r2 = resolveMesh({ ...base, mesh: { kind: 'provider' } }, { ...noModel, catalog: EMPTY_MESH_CATALOG });
    expect(r2).toMatchObject({ source: 'parametric', generator: { id: 'bed' }, dims });
    expect(r2.generator!.params).toMatchObject({ w: 1.6, l: 2, h: 0.9 });
    const r3 = resolveMesh({ ...base, mesh: { kind: 'provider' } }, { ...noModel, catalog: EMPTY_MESH_CATALOG, generators: createGeneratorRegistry() });
    expect(r3).toMatchObject({ source: 'placeholder', dims });
    expect(r3.reason).toMatch(/labelled box/);
  });
  it('a stored lookalike that would distort too much falls through to parametric', () => {
    const odd = createMeshCatalog([lib('lib:odd', 'bed', { w: 3, d: 2, h: 0.9 })]);
    const r = resolveMesh({ ...base, mesh: { kind: 'lookalike', assetId: 'lib:odd' } }, { ...ctx, catalog: odd });
    expect(r.source).toBe('parametric');
    expect(r.reason).toMatch(/default bed generator/);
    expect(resolveMesh({ ...base, mesh: { kind: 'lookalike', assetId: 'lib:bed' } }, ctx)).toMatchObject({ source: 'lookalike', asset: { id: 'lib:bed' } });
    expect(resolveMesh({ ...base, mesh: { kind: 'lookalike', assetId: 'gone' } }, { ...ctx, catalog: EMPTY_MESH_CATALOG }).source).toBe('parametric');
  });
  it('a stored parametric mesh is honoured, even when a provider model exists; invalid params fall back to the default', () => {
    const r = resolveMesh({ ...base, mesh: { kind: 'parametric', generator: 'bed', params: { w: 1.6, l: 2, h: 0.9, headboard: false } } }, ctx);
    expect(r).toMatchObject({ source: 'parametric', generator: { id: 'bed', params: { headboard: false } } });
    const bad = resolveMesh({ ...base, mesh: { kind: 'parametric', generator: 'bed', params: { w: -1 } } }, ctx);
    expect(bad).toMatchObject({ source: 'parametric', generator: { id: 'bed', params: { headboard: true } } });
  });
  it('without a mesh, a product runs the whole chain; without anything it is a 0.3 m labelled box', () => {
    expect(resolveMesh({ ...base }, ctx).source).toBe('provider');
    expect(resolveMesh({ ...base }, { ...ctx, providerModelAvailable: undefined }).source).toBe('lookalike');
    expect(resolveMesh({ assetId: 'mystery' }, ctx)).toMatchObject({ source: 'placeholder', dims: { w: 0.3, d: 0.3, h: 0.3 } });
    expect(resolveMesh({ assetId: 'param:bed', dims }, ctx)).toMatchObject({ source: 'placeholder', dims });
  });
  it('categories without a parametric shape end as a labelled box at the exact dims', () => {
    const lamp = { ...base, product: { ...snapshot, category: 'lamp' as const } };
    expect(resolveMesh(lamp, { ...ctx, catalog: EMPTY_MESH_CATALOG, providerModelAvailable: undefined })).toMatchObject({ source: 'placeholder', dims });
  });
  it('is deterministic', () => {
    expect(resolveMesh({ ...base }, ctx)).toEqual(resolveMesh({ ...base }, ctx));
  });
});
