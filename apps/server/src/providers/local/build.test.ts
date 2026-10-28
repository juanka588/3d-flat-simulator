import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIkeaFrProvider } from '../ikea-fr';
import { fixture, json, status, testContext, text, type Call, type Handler } from '../testkit';
import { buildCatalog, loadCatalogFile, recordProblem, refreshPrices } from './build';
import { makeGlb, recordFor } from './fixtures';
import { measureDocument, readGlb } from './normalise';
import { parseQueriesFile, skusFromScene } from './queries';
import { formatStatus, statusReport } from './status';

/** The whole build against a fake shop (recorded fixtures + synthetic GLBs): no live network. */

const SEARCH_JSON = JSON.parse(fixture('ikea-fr/search-kallax.json'));
const PAGE = fixture('ikea-fr/product-kallax-80275887.html');
const SKUS = ['80275887', '20275814', '00275848'] as const; // good model / mismatched model / model 404
const dotted = (sku: string) => `${sku.slice(0, 3)}.${sku.slice(3, 6)}.${sku.slice(6)}`;
const pageFor = (sku: string, over: (html: string) => string = (h) => h) => over(PAGE.replaceAll('802.758.87', dotted(sku)).replaceAll('80275887', sku));
const skuOfUrl = (url: string, re: RegExp) => url.match(re)?.[1] ?? '';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flat-build-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface ShopOptions {
  pageOver?: Record<string, (h: string) => string>;
  price?: Record<string, string>;
  gone?: string[];
}

