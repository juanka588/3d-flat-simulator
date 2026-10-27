import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EMPTY_MESH_CATALOG,
  GENERATORS,
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

  it('the default registry is empty', () => {
    expect(GENERATORS.list()).toEqual([]);
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

describe('stubs', () => {
  it('the empty catalog has nothing', () => {
    expect(EMPTY_MESH_CATALOG.list()).toEqual([]);
    expect(EMPTY_MESH_CATALOG.get('x')).toBeUndefined();
    expect(EMPTY_MESH_CATALOG.search({ category: 'sofa' })).toEqual([]);
  });
  it('resolveMesh stub returns a placeholder at the item dims (M5.2 replaces it)', () => {
    const ctx = { catalog: EMPTY_MESH_CATALOG, generators: GENERATORS };
    expect(resolveMesh({ assetId: 'param:bed', dims: { w: 1, d: 2, h: 3 } } as never, ctx)).toMatchObject({ source: 'placeholder', dims: { w: 1, d: 2, h: 3 } });
    expect(resolveMesh({ assetId: 'x' } as never, ctx).dims).toEqual({ w: 0.3, d: 0.3, h: 0.3 });
  });
  it('pickLookalike stub finds nothing; the distortion limit is 25%', () => {
    expect(pickLookalike({ category: 'sofa', dims: { w: 2, d: 0.9, h: 0.85 } }, [MeshAsset.parse(asset)])).toBeUndefined();
    expect(MAX_LOOKALIKE_DISTORTION).toBe(0.25);
  });
});
