/**
 * The viewer never goes silently empty: when drawing a scene throws, the last good flat stays on screen
 * and a banner says what happened; the next good scene clears it. (Regression for "the web UI rendered
 * nothing but the sky" after an assistant edit: with no error boundary a throw in the shell build left only the background.)
 */
import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

test('a scene that fails to draw keeps the last good flat and shows a banner; the next good scene recovers', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await openApp(page);
  const good = await page.evaluate(() => window.__flat!.getScene());
  const before = await page.evaluate(() => window.__flat!.stats().triangles);
  expect(before).toBeGreaterThan(1000);

  // The test-only hook: a scene named __viewer_fault__* throws while the shell is built.
  await page.evaluate((s) => void window.__flat!.loadScene({ ...s, name: '__viewer_fault__ broken' }), good);
  const banner = page.getByTestId('viewer-error');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('could not draw the flat');
  await expect(banner).toContainText('injected viewer fault');
  await expect(banner).toContainText('last version that drew correctly');
  await expect(page.getByTestId('viewer-error-export')).toBeVisible();
  // Still drawing the previous flat: geometry, not an empty sky.
  const kept = await page.evaluate(() => window.__flat!.stats());
  expect(kept.triangles).toBeGreaterThan(1000);
  expect(kept.meshes).toEqual(expect.arrayContaining(['walls', 'floors']));
  await expect(page.locator('canvas')).toBeVisible();

  await page.evaluate((s) => window.__flat!.loadScene(s), good);
  await expect(banner).toBeHidden();
  expect(await page.evaluate(() => window.__flat!.stats().triangles)).toBeGreaterThan(1000);
  // React re-reports a caught render error as a window error in dev; nothing else may be thrown.
  expect(pageErrors.filter((m) => !m.includes('injected viewer fault'))).toEqual([]);
});
