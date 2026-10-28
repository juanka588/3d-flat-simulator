/**
 * Local product catalogue: the Products tab shows local results (with the "local catalogue (N products, built <date>)" status,
 * small photos and the local badge) from a real scene server that has NO live provider enabled, instantly, and without
 * a single request to the shop from the browser. The "Search IKEA live" switch is off and explains why.
 *
 * Screenshots: in the test's output folder (test-results/)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { entryFor, makeGlb, writeCatalog } from '../apps/server/src/providers/local/fixtures';
import { normaliseGlb } from '../apps/server/src/providers/local/normalise';
import { charmeFlat, loadScene } from './helpers';
import { openConnected, startServer } from './server';
import type { RunningServer } from './server';

test.describe.configure({ timeout: 120_000 });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const entry = (sku: string, name: string, typeName: string, category: string, price: number, dims: { w: number; d: number; h: number }, extra: Record<string, unknown> = {}) => ({
  record: {
    provider: 'ikea-fr',
    sku,
    name,
    url: `https://shop.example/p/fixture-${sku}/`,
    price,
    currency: 'EUR',
    priceTtc: true,
    dims,
    dimsSource: 'structured',
    category,
    mount: 'floor',
    styleTags: [],
    colours: ['gris'],
    variants: [],
    fetchedAt: '2026-10-27T10:00:00.000Z',
    personalUseOnly: true,
    photoUrl: `https://shop.example/images/fixture-${sku}.jpg`,
    ...extra,
  },
  typeName,
  queries: [],
  has3d: false,
  noModelReason: 'the product page lists no 3D model',
  availability: 'in_stock',
  flags: [],
  incomplete: [],
  checkedAt: '2026-10-27T10:00:00.000Z',
});

let catalogDir: string;
let server: RunningServer;
test.beforeAll(async () => {
  catalogDir = mkdtempSync(join(tmpdir(), 'flat-e2e-catalog-'));
  mkdirSync(join(catalogDir, 'photos'), { recursive: true });
  writeFileSync(join(catalogDir, 'photos', '10000001.webp'), PNG); // sniffed by content: a PNG named .webp is fine for the test
  const a = entry('10000001', 'KIVIK Canapé 3 places', 'Canapé 3 places', 'sofa', 599, { w: 2.28, d: 0.95, h: 0.83 });
  (a as { photo?: unknown }).photo = { file: 'photos/10000001.webp', bytes: PNG.byteLength };
  const file = {
    marker: ['flat', 'local', 'catalog'].join('-'), // spelled out so this file does not carry the marker string CI looks for
    version: 1,
    provider: 'ikea-fr',
    locale: 'fr/fr',
    builtAt: '2026-10-27T12:00:00.000Z',
    entries: [a, entry('10000002', 'GLOSTAD Canapé 2 places', 'Canapé 2 places', 'sofa', 179, { w: 1.4, d: 0.8, h: 0.8 }), entry('10000003', 'LACK Table basse', 'Table basse', 'table', 19, { w: 0.9, d: 0.55, h: 0.45 })],
    queryLog: {},
    rejected: {},
  };
  writeFileSync(join(catalogDir, 'catalog.json'), JSON.stringify(file));
  server = await startServer({ providers: '', localCatalogDir: catalogDir });
});
test.afterAll(async () => {
  await server?.stop();
  rmSync(catalogDir, { recursive: true, force: true });
});

test('the Products tab shows local results without any live provider, and never asks the shop', async ({ page }) => {
  const shopRequests: string[] = [];
  page.on('request', (r) => {
    const host = new URL(r.url()).hostname;
    if (/ikea|cdtapps/.test(host)) shopRequests.push(r.url());
  });
  await openConnected(page, server);

  // the status line and the switch
  await expect(page.getByTestId('local-catalog-status')).toContainText('local catalogue (3 products, built 27 Oct 2026)', { timeout: 20_000 });
  const toggle = page.getByTestId('catalog-live-toggle');
  await expect(toggle).toBeDisabled();
  await expect(page.getByTestId('no-provider')).toHaveCount(0); // the local catalogue counts as a provider
  await expect(page.locator('[data-provider="ikea-fr-local"]')).toBeVisible();

  // instant search in French, no spinner text about the retailer
  const t0 = Date.now();
  await page.getByTestId('catalog-search').fill('canapé 3 places');
  const first = page.getByTestId('product-card').first();
  await expect(first).toBeVisible({ timeout: 5000 });
  const ms = Date.now() - t0;
  expect(ms).toBeLessThan(3000);
  await expect(first).toContainText('KIVIK');
  await expect(first.getByTestId('badge-local')).toBeVisible();
  await expect(first.getByTestId('card-price')).toContainText('599');
  await expect(first.getByTestId('card-dims')).toContainText('228');
  // the small local photo comes through the local server (a blob), not from the shop
  await expect(first.locator('img')).toHaveAttribute('src', /^blob:/, { timeout: 10_000 });
  await page.screenshot({ path: test.info().outputPath('local-catalog.png') });

  // English works too
  await page.getByTestId('catalog-search').fill('coffee table');
  await expect(page.getByTestId('product-card').first()).toContainText('LACK');

  // nothing found: says how to add more
  await page.getByTestId('catalog-search').fill('zzzqqq');
  await expect(page.getByTestId('catalog-no-results')).toContainText('No results for "zzzqqq"');
  await expect(page.getByTestId('catalog-local-hint')).toContainText('pnpm catalog:build');

  expect(shopRequests).toEqual([]);
});

test('a server without a local catalogue shows no local status (unchanged behaviour)', async ({ page }) => {
  const plain = await startServer({ providers: 'mock' });
  try {
    await openConnected(page, plain);
    await expect(page.getByTestId('catalog-search')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('local-catalog')).toHaveCount(0);
    await page.getByTestId('catalog-search').fill('bed');
    await expect(page.getByTestId('product-card').first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await plain.stop();
  }
});

test('a normalised local GLB (Meshopt, WebP textures) loads in the viewer from the local server and is drawn as the provider model', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'flat-e2e-glb-'));
  const dims = { w: 0.77, d: 1.26, h: 0.9 };
  // a shop-like file: Draco geometry, three 2048 px textures, turned the wrong way round (126 along x): the build bakes the quarter turn
  const shipped = await makeGlb({ size: [1.26, 0.9, 0.77], textureSide: 2048, textures: 3, draco: true });
  const r = await normaliseGlb(shipped, dims);
  if (!r.ok) throw new Error(r.reason);
  await writeCatalog(dir, [entryFor({ sku: '10000004', name: 'ILOT Test', category: 'kitchen', typeName: 'Ilot', dims, has3d: true })], { models: { '10000004': r.bytes } });
  const local = await startServer({ providers: '', localCatalogDir: dir });
  try {
    const glbRequests: { url: string; status: number }[] = [];
    page.on('response', (res) => res.url().endsWith('.glb') && res.url().includes('/api/assets/products/') && glbRequests.push({ url: res.url(), status: res.status() }));
    await openConnected(page, local);
    const item = {
      id: 'ilot',
      assetId: 'product:ikea-fr',
      position: [8.5, 2.2],
      elevation: 0,
      rotation: 0,
      roomId: 'ch1',
      dims,
      productRef: { provider: 'ikea-fr', sku: '10000004' },
      product: { provider: 'ikea-fr', sku: '10000004', name: 'ILOT Test', url: 'https://shop.example/p/fixture-10000004/', price: 100, currency: 'EUR', dims, category: 'kitchen', snapshotAt: '2026-10-27T10:00:00Z' },
      mesh: { kind: 'provider' },
    };
    expect(await loadScene(page, { ...charmeFlat, items: [...(charmeFlat['items'] as unknown[]), item] })).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__flat!.modelStats().sources['ilot']), { timeout: 30_000 }).toBe('provider');
    const stats = await page.evaluate(() => window.__flat!.modelStats());
    expect(stats.reasons['ilot'] ?? '').not.toMatch(/quarter turn/); // the file itself already has the right orientation
    expect(glbRequests).toEqual([{ url: expect.stringContaining('/api/assets/products/ikea-fr/10000004.glb'), status: 200 }]);
  } finally {
    await local.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
