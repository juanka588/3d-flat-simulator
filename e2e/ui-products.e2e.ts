/**
 * Products tab when the scene server is not up yet: the dev page keeps probing and connects by itself once a
 * server appears (`?probe=<url>` points the probe at the test server, since automated browsers never probe the
 * default address); the offline hint tells how to start one; an empty search names the query and the providers.
 * Library: short generator names and their generated thumbnails.
 *
 * Screenshots: in the test's output folder (test-results/)
 */
import { createServer } from 'node:net';
import { expect, test } from '@playwright/test';
import { startServer } from './server';

test.describe.configure({ timeout: 120_000 });

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

test('a page opened before the server connects by itself when it starts', async ({ page }) => {
  const port = await freePort();
  await page.goto(`/?probe=${encodeURIComponent(`http://127.0.0.1:${port}`)}`);
  await page.evaluate(() => window.__flat!.ready);
  const hint = page.getByTestId('catalog-server-hint');
  await expect(hint).toContainText('Scene server not running');
  await expect(hint).toContainText('pnpm@10 dev:all');
  await expect(hint).toContainText('FLAT_PROVIDERS=ikea-fr');
  await expect(page.getByTestId('catalog-retry')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('products-offline.png') });

  const server = await startServer({ providers: 'mock', port });
  try {
    await expect(page.getByTestId('catalog-search')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => window.__flat!.connection().status), { timeout: 20_000 }).toBe('connected');
    await expect(hint).toHaveCount(0);

    // a search with no match says so, and which providers were asked
    await page.getByTestId('catalog-search').fill('zzzqqq');
    const none = page.getByTestId('catalog-no-results');
    await expect(none).toContainText('No results for "zzzqqq"', { timeout: 15_000 });
    await expect(none).toContainText('mock');

    await page.getByTestId('catalog-search').fill('bed');
    await expect(page.getByTestId('product-card').first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('products-connected.png') });
  } finally {
    await server.stop();
  }
});

test('Retry in the offline hint connects right away', async ({ page }) => {
  const port = await freePort();
  await page.goto(`/?probe=${encodeURIComponent(`http://127.0.0.1:${port}`)}`);
  await page.evaluate(() => window.__flat!.ready);
  await expect(page.getByTestId('catalog-retry')).toBeVisible();
  await page.getByTestId('catalog-retry').click();
  await expect(page.getByTestId('catalog-server-hint')).toBeVisible(); // still nothing there
  const server = await startServer({ providers: 'mock', port });
  try {
    // The background probe may have won and removed the button; without a short timeout the click would wait out the whole test.
    await page.getByTestId('catalog-retry').click({ timeout: 2_000 }).catch(() => undefined);
    await expect(page.getByTestId('catalog-search')).toBeVisible({ timeout: 30_000 });
  } finally {
    await server.stop();
  }
});

test('a connected server without any provider says so', async ({ page }) => {
  const server = await startServer({ providers: '' });
  try {
    await page.goto(`/?server=${encodeURIComponent(server.url)}`);
    await page.evaluate(() => window.__flat!.ready);
    await expect(page.getByTestId('no-provider')).toContainText('no product provider is enabled', { timeout: 20_000 });
    await expect(page.getByTestId('no-provider')).toContainText('FLAT_PROVIDERS=ikea-fr');
  } finally {
    await server.stop();
  }
});

test('the Library shows short names and a thumbnail for every parametric generator', async ({ page }) => {
  await page.goto('/?test');
  await page.evaluate(() => window.__flat!.ready);
  await page.getByRole('tab', { name: 'Library' }).click();
  const cards = page.getByTestId('generator-card');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThanOrEqual(20);
  const names = await cards.locator('.name').allTextContents();
  for (const n of names) expect(n.length, n).toBeLessThanOrEqual(24);
  expect(names).toEqual(expect.arrayContaining(['Bathtub', 'Cooktop', 'Kitchen wall unit', 'Wardrobe', 'Bed']));
  // the long description stays available as a tooltip
  await expect(page.locator('[data-generator="cooktop"]')).toHaveAttribute('title', /Cooking block/);
  await expect
    .poll(() => cards.locator('img').evaluateAll((imgs) => imgs.filter((i) => !((i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)).length))
    .toBe(0);
  expect(await cards.locator('img').count()).toBe(await cards.count());
  await page.screenshot({ path: test.info().outputPath('library-thumbs.png') });
});
