/**
 * M5.14 persistence and offline: a saved flat keeps only the product reference and snapshot (no photos, no models, no
 * URL but the buy link), reopens without a server on stand-in meshes with an "offline" badge, re-resolves real models
 * when a server is there, offers "Update price/dims" for a stale snapshot, and a Pages-style session (no `?server`)
 * shows the "connect the server" hint and makes no provider request.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { findExportViolations } from '../apps/web/src/state/export-guard';
import { sofaGlb } from '../apps/web/src/viewer/synthetic-glb';
import { charmeFlat, flat, loadScene, openApp, rendered } from './helpers';
import { openConnected, startServer, WEB_ORIGIN } from './server';

test.describe.configure({ timeout: 120_000 });

const bedItem = (snapshotAt: string, price = 299) => ({
  id: 'bed-1',
  assetId: 'product:mock',
  position: [8.2, 2],
  elevation: 0,
  rotation: 0,
  roomId: 'ch1',
  mount: 'floor',
  dims: { w: 1.6, d: 2, h: 0.9 },
  mesh: { kind: 'provider' },
  productRef: { provider: 'mock', sku: 'MOCK-BED-160' },
  product: { provider: 'mock', sku: 'MOCK-BED-160', name: 'MOCK Double bed frame 160x200', url: 'https://shop.mock.example/p/mock-bed-160', price, currency: 'EUR', dims: { w: 1.6, d: 2, h: 0.9 }, category: 'bed', snapshotAt },
});
const sceneWith = (...items: unknown[]) => ({ ...charmeFlat, items: [...(charmeFlat['items'] as unknown[]), ...items] });
const recent = () => new Date().toISOString();
const old = () => new Date(Date.now() - 30 * 86_400_000).toISOString();

async function stubProviderModel(page: Page): Promise<void> {
  const glb = Buffer.from(sofaGlb());
  await page.route('**/api/assets/products/mock/*.glb', (r) => r.fulfill({ status: 200, contentType: 'model/gltf-binary', headers: { 'access-control-allow-origin': WEB_ORIGIN }, body: glb }));
}

test('the exported flat holds only the reference and the snapshot', async ({ page }) => {
  await openApp(page);
  expect(await loadScene(page, sceneWith(bedItem(recent())))).toBe(true);
  const text = await page.evaluate(() => window.__flat!.exportScene());
  expect(text).toContain('MOCK-BED-160');
  expect(findExportViolations(JSON.parse(text))).toEqual([]);
  // a photo smuggled into a snapshot is refused by the schema, so it can never reach a file
  const dirty = sceneWith({ ...bedItem(recent()), product: { ...bedItem(recent()).product, photoUrl: 'https://cdn.example/bed.jpg' } });
  expect(await loadScene(page, dirty)).toBe(false);
});

test('reopen without a server: stand-in meshes and an offline badge, also after a reload', async ({ page }) => {
  await openApp(page);
  await loadScene(page, sceneWith(bedItem(recent())));
  const check = async () => {
    await rendered(page);
    const stats = await flat(page, (f) => f.modelStats());
    expect(stats.offline).toContain('bed-1');
    expect(stats.sources['bed-1']).not.toBe('provider');
    await flat(page, (f) => f.select('bed-1'));
    await expect(page.getByTestId('badge-mesh')).toHaveAttribute('data-source', 'offline');
    await expect(page.getByTestId('room-items')).toContainText('offline');
  };
  await check();
  await flat(page, (f) => f.flushAutosave());
  await page.reload();
  await page.evaluate(() => window.__flat!.ready);
  await check();
});

test('reopen with a server: the real model is resolved again', async ({ page }) => {
  const server = await startServer({ providers: 'mock' });
  try {
    await stubProviderModel(page);
    await openConnected(page, server);
    await loadScene(page, sceneWith(bedItem(recent())));
    await expect.poll(() => flat(page, (f) => f.connection().pending)).toBe(0);
    await page.reload();
    await page.evaluate(() => window.__flat!.ready);
    await expect.poll(() => page.evaluate(() => window.__flat!.connection().status)).toBe('connected');
    await expect.poll(async () => (await flat(page, (f) => f.modelStats())).sources['bed-1']).toBe('provider');
    await flat(page, (f) => f.select('bed-1'));
    await expect(page.getByTestId('badge-mesh')).toHaveAttribute('data-source', 'real');
  } finally {
    await server.stop();
  }
});

test('a stale snapshot offers "Update price/dims", which refreshes it from the server', async ({ page }) => {
  const server = await startServer({ providers: 'mock' });
  try {
    await openConnected(page, server);
    await loadScene(page, sceneWith(bedItem(old(), 1)));
    await expect.poll(() => flat(page, (f) => f.connection().pending)).toBe(0);
    await flat(page, (f) => f.select('bed-1'));
    const props = page.getByTestId('item-properties');
    await expect(props.getByTestId('stale-badge')).toBeVisible();
    await expect(props.getByTestId('item-price')).toContainText('1,00');
    await props.getByTestId('update-price').click();
    await expect(props.getByTestId('item-price')).toContainText('299,00');
    await expect(props.getByTestId('stale-badge')).toHaveCount(0);
    const p = await flat(page, (f) => f.getScene().items.find((i) => i.id === 'bed-1')!.product!);
    expect(p.price).toBe(299);
    expect(Date.now() - Date.parse(p.snapshotAt)).toBeLessThan(60_000);
    await page.screenshot({ path: '/tmp/catalog-stale.png' });
  } finally {
    await server.stop();
  }
});

test('Pages mode (no ?server): the hint, and no provider or retailer request', async ({ page }) => {
  const seen: string[] = [];
  page.on('request', (r) => seen.push(r.url()));
  await openApp(page);
  await expect(page.getByTestId('catalog-server-hint')).toContainText('pnpm dev:all');
  await expect(page.getByTestId('catalog-search')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Library' }).click();
  await expect(page.getByTestId('generator-card').first()).toBeVisible();
  const foreign = seen.filter((u) => !u.startsWith(WEB_ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:'));
  expect(foreign).toEqual([]);
  expect(seen.filter((u) => /\/api\//.test(u))).toEqual([]);
});
