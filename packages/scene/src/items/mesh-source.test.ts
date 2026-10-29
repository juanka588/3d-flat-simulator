import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GENERATORS, MeshSource, checkParametricMesh, createGeneratorRegistry, meshAssetId, type Generator } from './mesh-source';

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
