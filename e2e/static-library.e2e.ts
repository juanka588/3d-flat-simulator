/**
 * The production build under the Pages base path (project "static"): the texture grid, the Library thumbnails
 * (CC0 models and generated parametric ones) and placed library models all resolve under the base path, with
 * no 404 and nothing requested outside it, and every thumbnail shows after scrolling its container.
 *
 * Screenshots: /tmp/ui-fixes/pages-textures.png, /tmp/ui-fixes/pages-library.png
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const BASE = '/3d-flat-simulator/';

function watch(page: Page) {
  const t = { requests: [] as string[], bad: [] as string[] };
  page.on('request', (r) => t.requests.push(new URL(r.url()).pathname));
  page.on('response', (r) => {
    if (r.status() >= 400) t.bad.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  return t;
}

const unloaded = (page: Page, selector: string) =>
  page.$$eval(selector, (imgs) => imgs.filter((i) => !((i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)).length);

test('texture grid thumbnails all load, also after scrolling', async ({ page }) => {
  const traffic = watch(page);
  await page.goto('?test');
  await page.evaluate(() => window.__flat!.ready);
  await page.evaluate(() => window.__flat!.select('sejour'));
  await page.getByTestId('properties').getByRole('region', { name: 'Finish' }).getByRole('tab', { name: 'Textures' }).click();
  const cards = page.locator('.texture-card');
  await expect(cards.first()).toBeVisible();
  const n = await cards.count();
  expect(n).toBeGreaterThan(10);
  for (let i = n - 1; i >= 0; i -= 4) await cards.nth(i).scrollIntoViewIfNeeded();
  await expect.poll(() => unloaded(page, '.texture-card img')).toBe(0);
  await page.screenshot({ path: '/tmp/ui-fixes/pages-textures.png' });
  expect(traffic.requests.filter((p) => !p.startsWith(BASE))).toEqual([]);
  expect(traffic.bad).toEqual([]);
});

test('Library thumbnails (generated and CC0) load under the base path, and placing both draws real models', async ({ page }) => {
  const traffic = watch(page);
  await page.goto('?test');
  await page.evaluate(() => window.__flat!.ready);
  await page.getByRole('tab', { name: 'Library' }).click();
  const imgs = page.locator('[data-testid=generator-card] img, [data-testid=model-card] img');
  await expect(imgs.first()).toBeVisible();
  // The CC0 models load after the generator cards (async catalog), so wait for them instead of counting at once.
  await expect.poll(() => imgs.count()).toBeGreaterThanOrEqual(60);
  const n = await imgs.count();
  for (let i = n - 1; i >= 0; i -= 5) await imgs.nth(i).scrollIntoViewIfNeeded();
  await expect.poll(() => unloaded(page, '[data-testid=generator-card] img, [data-testid=model-card] img')).toBe(0);
  expect(traffic.requests.filter((p) => p.includes('/thumbs/param-')).length).toBeGreaterThanOrEqual(20);
  await page.screenshot({ path: '/tmp/ui-fixes/pages-library.png' });

  await page.evaluate(() => window.__flat!.select('sejour'));
  await page.getByTestId('model-card').first().getByTestId('add-to-room').click();
  await page.evaluate(() => window.__flat!.select('ch1'));
  await page.locator('[data-generator="bed"]').getByTestId('add-to-room').click();
  await expect.poll(() => page.evaluate(() => Object.values(window.__flat!.modelStats().sources).filter((s) => s === 'lookalike' || s === 'parametric').length)).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => window.__flat!.whenRendered());
  const stats = await page.evaluate(() => window.__flat!.modelStats());
  expect(stats.failed).toBe(0);
  expect(Object.values(stats.sources)).not.toContain('placeholder');
  expect(traffic.requests.filter((p) => !p.startsWith(BASE))).toEqual([]);
  expect(traffic.bad).toEqual([]);
});
