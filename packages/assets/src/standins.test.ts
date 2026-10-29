import { describe, expect, it } from 'vitest';
import { GENERATORS, ProductCategory, checkParametricMesh, colourFromWords, defaultParametricFor } from '@flat/scene';
import type { Item } from '@flat/scene';
import { buildItems } from './meshes/build-items';
import { resolveMesh } from './catalog/resolve';
import { EMPTY_MESH_CATALOG } from './catalog/mesh-catalog';
import { COLOUR_NAMES, parseProductMaterial, productMaterial } from './materials/item-materials';
import { dominantColour } from './materials/dominant-colour';
import './register';

/** CG8: products without a 3D model get a generated stand-in in their colours, never a plain box. */

const ctx = { catalog: EMPTY_MESH_CATALOG, generators: GENERATORS };

describe('colour words', () => {
  it.each([
    ['JORDKASTANJ Coussin - gris 40x40 cm', undefined, 'grey'],
    ['STOENSE Tapis, poils ras - blanc cassé 200x300 cm', undefined, 'cream'],
    ['LANDSKRONA Canapé 3 places - Gunnared vert clair/bois', undefined, 'sage'],
    ['MAJGULL Rideaux occultants, 2 pièces - vert foncé/avec oeillets 145x250 cm', undefined, 'green'],
    ['ALLFRAKEN Plaid - brun 150x200 cm', undefined, 'brown'],
    ['HÄCKHAGTORN Cadre - pin 30x40 cm', undefined, 'beige'],
    ['HOLMVI Plaid - gris 120x160 cm', 'bleu marine', 'navy'],
    ['FLIKHAGTORN Plaid - multicolore 120x160 cm', undefined, undefined],
  ] as const)('%s -> %s', (name, colour, expected) => {
    expect(colourFromWords(name, colour)).toBe(expected);
  });
  it('only ever answers with a palette colour', () => {
    for (const w of ['blanc', 'noir', 'rouge', 'jaune', 'rose', 'bleu', 'vert', 'gris foncé', 'beige', 'terracotta', 'sable', 'marron', 'orange']) {
      expect(COLOUR_NAMES).toContain(colourFromWords(`X - ${w}`));
    }
  });
});

describe('category -> stand-in routing', () => {
  const cases: [string, string, { w: number; d: number; h: number }, string][] = [
    ['cushion', 'JORDKASTANJ Coussin - gris 40x40 cm', { w: 0.4, d: 0.4, h: 0.1 }, 'cushion'],
    ['rug', 'LOHALS Tapis tissé à plat - naturel 200x300 cm', { w: 2, d: 3, h: 0.01 }, 'rug'],
    ['throw', 'HOLMVI Plaid - gris 120x160 cm', { w: 1.2, d: 1.6, h: 0.02 }, 'throwBlanket'],
    ['curtain', 'GINSTMOTT Rideaux, 2 pièces - beige 145x250 cm', { w: 1.45, d: 0.05, h: 2.5 }, 'curtains'],
    ['frame', 'RÖDALM Cadre - blanc 30x40 cm', { w: 0.32, d: 0.03, h: 0.42 }, 'frame'],
    ['mirror', 'LINDBYN Miroir - blanc 60x80 cm', { w: 0.6, d: 0.02, h: 0.8 }, 'mirror'],
    ['lamp', 'VARPTROSS Applique - bambou 30 cm', { w: 0.18, d: 0.12, h: 0.3 }, 'lamp'],
    ['plant', 'FEJKA Plante artificielle 21 cm', { w: 0.21, d: 0.21, h: 0.65 }, 'plant'],
    ['vase', 'VILJESTARK Vase - blanc 20 cm', { w: 0.12, d: 0.12, h: 0.2 }, 'vase'],
  ];
  it.each(cases)('%s resolves to the %s generator at the exact dims (no box)', (category, name, dims, generator) => {
    const item = { assetId: 'product:ikea-fr', dims, product: { provider: 'ikea-fr', sku: '12345678', name, category: category as never, url: 'https://x.test/', price: 10, currency: 'EUR', dims, snapshotAt: '2026-10-29T10:00:00Z' }, productRef: { provider: 'ikea-fr', sku: '12345678' } } as unknown as Item;
    const r = resolveMesh(item, ctx);
    expect(r.source).toBe('parametric');
    expect(r.generator?.id).toBe(generator);
    expect(r.dims).toEqual(dims);
    // the placement check (2% tolerance on the product dims) accepts it
    expect(checkParametricMesh({ generator, params: r.generator!.params }, dims).status).toBe('ok');
  });
  it('every category but appliance / decor / other has a stand-in', () => {
    for (const c of ProductCategory.options) {
      if (['appliance', 'decor', 'other'].includes(c)) expect(defaultParametricFor(c, { w: 1, d: 1, h: 1 }), c).toBeUndefined();
      else expect(defaultParametricFor(c, { w: 1, d: 1, h: 1 }), c).toBeDefined();
    }
  });
  it('takes the colour from the name or the variant colour, and the lamp kind and sheerness from the name', () => {
    expect(defaultParametricFor('cushion', { w: 0.4, d: 0.4, h: 0.1 }, 'X Coussin - gris 40x40 cm')?.params['colour']).toBe('grey');
    expect(defaultParametricFor('cushion', { w: 0.4, d: 0.4, h: 0.1 }, 'X Coussin - gris 40x40 cm', 'noir')?.params['colour']).toBe('black');
    expect(defaultParametricFor('cushion', { w: 0.4, d: 0.4, h: 0.1 }, 'X Coussin - multicolore')?.params).not.toHaveProperty('colour');
    expect(defaultParametricFor('lamp', { w: 0.3, d: 0.3, h: 1.5 }, 'X Lampadaire - noir')?.params['kind']).toBe('floor');
    expect(defaultParametricFor('lamp', { w: 0.3, d: 0.3, h: 0.3 }, 'X Applique - noir')?.params['kind']).toBe('wall');
    expect(defaultParametricFor('curtain', { w: 1.45, d: 0.05, h: 2.5 }, 'X Voilage, 2 pièces - blanc')?.params['sheer']).toBe(true);
  });
});

