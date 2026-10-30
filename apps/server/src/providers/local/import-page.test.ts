import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { defaultParametricFor } from '@flat/scene';
import { openLocalCatalog } from './catalog';
import { parseArgs } from './cli';
import { entryFor, writeCatalog } from './fixtures';
import { dimensionsCell, importSavedPage, lengthCell, manualSku, parseSavedPage, specPairs } from './import-page';
import { LocalCatalogFile } from './schema';

// A synthetic "saved web page" (no real shop content): JSON-LD + Open Graph + a characteristics table, and its _files folder.
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

const tmp = async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'import-page-'));
  dirs.push(dir);
  return dir;
};

const PAGE = (extra = '', jsonld = true) => `<!DOCTYPE html><!-- saved from url=(0049)https://shop.example/p/ilot-central-71116953.html -->
<html lang="fr"><head><title>Ilot central | Shop Example</title>
<link rel="canonical" href="https://shop.example/p/ilot-central-71116953.html">
<meta property="og:title" content="Îlot central rotatif">
<meta property="og:image" content="https://cdn.shop.example/img/photo-ilot-1200.jpg?w=1200">
${
  jsonld
    ? `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Table à manger extensible, table de bar rotative avec casier à vin et étagères, îlot central cuisine, blanc',
        sku: '71116953',
        brand: { '@type': 'Brand', name: 'Marque' },
        color: 'Blanc',
        image: ['https://cdn.shop.example/img/photo-ilot-1200.jpg?w=1200'],
        offers: { '@type': 'Offer', price: '399,90', priceCurrency: 'EUR' },
      })}</script>`
    : ''
}
</head><body><h1>Îlot central rotatif &amp; extensible</h1>
<img src="page_files/logo.png"><img src="page_files/photo-ilot-1200.jpg">
<h2>Caractéristiques</h2>
<table><tbody>
<tr><th>Largeur</th><td>140 cm</td></tr>
<tr><th>Profondeur</th><td>60&nbsp;cm</td></tr>
<tr><th>Hauteur</th><td>90 cm</td></tr>
<tr><th>Couleur</th><td>Blanc</td></tr>
<tr><th>Matière</th><td>Panneau de particules</td></tr>
</tbody></table>${extra}</body></html>`;

async function savedPage(html: string, withFiles = true): Promise<{ file: string; out: string }> {
  const root = await tmp();
  const file = join(root, 'page.html');
  await writeFile(file, html);
  if (withFiles) {
    await mkdir(join(root, 'page_files'));
    const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 190, b: 180 } } }).jpeg().toBuffer();
    const logo = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
    await writeFile(join(root, 'page_files', 'photo-ilot-1200.jpg'), photo);
    await writeFile(join(root, 'page_files', 'logo.png'), logo);
  }
  const out = join(root, 'catalogue');
  await mkdir(out);
  return { file, out };
}

describe('reading a saved page', () => {
  it('takes name, reference, price, colour and the page address from JSON-LD, and the sizes from the characteristics table', () => {
    const p = parseSavedPage(PAGE());
    expect(p.name).toMatch(/^Table à manger extensible/);
    expect(p.sku).toBe('71116953');
    expect(p.price).toBeCloseTo(399.9, 2);
    expect(p.currency).toBe('EUR');
    expect(p.url).toBe('https://shop.example/p/ilot-central-71116953.html');
    expect(p.dims).toEqual({ w: 1.4, d: 0.6, h: 0.9 });
    expect(p.dimsSource).toBe('text');
    expect(p.colours).toEqual(['Blanc']);
    expect(p.materials).toEqual(['Panneau de particules']);
    expect(p.imageRefs[0]).toContain('photo-ilot-1200.jpg');
  });

  it('works without JSON-LD: Open Graph / h1 name, product:price meta, a combined "Dimensions" cell, length + width', () => {
    const html = `<html><head><link rel="canonical" href="https://shop.example/x"><meta property="product:price:amount" content="1 299,00"><meta property="product:price:currency" content="eur"></head>
      <body><h1>Table de bar</h1><dl><dt>Dimensions (L x P x H)</dt><dd>L 120 x P 50 x H 105 cm</dd></dl></body></html>`;
    const p = parseSavedPage(html);
    expect(p.name).toBe('Table de bar');
    expect(p.price).toBeCloseTo(1299, 0);
    expect(p.currency).toBe('EUR');
    expect(p.dims).toEqual({ w: 1.2, d: 0.5, h: 1.05 });
    const lw = parseSavedPage('<h1>x</h1><table><tr><td>Longueur</td><td>1,6 m</td></tr><tr><td>Largeur</td><td>80 cm</td></tr><tr><td>Hauteur</td><td>750 mm</td></tr></table>');
    expect(lw.dims).toEqual({ w: 1.6, d: 0.8, h: 0.75 });
  });

  it('cell parsers: units, bare numbers are cm, untagged triples are width x depth x height', () => {
    expect(lengthCell('126 cm')).toBe(1.26);
    expect(lengthCell('1,26 m')).toBe(1.26);
    expect(lengthCell('1260 mm')).toBe(1.26);
    expect(lengthCell('77')).toBe(0.77);
    expect(lengthCell('n/a')).toBeUndefined();
    expect(dimensionsCell('140 x 60 x 90 cm')).toEqual({ w: 1.4, d: 0.6, h: 0.9 });
    expect(dimensionsCell('H 90 cm / L 140 cm / P 60 cm')).toEqual({ w: 1.4, d: 0.6, h: 0.9 });
    expect(dimensionsCell('grand')).toBeUndefined();
    expect(specPairs('<ul><li>Poids : 25 kg</li></ul><table><tr><th>A</th><td>b</td></tr></table>')).toEqual([['A', 'b'], ['Poids', '25 kg']]);
  });

  it('references: eight digits as given, else the last eight-digit run of the address, else a stable 9xxxxxxx hash', () => {
    expect(manualSku('71116953', 'https://s/x')).toBe('71116953');
    expect(manualSku('REF-1', 'https://s/p/abc-12345678.html')).toBe('12345678');
    const h = manualSku(undefined, 'https://s/p/abc');
    expect(h).toMatch(/^9\d{7}$/);
    expect(manualSku(undefined, 'https://s/p/abc')).toBe(h);
  });
});

