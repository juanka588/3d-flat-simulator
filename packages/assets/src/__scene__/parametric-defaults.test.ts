// Scene behaviour that depends on the REAL generators. Scene's own tests run against an empty registry (modules.md step 11),
// so the cases that need `@flat/assets` registered live here, in the package that owns the generators.
import { describe, expect, it } from 'vitest';
import { GENERATORS, ProductCategory, defaultParametricFor } from '@flat/scene';
import '../register';

describe('defaultParametricFor with the real generators', () => {
  it('registers the real wardrobe generator in the process-wide registry', () => {
    expect(GENERATORS.get('wardrobe')?.id).toBe('wardrobe');
  });
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