describe('product photo parts', () => {
  const product = { provider: 'ikea-fr', sku: '80587921', name: 'JORDKASTANJ Coussin - gris 40x40 cm', url: 'https://x.test/', price: 7, currency: 'EUR', dims: { w: 0.4, d: 0.4, h: 0.1 }, category: 'cushion', snapshotAt: '2026-10-29T10:00:00Z' };
  const item = (withProduct: boolean): Item =>
    ({
      id: 'c1',
      assetId: 'param:cushion',
      position: [1, 1],
      elevation: 0,
      rotation: 0,
      mount: 'floor',
      dims: product.dims,
      mesh: { kind: 'parametric', generator: 'cushion', params: { w: 0.4, d: 0.4, h: 0.1, photo: true, colour: 'grey' } },
      ...(withProduct ? { product, productRef: { provider: 'ikea-fr', sku: '80587921' } } : {}),
    }) as unknown as Item;

  it('a product stand-in draws its photo part with a per-product material, plain colour parts stay builtin', () => {
    const ids = buildItems({ items: [item(true)] }).groups.map((g) => g.materialId);
    expect(ids).toContain(productMaterial('photo', 'grey', 'ikea-fr:80587921'));
    expect(ids.filter((i) => i.startsWith('builtin:product-'))).toEqual([]);
    expect(parseProductMaterial(productMaterial('tint', 'cream', 'ikea-fr:80587921'))).toEqual({ kind: 'tint', colour: 'cream', productId: 'ikea-fr:80587921' });
  });
  it('a concept item (no product) keeps the builtin colour material, so it renders without any photo', () => {
    const ids = buildItems({ items: [item(false)] }).groups.map((g) => g.materialId);
    expect(ids).toContain('builtin:product-photo-grey');
    expect(ids.some((i) => i.startsWith('photo:'))).toBe(false);
  });
  it('ignores ids that are not product materials', () => {
    expect(parseProductMaterial('builtin:furniture-white')).toBeUndefined();
    expect(parseProductMaterial('photo:nope|ikea-fr:1')).toBeUndefined();
    expect(parseProductMaterial('photo:grey|bad id')).toBeUndefined();
  });
});

describe('dominantColour', () => {
  const fill = (w: number, h: number, px: (x: number, y: number) => [number, number, number, number]) => {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(px(x, y), (y * w + x) * 4);
    return out;
  };
  it('ignores the white backdrop and answers the product colour', () => {
    const img = fill(20, 20, (x, y) => (x >= 5 && x < 15 && y >= 5 && y < 15 ? [40, 90, 50, 255] : [255, 255, 255, 255]));
    expect(dominantColour(img, 20, 20)).toBe('#285a32');
  });
  it('is deterministic and picks the fullest colour', () => {
    const img = fill(10, 10, (x) => (x < 6 ? [200, 60, 40, 255] : [30, 30, 120, 255]));
    expect(dominantColour(img, 10, 10)).toBe('#c83c28');
    expect(dominantColour(img, 10, 10)).toBe(dominantColour(img, 10, 10));
  });
  it('is undefined for a white or transparent picture', () => {
    expect(dominantColour(fill(8, 8, () => [255, 255, 255, 255]), 8, 8)).toBeUndefined();
    expect(dominantColour(fill(8, 8, () => [10, 10, 10, 0]), 8, 8)).toBeUndefined();
  });
});
