/**
 * The production build under the Pages base path (project "static"): the texture grid, the Library thumbnails
 * (CC0 models and generated parametric ones) and placed library models all resolve under the base path, with
 * no 404 and nothing requested outside it, and every thumbnail shows after scrolling its container.
 *
 * Screenshots: in the test's output folder (test-results/)
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
  await page.screenshot({ path: test.info().outputPath('pages-textures.png') });
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
  await page.screenshot({ path: test.info().outputPath('pages-library.png') });

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

test('HD models: listed with thumbnails and credits, fetched lazily from models-hd under the base path, nothing foreign', async ({ page }) => {
  const traffic = watch(page);
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  await page.goto('?test');
  await page.evaluate(() => window.__flat!.ready);
  await page.getByRole('tab', { name: 'Library' }).click();
  const hdCards = page.locator('[data-testid=model-card][data-asset-id^="sketchfab:"]');
  await expect.poll(() => hdCards.count()).toBeGreaterThanOrEqual(20);
  const n = await hdCards.count();
  for (let i = n - 1; i >= 0; i -= 4) await hdCards.nth(i).scrollIntoViewIfNeeded();
  await expect.poll(() => unloaded(page, '[data-testid=model-card][data-asset-id^="sketchfab:"] img')).toBe(0);
  expect(traffic.requests.filter((p) => p.startsWith(`${BASE}models-hd/thumbs/`)).length).toBeGreaterThanOrEqual(20);
  await expect(hdCards.first().locator('.badge', { hasText: 'HD' })).toBeVisible();

  // Credits panel: title, author, source and licence of every CC BY model.
  const credits = page.getByTestId('model-credits');
  await credits.locator('summary').click();
  const lines = credits.locator('li');
  expect(await lines.count()).toBeGreaterThanOrEqual(20);
  for (const text of await lines.allInnerTexts()) expect(text).toMatch(/^".+" by .+, Sketchfab, CC-BY-4\.0/);
  const hrefs = await credits.locator('li a').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(hrefs.length).toBe(await lines.count());
  for (const h of hrefs) expect(h).toMatch(/^https:\/\/sketchfab\.com\/3d-models\//);
  await page.screenshot({ path: test.info().outputPath('pages-library-hd.png') });

  // Lazy: a hero model nobody uses yet is not downloaded until it is placed.
  const glbs = () => traffic.requests.filter((p) => p.startsWith(`${BASE}models-hd/`) && p.endsWith('.glb'));
  const slug = ['nightstand_oak', 'plant_snake', 'pouf_ribbed', 'cushion_waves', 'bench_upholstered'].find((s) => !glbs().includes(`${BASE}models-hd/${s}.glb`));
  expect(slug, 'a candidate hero model that the default flat does not already use').toBeTruthy();
  await page.evaluate(() => window.__flat!.select('sejour'));
  await page.locator(`[data-testid=model-card][data-asset-id="sketchfab:${slug}"]`).getByTestId('add-to-room').click();
  await expect.poll(() => glbs()).toContain(`${BASE}models-hd/${slug}.glb`);
  await page.evaluate(() => window.__flat!.whenRendered());
  const stats = await page.evaluate(() => window.__flat!.modelStats());
  expect(stats.failed).toBe(0);
  expect(Object.values(stats.sources)).not.toContain('placeholder');
  // Textured hero models decode their embedded images through blob: URLs (same origin by construction); anything else must be under the base path.
  const foreign = urls.filter((u) => !u.startsWith(`${new URL(page.url()).origin}${BASE}`) && !u.startsWith('blob:') && !u.startsWith('data:'));
  expect(foreign).toEqual([]);
  expect(traffic.bad).toEqual([]);
});