describe('importing a saved page into the local catalogue (offline)', () => {
  it('writes a manual, personal-use, no-3D entry with the photo from the _files folder; the server reader serves it; no network is touched', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('the import must not use the network');
    });
    const { file, out } = await savedPage(PAGE());
    const r = await importSavedPage({ dir: out, file, now: () => Date.parse('2026-10-30T10:00:00Z') });
    expect(r.productId).toBe('ikea-fr:71116953');
    expect(r.replaced).toBe(false);
    const cat = LocalCatalogFile.parse(JSON.parse(await readFile(join(out, 'catalog.json'), 'utf8')));
    const e = cat.entries[0]!;
    expect(e.source).toBe('manual');
    expect(e.has3d).toBe(false);
    expect(e.record.personalUseOnly).toBe(true);
    expect(e.record.category).toBe('kitchen_island');
    expect(e.record.dims).toEqual({ w: 1.4, d: 0.6, h: 0.9 });
    expect(e.record.price).toBeCloseTo(399.9, 2);
    expect(e.record.url).toBe('https://shop.example/p/ilot-central-71116953.html');
    expect(e.photo?.file).toBe('photos/71116953.webp');
    const meta = await sharp(await readFile(join(out, 'photos/71116953.webp'))).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width!, meta.height!)).toBe(320);

    const reader = await openLocalCatalog(out);
    const served = reader!.get('71116953')!;
    expect(served.modelRef).toBeUndefined();
    expect(served.photoUrl).toContain('photo-ilot-1200.jpg');
    expect(served.category).toBe('kitchen_island');
    expect(await reader!.readPhoto('71116953')).toBeDefined();
    // the viewer's stand-in: the island with the swivel top, shelf and wine bays, at the exact listed size
    const shape = defaultParametricFor(served.category, served.dims, served.name)!;
    expect(shape.generator).toBe('island');
    expect(shape.params).toMatchObject({ wineBays: 1, shelfBays: 1 });
    expect(shape.params['topLength']).toBeGreaterThan(1);
  });

  it('a second import of the same page updates the manual entry; a shop product with the same reference is protected', async () => {
    const { file, out } = await savedPage(PAGE());
    await importSavedPage({ dir: out, file });
    const again = await importSavedPage({ dir: out, file, overrides: { price: 349 } });
    expect(again.replaced).toBe(true);
    expect(LocalCatalogFile.parse(JSON.parse(await readFile(join(out, 'catalog.json'), 'utf8'))).entries).toHaveLength(1);

    const shop = await tmp();
    await writeCatalog(shop, [entryFor({ sku: '71116953', name: 'SHOP Produit' })]);
    await expect(importSavedPage({ dir: shop, file })).rejects.toThrow(/already has a shop product/);
    expect((await importSavedPage({ dir: shop, file, force: true })).replaced).toBe(true);
  });

  it('says what is missing and how to give it; --dims / --price / --url overrides complete the entry; --dry writes nothing', async () => {
    const bare = '<html><head><title>Table</title></head><body><h1>Table de bar</h1><table><tr><th>Largeur</th><td>120 cm</td></tr></table></body></html>';
    const { file, out } = await savedPage(bare, false);
    await expect(importSavedPage({ dir: out, file })).rejects.toThrow(/page address.*price.*depth.*height.*--dims/s);
    const dry = await importSavedPage({ dir: out, file, dryRun: true, overrides: { url: 'https://shop.example/p/table-bar-24680135', price: 89, dims: { w: 1.2, d: 0.5, h: 1.05 } } });
    expect(dry.written).toBe(false);
    expect(dry.sku).toBe('24680135');
    expect(dry.entry.record.dimsSource).toBe('user');
    expect(dry.entry.record.category).toBe('table');
    await expect(readFile(join(out, 'catalog.json'))).rejects.toThrow();
  });

  it('is not tied to a shop: a page with no pictures still imports (no photo), a forced category sticks across reads', async () => {
    const { file, out } = await savedPage(PAGE('', true), false);
    const r = await importSavedPage({ dir: out, file, category: 'sideboard' });
    expect(r.photo).toBeUndefined();
    expect((await openLocalCatalog(out))!.get('71116953')!.category).toBe('sideboard');
    await expect(importSavedPage({ dir: out, file, category: 'spaceship' })).rejects.toThrow(/unknown category/);
  });
});

describe('import-page command line', () => {
  it('takes the page as a positional argument, only for this command', () => {
    expect(parseArgs(['import-page', 'a/b.html', '--dims', '140,60,90', '--dry'])).toMatchObject({ command: 'import-page', positional: ['a/b.html'] });
    expect(() => parseArgs(['build', 'oops'])).toThrow(/unexpected argument/);
  });
});