async function shop(opts: ShopOptions = {}) {
  const png = await sharp({ create: { width: 900, height: 900, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer();
  const good = await makeGlb({ size: [0.765, 1.465, 0.39], textureSide: 2048, draco: true });
  const bad = await makeGlb({ size: [2, 0.3, 0.3] });
  const model: Handler = (call: Call) => {
    const sku = skuOfUrl(call.url, /\/assets\/1\.2\/(\d{8})\//);
    return sku === SKUS[0] ? new Response(good) : sku === SKUS[1] ? new Response(bad) : status(404);
  };
  const t = testContext(
    [
      [/search-result-page/, json(SEARCH_JSON)],
      [
        /\/fr\/fr\/p\//,
        (call) => {
          const sku = skuOfUrl(call.url, /(\d{8})\/?$/);
          if (opts.gone?.includes(sku)) return status(404);
          return text(pageFor(sku, opts.pageOver?.[sku]).replace('"price": "59.99"', `"price": "${opts.price?.[sku] ?? '59.99'}"`));
        },
      ],
      [/web-api\.ikea\.com\/dimma\/assets\//, model],
      [/\/images\/products\//, new Response(png, { headers: { 'content-type': 'image/png' } })],
    ],
    { id: 'ikea-fr' },
  );
  return { ...t, provider: createIkeaFrProvider(), now: () => new Date(t.clock.now()) };
}

const opts = (s: Awaited<ReturnType<typeof shop>>) => ({ dir, provider: s.provider, ctx: s.ctx, now: s.now, queries: [{ q: 'etagere kallax' }], perQuery: 3 });

describe('catalog:build against a fake shop', () => {
  it('reads curated queries, validates records, normalises models, drops bad ones with a reason, writes small photos', async () => {
    const s = await shop();
    const report = await buildCatalog(opts(s));
    expect(report).toMatchObject({ added: 3, rejected: 0, withModel: 1, withoutModel: 2, searches: 1 });
    const file = await loadCatalogFile(dir, 'x');
    const by = Object.fromEntries(file.entries.map((e) => [e.record.sku, e]));
    // 1. a good model: normalised, measured, photo
    const a = by['80275887']!;
    expect(a).toMatchObject({ has3d: true, typeName: 'Étagère', queries: ['etagere kallax'], incomplete: [] });
    expect(a.model!.decodedBytesAfter).toBeLessThan(a.model!.decodedBytesBefore / 3);
    expect(a.model!.fit.distortion).toBeLessThan(0.02);
    const glb = measureDocument(await readGlb(new Uint8Array(await readFile(join(dir, a.model!.file)))));
    expect(glb.maxTextureSide).toBeLessThanOrEqual(1024);
    expect((await sharp(await readFile(join(dir, a.photo!.file))).metadata()).width).toBeLessThanOrEqual(320);
    expect((await stat(join(dir, a.photo!.file))).size).toBeLessThan(20_000);
    // 2. a model that does not match the listed size: kept as a product, without a model, with the reason
    expect(by['20275814']).toMatchObject({ has3d: false, noModelReason: expect.stringMatching(/do not match the listed size|lies on its side/) });
    await expect(stat(join(dir, 'models/20275814.glb'))).rejects.toThrow();
    // 3. a model the shop 404s on: no model, reason, nothing retried
    expect(by['00275848']).toMatchObject({ has3d: false, noModelReason: expect.stringMatching(/no model could be downloaded/), incomplete: [] });
    expect(report.problems.map((p) => p.kind)).toEqual(expect.arrayContaining(['model']));
    expect(report.models.decodedAfter).toBeLessThan(report.models.decodedBefore);
  });

  it('is resumable and incremental: a second run makes no page, model or photo request while entries are fresh', async () => {
    const s = await shop();
    await buildCatalog(opts(s));
    const before = s.fetch.pages().length;
    const again = await buildCatalog(opts(s));
    expect(again).toMatchObject({ added: 0, kept: 3, searches: 0, pagesRead: 0 });
    expect(s.fetch.pages().length).toBe(before);
  });

  it('stops at --limit and picks up where it stopped', async () => {
    const s = await shop();
    const first = await buildCatalog({ ...opts(s), limit: 1 });
    expect(first).toMatchObject({ added: 1, stopped: expect.stringMatching(/--limit 1/) });
    const second = await buildCatalog(opts(s));
    expect(second.added).toBe(2);
    expect((await loadCatalogFile(dir, 'x')).entries).toHaveLength(3);
  });

  it('stops cleanly when asked (Ctrl-C) and keeps what it has', async () => {
    const s = await shop();
    let n = 0;
    const r = await buildCatalog({ ...opts(s), shouldStop: () => ++n > 3 });
    expect(r.stopped).toBe('interrupted');
    expect((await loadCatalogFile(dir, 'x')).entries.length).toBeGreaterThanOrEqual(1);
  });

  it('caps the catalogue at maxProducts', async () => {
    const s = await shop();
    const r = await buildCatalog({ ...opts(s), maxProducts: 2 });
    expect(r.stopped).toMatch(/2 products reached/);
    expect((await loadCatalogFile(dir, 'x')).entries).toHaveLength(2);
  });

  it('takes a missing height from the 3D model (sofas often lack it) and says so', async () => {
    const noHeight = (h: string) =>
      h
        .replace('"height": "146.5 cm", ', '')
        .replace('<li class="pipf-measurements-tab__measurement-row"><span class="pipf-measurements-tab__measurement-name">Hauteur</span><span class="pipf-measurements-tab__measurement-value">146.5 cm</span></li>', '');
    const s = await shop({ pageOver: { '80275887': noHeight } });
    const r = await buildCatalog({ ...opts(s), limit: 1 });
    expect(r.dimsFromModel).toBe(1);
    const e = (await loadCatalogFile(dir, 'x')).entries[0]!;
    expect(e.record).toMatchObject({ dimsSource: 'model' });
    expect(Math.abs(e.record.dims.h - 1.465)).toBeLessThan(0.02);
    expect(e.flags.join()).toMatch(/derived from the 3D model/);
    expect(e.has3d).toBe(true);
  });

  it('rejects a page without enough dimensions and does not ask again before it ages', async () => {
    const noDims = (h: string) => h.replace(/"(width|depth|height)": "[^"]*", /g, '').replace(/<div class="pipf-measurements-tab">.*?<\/div>/s, '');
    const s = await shop({ pageOver: { '80275887': noDims } });
    const r = await buildCatalog({ ...opts(s), limit: 1 });
    expect(r.rejected).toBe(1);
    const file = await loadCatalogFile(dir, 'x');
    expect(file.entries).toHaveLength(0);
    expect(file.rejected['80275887']!.reason).toMatch(/product_dims_missing/);
    const asked = () => s.fetch.pages().filter((c) => c.url.includes('80275887/')).length;
    const n = asked();
    await buildCatalog({ ...opts(s), limit: 1 });
    expect(asked()).toBe(n);
  });

  it('a network failure on a model is not a verdict: the part is retried by the next build', async () => {
    const s = await shop();
    s.fetch.on(/web-api\.ikea\.com\/dimma\/assets\/1\.2\/80275887\//, () => new Response('boom', { status: 503 }));
    await buildCatalog({ ...opts(s), limit: 1 });
    const e = (await loadCatalogFile(dir, 'x')).entries[0]!;
    expect(e.incomplete).toContain('model');
    expect(e.has3d).toBe(false);
    const good = await makeGlb({ size: [0.765, 1.465, 0.39] });
    s.fetch.on(/web-api\.ikea\.com\/dimma\/assets\/1\.2\/80275887\//, () => new Response(good));
    const r = await buildCatalog({ ...opts(s), limit: 5 });
    expect(r.added).toBe(2); // the two others; the first is completed from its stored record
    const e2 = (await loadCatalogFile(dir, 'x')).entries.find((x) => x.record.sku === '80275887')!;
    expect(e2).toMatchObject({ has3d: true, incomplete: [] });
  });

  it('seeds: fetches the products of the design sessions first, by article number', async () => {
    const s = await shop();
    const r = await buildCatalog({ ...opts(s), queries: [], seedSkus: ['80275887'] });
    expect(r.added).toBe(1);
    expect((await loadCatalogFile(dir, 'x')).entries[0]!.queries).toEqual(['design sessions']);
  });

  it('aborts and saves progress when the shop blocks us (403), without hammering it', async () => {
    const s = await shop();
    s.fetch.on(/\/fr\/fr\/p\/.*20275814/, status(403));
    await expect(buildCatalog(opts(s))).rejects.toMatchObject({ code: 'provider_blocked' });
    expect((await loadCatalogFile(dir, 'x')).entries.map((e) => e.record.sku)).toEqual(['80275887']);
  });
});

describe('catalog:build --refresh-prices', () => {
  it('updates price and availability only: dims, model and photo are untouched; a vanished page is marked discontinued', async () => {
    const s = await shop();
    await buildCatalog(opts(s));
    const before = await loadCatalogFile(dir, 'x');
    const s2 = await shop({ price: { '80275887': '49.99' }, gone: ['00275848'] });
    s2.clock.advance(41 * 86_400_000);
    const r = await refreshPrices({ dir, ctx: s2.ctx, now: s2.now });
    expect(r).toMatchObject({ checked: 3, discontinued: ['00275848'], failed: [] });
    expect(r.changed).toEqual([{ sku: '80275887', from: 59.99, to: 49.99 }]);
    const after = await loadCatalogFile(dir, 'x');
    const a = after.entries.find((e) => e.record.sku === '80275887')!;
    const a0 = before.entries.find((e) => e.record.sku === '80275887')!;
    expect(a.record.price).toBe(49.99);
    expect(a.record.dims).toEqual(a0.record.dims);
    expect(a.model).toEqual(a0.model);
    expect(a.photo).toEqual(a0.photo);
    expect(a.record.fetchedAt > a0.record.fetchedAt).toBe(true);
    expect(a.availability).toBe('in_stock');
    expect(after.entries.find((e) => e.record.sku === '00275848')!.availability).toBe('discontinued');
    // no model or photo was fetched
    expect(s2.fetch.pages().some((c) => /dimma|images\/products/.test(c.url))).toBe(false);
  });
});

describe('helpers', () => {
  it('rejects implausible records', () => {
    expect(recordProblem(recordFor({ sku: '10000001' }))).toBeUndefined();
    expect(recordProblem(recordFor({ sku: '10000001', dims: { w: 12, d: 1, h: 1 } }))).toMatch(/implausible width/);
    expect(recordProblem(recordFor({ sku: '10000001', price: 0.0 }))).toMatch(/implausible price/);
    expect(recordProblem(recordFor({ sku: '10000001', priceTtc: false }))).toMatch(/TTC/);
  });

  it('parses a queries file and reads the article numbers of a scene', () => {
    expect(parseQueriesFile('# comment\ncanapé 3 places | sofa\n\nîlot cuisine  # inline\n')).toEqual([{ q: 'canapé 3 places', category: 'sofa' }, { q: 'îlot cuisine' }]);
    expect(() => parseQueriesFile('x | sofaa')).toThrow(/unknown category/);
    const scene = { items: [{ productRef: { provider: 'ikea-fr', sku: '80275887' } }, { product: { provider: 'ikea-fr', sku: '20275814' } }, { productRef: { provider: 'mock', sku: 'M1' } }, { productRef: { provider: 'ikea-fr', sku: 'abc' } }] };
    expect(skusFromScene(scene)).toEqual(['80275887', '20275814']);
  });

  it('reports the catalogue: counts, reasons, memory before and after', async () => {
    const s = await shop();
    await buildCatalog(opts(s));
    const r = await statusReport(dir, s.now());
    expect(r).toMatchObject({ exists: true, products: 3, withModel: 1, withoutModel: 2, stale: 0, photos: 3 });
    expect(r.decodedAfter).toBeLessThan(r.decodedBefore);
    const out = formatStatus(r);
    expect(out).toMatch(/3 products \(1 with a 3D model, 2 without\)/);
    expect(out).toMatch(/no 3D model because/);
    expect(formatStatus(await statusReport(join(dir, 'empty')))).toMatch(/No local catalogue/);
  });
});
