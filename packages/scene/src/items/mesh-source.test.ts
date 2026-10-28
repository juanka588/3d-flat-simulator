import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProductCategory } from '../products';
import { GENERATORS, MeshSource, checkParametricMesh, createGeneratorRegistry, meshAssetId, type Generator } from './mesh-source';
import { defaultParametricFor } from './parametric-defaults';

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
