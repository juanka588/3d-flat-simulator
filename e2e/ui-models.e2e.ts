/**
 * An item whose model cannot be shown (a retailer product, no server, nothing in the library that resembles it)
 * is drawn as a neutral grey box at its exact size, and the item panel's badge says why. Never magenta triangles.
 *
 * Screenshot: /tmp/ui-fixes/placeholder-box.png
 */
import { expect, test } from '@playwright/test';
import { charmeFlat, flat, loadScene, openApp, rendered } from './helpers';

test('an unresolvable product is a plain box with a badge that explains why', async ({ page }) => {
  await openApp(page);
  const item = {
    id: 'mystery',
    assetId: 'product:mock',
    position: [8.5, 2.2],
    elevation: 0,
    rotation: 0,
    roomId: 'ch1',
    productRef: { provider: 'mock', sku: 'ODD-1' },
    product: { provider: 'mock', sku: 'ODD-1', name: 'Odd thing', url: 'https://example.com/odd', price: 10, currency: 'EUR', dims: { w: 0.6, d: 0.6, h: 0.6 }, category: 'other', snapshotAt: '2026-10-27T10:00:00Z' },
    mesh: { kind: 'provider' },
  };
  expect(await loadScene(page, { ...charmeFlat, items: [...(charmeFlat['items'] as unknown[]), item] })).toBe(true);
  await flat(page, (f) => f.select('mystery'));
  await rendered(page);
  await expect.poll(() => page.evaluate(() => window.__flat!.modelStats().sources['mystery'])).toBe('placeholder');
  const badge = page.getByTestId('badge-mesh');
  await expect(badge).toHaveAttribute('data-source', /placeholder|offline/);
  await expect(badge).toContainText(/plain box/);
  await expect(badge).toHaveAttribute('title', /Why:/);
  const stats = await flat(page, (f) => f.modelStats());
  expect(stats.loading).not.toContain('mystery');
  expect(stats.reasons['mystery']).toBeTruthy();
  await page.screenshot({ path: '/tmp/ui-fixes/placeholder-box.png' });
});
