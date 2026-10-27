import { ProductRecord } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { categoryOf, mountOf } from './category';
import { deriveDims, parseMeasurementMap } from './ikea-dims';
import { createIkeaFrProvider, parseProductPage, parseSearchResponse, parseSearchResponseDetailed } from './ikea-fr';
import { fixture, json, testContext, text, type Handler } from './testkit';
import { warningsOf } from './types';

/** Recorded (scrubbed, text only: no photos, no models) pages of the product types that have no width / depth / height. */
const PAGES = {
  rug: ['50277393', 'product-rug-lohals-50277393.html'],
  plant: ['60610606', 'product-plant-fejka-60610606.html'],
  frame: ['60566401', 'product-frame-rodalm-60566401.html'],
  curtain: ['80597171', 'product-curtain-ginstmott-80597171.html'],
  cushion: ['80587921', 'product-cushion-jordkastanj-80587921.html'],
} as const;
const searchJson = JSON.parse(fixture('ikea-fr/search-decor.json'));
const hits = parseSearchResponse(searchJson);
const read = (kind: keyof typeof PAGES) => {
  const [sku, file] = PAGES[kind];
  const rec = parseProductPage(fixture(`ikea-fr/${file}`), { sku, pageUrl: `https://www.ikea.com/fr/fr/p/-${sku}/`, fetchedAt: '2026-10-27T10:00:00.000Z', ...(hits.find((h) => h.sku === sku) ? { hit: hits.find((h) => h.sku === sku)! } : {}) });
  expect(ProductRecord.safeParse(rec).success).toBe(true);
  return rec;
};

describe('IKEA FR pages without a width / depth / height triple', () => {
  it('rug: Longueur x Largeur, about 1 cm thick, on the floor', () => {
    expect(read('rug')).toMatchObject({ category: 'rug', mount: 'floor', dims: { w: 1.6, d: 2.3, h: 0.01 }, dimsSource: 'structured', price: 99.95 });
  });

  it('plant: pot diameter x pot diameter x plant height', () => {
    expect(read('plant')).toMatchObject({ category: 'plant', mount: 'floor', dims: { w: 0.21, d: 0.21, h: 1.8 } });
  });

  it('frame: outer width x depth x outer height, hung on a wall', () => {
    expect(read('frame')).toMatchObject({ category: 'frame', mount: 'wall', dims: { w: 0.52, d: 0.03, h: 0.72 } });
  });

  it('curtain: width of one panel x 5 cm x drop, hung', () => {
    expect(read('curtain')).toMatchObject({ category: 'curtain', mount: 'wall', dims: { w: 1.45, d: 0.05, h: 2.5 } });
  });

  it('cushion: Longueur x Largeur x a pillow thickness', () => {
    const rec = read('cushion');
    expect(rec).toMatchObject({ category: 'cushion', mount: 'floor', dims: { w: 0.4, d: 0.4 } });
    expect(rec.dims.h).toBeGreaterThan(0.05);
    expect(rec.dims.h).toBeLessThan(0.2);
  });

  it('falls back to the listing text when the page has no rows (rug 160x230, frame picture 50x70 + margin)', () => {
    expect(deriveDims('rug', new Map(), '160x230 cm')).toEqual({ dims: { w: 1.6, d: 2.3, h: 0.01 }, source: 'text' });
    expect(deriveDims('frame', new Map(), '50x70 cm')).toEqual({ dims: { w: 0.52, d: 0.03, h: 0.72 }, source: 'text' });
    expect(deriveDims('curtain', new Map(), '145x250 cm')).toEqual({ dims: { w: 1.45, d: 0.05, h: 2.5 }, source: 'text' });
    expect(deriveDims('plant', new Map(), '21 cm')).toBeUndefined(); // the single number is the pot, the height is unknown
    expect(deriveDims('bed', new Map(), '140x200 cm')).toBeUndefined();
  });

  it('reads every length row, by folded label, first one wins', () => {
    const rows = parseMeasurementMap(fixture('ikea-fr/product-frame-rodalm-60566401.html'));
    expect(rows.get('hauteur structure')).toBe(0.72);
    expect(rows.get('prof. structure')).toBe(0.03);
    expect(rows.has('poids')).toBe(false);
  });

  it('still reports product_dims_missing when nothing gives the missing size', () => {
    const html = fixture('ikea-fr/product-plant-fejka-60610606.html').replace(/Hauteur de la plante/g, 'Poids');
    expect(() => parseProductPage(html, { sku: '60610606', pageUrl: 'https://www.ikea.com/x', fetchedAt: '2026-10-27T10:00:00.000Z' })).toThrow(/dims|unknown/);
  });
});

