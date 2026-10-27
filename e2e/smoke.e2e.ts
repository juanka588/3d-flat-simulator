import { expect, test } from '@playwright/test';
import { flat, openApp, rendered, sampleFlat as sample } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('app loads the default flat and the test hook is ready', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Charme');
  const stats = await flat(page, (f) => f.stats());
  expect(stats.sceneName).toContain('Charme');
  expect(stats.calls).toBeGreaterThan(0);
  expect(stats.triangles).toBeGreaterThan(0);
});

test('capture() returns a decodable, non-blank PNG', async ({ page }) => {
  const url = await flat(page, (f) => f.capture());
  expect(url).toMatch(/^data:image\/png;base64,/);
  const result = await page.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const colours = new Set<number>();
    let opaque = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3]! > 0) opaque++;
      colours.add((px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!);
    }
    return { width: img.width, height: img.height, opaque, colours: colours.size };
  }, url);
  expect(result.width).toBeGreaterThan(100);
  expect(result.opaque).toBeGreaterThan(0);
  // Real geometry: more than the flat background colour.
  expect(result.colours).toBeGreaterThan(3);
});

test('mode switching updates the view and Esc leaves walk mode', async ({ page }) => {
  const mode = () => flat(page, (f) => f.stats().mode);
  expect(await mode()).toBe('orbit');

  await page.getByRole('button', { name: 'Top', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Top', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await rendered(page);
  expect(await mode()).toBe('top');

  await page.getByRole('button', { name: 'Walk' }).click();
  await rendered(page);
  expect(await mode()).toBe('walk');
  await expect(page.getByText(/Esc to leave/)).toBeVisible();
  // The player spawns inside the flat (plan bounds of the default Charme fixture).
  const [x, y, z] = (await flat(page, (f) => f.stats())).camera;
  expect(x).toBeGreaterThan(-1.6);
  expect(x).toBeLessThan(10.15);
  expect(z).toBeGreaterThan(-0.1);
  expect(z).toBeLessThan(8.38);
  expect(y).toBeCloseTo(1.55, 2); // eyes of a 166 cm person

  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Orbit' })).toHaveAttribute('aria-pressed', 'true');
  expect(await mode()).toBe('orbit');
});

test('the scene picker loads the sample flat', async ({ page }) => {
  await page.getByLabel('Flat', { exact: true }).selectOption('sample');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(sample.name);
  await rendered(page);
  expect((await flat(page, (f) => f.stats())).sceneName).toBe(sample.name);
});

test('an invalid file shows the error panel and keeps the previous scene', async ({ page }) => {
  const title = await page.getByRole('heading', { level: 1 }).textContent();
  await page.getByTestId('file-input').setInputFiles({
    name: 'broken.flat.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ "version": 1, '),
  });
  const panel = page.getByTestId('error-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('listitem')).not.toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title ?? '');

  await page.getByTestId('file-input').setInputFiles({
    name: 'wrong.flat.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 2 })),
  });
  await expect(panel.getByRole('listitem')).not.toHaveCount(0);
});

test('a valid file loads and clears the error panel', async ({ page }) => {
  await page.getByTestId('file-input').setInputFiles({ name: 'x', mimeType: 'application/json', buffer: Buffer.from('nope') });
  await expect(page.getByTestId('error-panel')).toBeVisible();
  await page.getByTestId('file-input').setInputFiles({
    name: 'ok.flat.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await expect(page.getByTestId('error-panel')).toBeHidden();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(sample.name);
});

test('selecting a wall shows its properties', async ({ page }) => {
  await page.getByLabel('Flat', { exact: true }).selectOption('sample');
  const id = sample.walls[0]!.id;
  expect(await page.evaluate((wallId) => window.__flat!.select(wallId), id)).toBe(true);
  await expect(page.getByTestId('properties')).toContainText(`Wall ${id}`);
  await expect(page.getByTestId('properties')).toContainText('Net area');
});

test('the sample flat lists its warnings and clicking one selects its entity', async ({ page }) => {
  await page.getByLabel('Flat', { exact: true }).selectOption('sample');
  const warnings = page.getByTestId('warnings');
  await expect(warnings.getByRole('listitem')).toHaveCount(4);
  await expect(warnings.getByRole('heading')).toContainText('(4)');
  await expect(page.getByTestId('properties')).toContainText('Click a wall');

  await warnings.getByRole('button').first().click();
  await expect(page.getByTestId('properties')).not.toContainText('Click a wall');
  await expect(page.getByTestId('properties').getByRole('heading')).toBeVisible();
});
