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
    tall_cabinet: { w: 0.4, d: 0.35, h: 1.95 },
    appliance_housing: { w: 0.6, d: 0.6, h: 2.0 },
    curtain: { w: 1.45, d: 0.05, h: 2.5 },
    cushion: { w: 0.5, d: 0.5, h: 0.125 },
    throw: { w: 1.2, d: 1.6, h: 0.02 },
    frame: { w: 0.32, d: 0.03, h: 0.42 },
    plant: { w: 0.21, d: 0.21, h: 0.65 },
    vase: { w: 0.15, d: 0.15, h: 0.3 },
    lamp: { w: 0.35, d: 0.18, h: 0.29 },
    washbasin: { w: 0.6, d: 0.45, h: 0.85 },
    towel_rail: { w: 0.5, d: 0.1, h: 0.8 },
    hook: { w: 0.05, d: 0.05, h: 0.1 },
    bath_accessory: { w: 0.1, d: 0.1, h: 0.15 },
    shower_curtain: { w: 1.8, d: 0.01, h: 2 },
    storage: { w: 0.3, d: 0.25, h: 0.25 },
    radiator: { w: 0.8, d: 0.1, h: 0.6 },
  };
  it('maps every category to a registered generator whose params the schema accepts, or to nothing', () => {
    for (const category of ProductCategory.options) {
      const dims = typical[category] ?? { w: 1.2, d: 0.6, h: 0.9 };
      const d = defaultParametricFor(category, dims);
      if (!d) {
        expect(['appliance', 'decor', 'other']).toContain(category);
        continue;
      }
      const g = GENERATORS.get(d.generator)!;
      expect(g, category).toBeDefined();
      const parsed = g.params.parse(d.params);
      expect(g.category === category || ['armchair', 'drawers', 'vanity', 'kitchen_island', 'tall_cabinet', 'appliance_housing', 'washbasin', 'shower_curtain', 'storage', 'towel_rail', 'hook', 'bath_accessory'].includes(category), category).toBe(true);
      // Exact dims, so the check at placement (2% tolerance) never turns a stand-in into a plain box.
      const out = g.describeParams(parsed).dims;
            expect(out).toEqual(dims);
    }
  });
});
