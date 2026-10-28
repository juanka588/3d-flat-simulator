import { describe, expect, it } from 'vitest';
import '../register'; // fills GENERATORS
import { GENERATORS } from '@flat/scene';
import { EMPTY_MESH_CATALOG, MAX_LOOKALIKE_DISTORTION, MeshAsset, createMeshCatalog, parametricMeshAssets, pickLookalike, scaleToDims } from './mesh-catalog';

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
  it('never picks the person scale figure (tag "person") as furniture', () => {
    const person = lib('sketchfab:person_standing', 'sofa', product.dims, ['person']);
    expect(pickLookalike(product, [person])).toBeUndefined();
    expect(pickLookalike(product, [person, lib('s:ok', 'sofa', product.dims)])?.asset.id).toBe('s:ok');
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