describe('IKEA FR categories', () => {
  it('table lamps are lamps, not tables (AKTERSPRING), bedside lamps are not bedside tables', () => {
    expect(categoryOf('Lampe de table')).toBe('lamp');
    expect(categoryOf('Lampe de chevet')).toBe('lamp');
    expect(categoryOf('Table de chevet')).toBe('bedside');
    expect(categoryOf('Table')).toBe('table');
    expect(categoryOf('Lampadaire')).toBe('lamp');
  });

  it('soft furnishings and decor have their own categories', () => {
    expect(categoryOf('Tapis tissé à plat')).toBe('rug');
    expect(categoryOf('Paillasson')).toBe('rug');
    expect(categoryOf('Rideaux, 2 pièces')).toBe('curtain');
    expect(categoryOf('Voilage, 2 pièces')).toBe('curtain');
    expect(categoryOf('Store enrouleur')).toBe('curtain');
    expect(categoryOf('Tringle à rideaux')).toBe('other');
    expect(categoryOf('Plante artificielle')).toBe('plant');
    expect(categoryOf('Vase')).toBe('vase');
    expect(categoryOf('Cadre')).toBe('frame');
    expect(categoryOf('Cadre de lit')).toBe('bed');
    expect(categoryOf('Housse de coussin')).toBe('cushion');
    expect(categoryOf('Coussin de chaise')).toBe('cushion');
    expect(categoryOf('Plaid')).toBe('throw');
    expect(categoryOf('Cache-pot')).toBe('decor');
  });

  it('frames and curtains hang; the rest stand', () => {
    expect(mountOf('RÖDALM Cadre', 'frame')).toBe('wall');
    expect(mountOf('GINSTMOTT Rideaux', 'curtain')).toBe('wall');
    expect(mountOf('LOHALS Tapis', 'rug')).toBe('floor');
    expect(mountOf('FEJKA Plante', 'plant')).toBe('floor');
  });
});

describe('IKEA FR search robustness', () => {
  const SEARCH = 'https://sik.search.blue.cdtapps.com/fr/fr/search-result-page*';
  const pageRoute = (): [RegExp, Handler] => [
    /\/fr\/fr\/p\/.*-(\d{8})\/?$/,
    (call) => {
      const sku = /(\d{8})\/?$/.exec(new URL(call.url).pathname)![1]!;
      const file = Object.values(PAGES).find(([s]) => s === sku)?.[1];
      return file ? text(fixture(`ikea-fr/${file}`)) : text('<html><body>redesigned</body></html>');
    },
  ];

  it('malformed hits are skipped and counted, not fatal', () => {
    const { hits: ok, skipped } = parseSearchResponseDetailed(searchJson);
    expect(ok.length).toBe(9);
    expect(skipped).toHaveLength(2);
    expect(skipped.join(' ')).toMatch(/BROKEN/);
    expect(skipped.join(' ')).toMatch(/NOPRICE.*no price/);
    expect(() => parseSearchResponseDetailed({ searchResultPage: { products: { main: {} } } })).toThrow(/items/);
  });

  it('the page number is the one in the page link even when itemNoGlobal differs', () => {
    const j = structuredClone(searchJson);
    const p = j.searchResultPage.products.main.items[2].product;
    p.id = '00628218';
    p.itemNoGlobal = '50628225';
    p.pipUrl = 'https://www.ikea.com/fr/fr/p/tiokrona-tapis-tisse-a-plat-naturel-00628218/';
    const h = parseSearchResponse(j).find((x) => x.url.includes('tiokrona'))!;
    expect(h.sku).toBe('00628218');
    expect(h.url).toBe('https://www.ikea.com/fr/fr/p/tiokrona-tapis-tisse-a-plat-naturel-00628218/');
  });

  it('one unreadable page among good ones does not empty the search; the skip is reported as a warning', async () => {
    const t = testContext([[SEARCH, json(searchJson)], pageRoute()], { id: 'ikea-fr' });
    const out = await createIkeaFrProvider({ enrichMax: 20, foregroundPages: 20 }).search('decor', { limit: 20 }, t.ctx);
    expect(out.map((r) => [r.sku, r.category]).sort()).toEqual([
      ['50277393', 'rug'],
      ['60566401', 'frame'],
      ['60610606', 'plant'],
      ['80587921', 'cushion'],
      ['80597171', 'curtain'],
    ]);
    const w = warningsOf(out).join(' ');
    expect(w).toMatch(/2 malformed search hit/);
    expect(w).toMatch(/page\(s\) that could not be read/);
  });

  it('a category filter reaches the rugs: size-less products are no longer dropped', async () => {
    const t = testContext([[SEARCH, json(searchJson)], pageRoute()], { id: 'ikea-fr' });
    const out = await createIkeaFrProvider({ enrichMax: 20, foregroundPages: 20 }).search('tapis', { limit: 5, category: 'rug' }, t.ctx);
    expect(out.map((r) => r.sku)).toEqual(['50277393']);
    expect(out[0]!.dims).toEqual({ w: 1.6, d: 2.3, h: 0.01 });
  });

  it('when every page fails to parse the site changed: provider_parse_failed', async () => {
    const t = testContext([[SEARCH, json(searchJson)], [/\/p\//, '<html><body>redesigned</body></html>']].map(([p, r]) => [p, typeof r === 'string' ? text(r) : r] as [string | RegExp, Handler]), { id: 'ikea-fr' });
    await expect(createIkeaFrProvider().search('decor', { limit: 5 }, t.ctx)).rejects.toMatchObject({ code: 'provider_parse_failed' });
  });
});
