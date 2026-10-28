import { expect, test } from '@playwright/test';
import { flat, openApp, rendered, savePng } from './helpers';

const SHOTS = process.env.E2E_SHOTS;

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test.describe('desktop sidebar', () => {
  test('the sidebar can be collapsed, the canvas takes the freed width, and the choice persists', async ({ page }) => {
    const toggle = page.getByRole('button', { name: 'Menu' });
    const sidebar = page.locator('#sidebar');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(sidebar).toBeVisible();
    const canvasWidth = async () => (await page.locator('canvas').boundingBox())!.width;
    const narrow = await canvasWidth();
    expect(narrow).toBeCloseTo(980, 0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar).toBeHidden();
    await expect.poll(canvasWidth).toBeCloseTo(1280, 0); // the canvas resized to the full window
    await rendered(page);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-collapsed.png` });

    await page.reload();
    await page.evaluate(() => window.__flat!.ready);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar).toBeHidden();
    expect(await canvasWidth()).toBeCloseTo(1280, 0);

    await toggle.click();
    await expect(sidebar).toBeVisible();
    await expect.poll(canvasWidth).toBeCloseTo(980, 0);
    await page.reload();
    await page.evaluate(() => window.__flat!.ready);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('the toggle is reachable and operable by keyboard', async ({ page }) => {
    const toggle = page.getByRole('button', { name: 'Menu' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});

test.describe('walk view', () => {
  async function walkAt(page: import('@playwright/test').Page, pose: { x: number; z: number; yawDeg: number }) {
    await page.evaluate(() => window.__flat!.setClock('manual'));
    await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
    await page.evaluate((p) => window.__flat!.setWalkPose(p), pose);
  }

  test('defaults to a 166 cm person: eyes at 1.55 m and a 60 degree vertical fov on landscape', async ({ page }) => {
    await expect(page.getByLabel('Person height')).toHaveValue('166');
    await expect(page.getByTestId('eye-height')).toContainText('1.55 m');
    await walkAt(page, { x: 2.45, z: 5.3, yawDeg: 0 });
    const s = await flat(page, (f) => f.stats());
    expect(s.camera[1]).toBeCloseTo(1.55, 3);
    expect(s.fov).toBe(60); // the walk fov was widened from 50 to 60 degrees
  });

  test('the person height setting moves the eyes live and is remembered', async ({ page }) => {
    await walkAt(page, { x: 2.45, z: 5.3, yawDeg: 0 });
    const input = page.getByLabel('Person height');
    await input.fill('180');
    await expect(page.getByTestId('eye-height')).toContainText('1.69 m');
    await rendered(page);
    expect((await flat(page, (f) => f.stats())).camera[1]).toBeCloseTo(1.69, 3);
    // Walking keeps the new height.
    await page.evaluate(() => window.__flat!.stepWalk(200));
    expect((await flat(page, (f) => f.stats())).camera[1]).toBeCloseTo(1.69, 3);

    // Out of range is flagged and not applied.
    await input.fill('300');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await rendered(page);
    expect((await flat(page, (f) => f.stats())).camera[1]).toBeCloseTo(1.69, 3);

    await page.reload();
    await page.evaluate(() => window.__flat!.ready);
    await expect(page.getByLabel('Person height')).toHaveValue('180');
    await walkAt(page, { x: 2.45, z: 5.3, yawDeg: 0 });
    expect((await flat(page, (f) => f.stats())).camera[1]).toBeCloseTo(1.69, 3);
  });

  test('3 m from the TV the screen fills a natural part of the view', async ({ page }) => {
    await walkAt(page, { x: 2.45, z: 5.3, yawDeg: 0 }); // 3 m south of the TV on the alcove wall, facing it
    await rendered(page);
    const viewport = page.viewportSize()!;
    const left = await page.evaluate(() => window.__flat!.project([2.45 - 0.615, 1.1, 2.33]));
    const right = await page.evaluate(() => window.__flat!.project([2.45 + 0.615, 1.1, 2.33]));
    const share = (right.x - left.x) / viewport.width;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.3);
    if (SHOTS) await savePng(page, `${SHOTS}/walk-166.png`);
  });
});
