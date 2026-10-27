/**
 * M5.18, the Pages build (project "static": `BASE_PATH=/3d-flat-simulator/ vite build` served by `vite preview`):
 * with a product item in the flat and no scene server there is no request to a retailer, to a provider or to /api.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

async function openHooked(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('?test');
  await page.evaluate(() => window.__flat!.ready);
  await expect(page.locator('canvas')).toBeVisible();
}

test('Pages mode with a product item: no retailer, provider or API request (M5.18)', async ({ page }) => {
  const hosts = (JSON.parse(readFileSync('scripts/ci/retailer-hosts.json', 'utf8')) as { hosts: string[] }).hosts;
  const origin = 'http://127.0.0.1:4173';
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  await openHooked(page);
  const flatJson = JSON.parse(readFileSync('packages/scene/fixtures/charme-3205.flat.json', 'utf8')) as { items: unknown[] };
  const ikeaBed = {
    id: 'static-bed',
    assetId: 'product:ikea-fr',
    position: [8.3, 1.9],
    elevation: 0,
    rotation: 0,
    roomId: 'ch1',
    productRef: { provider: 'ikea-fr', sku: '49018739' },
    product: { provider: 'ikea-fr', sku: '49018739', name: 'BRIMNES bed frame', url: 'https://shop.example/p/brimnes-bed-frame/', price: 359, currency: 'EUR', dims: { w: 1.66, d: 2.06, h: 0.47 }, category: 'bed', snapshotAt: '2026-10-27T10:00:00Z' },
    mesh: { kind: 'provider' },
  };
  expect(await page.evaluate(async (j) => (await window.__flat!.loadScene(j)).ok, { ...flatJson, items: [...flatJson.items, ikeaBed] })).toBe(true);
  await page.evaluate(() => window.__flat!.whenRendered());
  await page.waitForLoadState('networkidle');
  const stats = await page.evaluate(() => window.__flat!.modelStats());
  expect(['lookalike', 'parametric']).toContain(stats.sources['static-bed']);
  expect(stats.offline).toContain('static-bed');
  const foreign = urls.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'));
  expect(foreign).toEqual([]);
  expect(urls.filter((u) => hosts.some((h) => new URL(u).hostname === h || new URL(u).hostname.endsWith(`.${h}`)))).toEqual([]);
  expect(urls.filter((u) => /\/api\//.test(u))).toEqual([]);
});
