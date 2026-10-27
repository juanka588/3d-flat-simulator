import { expect, test } from '@playwright/test';
import { charmeFlat, flat, openApp, rendered, savePng, southEastOrbit } from './helpers';

// Set ITEMS_CAPTURE_DIR to also write the reference captures (walk and orbit views of the TV) there.
const CAPTURE_DIR = process.env.ITEMS_CAPTURE_DIR;

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('the TV item is drawn as a named mesh, in orbit and in walk mode', async ({ page }) => {
  const names = async () => (await flat(page, (f) => f.stats())).meshes;
  expect(await names()).toContain('items');
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await rendered(page);
  expect(await names()).toContain('items');
  // The TV casts shadows through the merged caster geometry (no extra caster mesh) and stays within the draw-call budget.
  const stats = await flat(page, (f) => f.stats());
  expect(stats.shadowCasterMeshes).not.toContain('items');
  await page.evaluate(() => window.__flat!.clearFrameCalls());
  await rendered(page);
  const calls = await page.evaluate(() => window.__flat!.frameCalls());
  expect(Math.max(...calls)).toBeLessThanOrEqual(70);
});

test('selecting tv-sejour shows its properties', async ({ page }) => {
  expect(await page.evaluate(() => window.__flat!.select('tv-sejour'))).toBe(true);
  await rendered(page);
  const properties = page.getByTestId('properties');
  await expect(properties.getByRole('heading')).toHaveText('TV 55″ – 1.23 × 0.71 m');
  await expect(properties).toContainText('sejour');
  if (CAPTURE_DIR) {
    await savePng(page, `${CAPTURE_DIR}/tv-orbit.png`);
  }
});

test('clicking the TV in orbit view selects it', async ({ page }) => {
  // Look at the TV's face (it faces plan +y, the séjour) from the south-west, in orbit.
  const tv = charmeFlat['items'] as { id: string; position: [number, number] }[];
  const item = tv.find((i) => i.id === 'tv-sejour')!;
  await southEastOrbit(page);
  const point = await page.evaluate(([x, z]) => window.__flat!.project([x!, 1.1, z! + 0.03]), item.position);
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, point);
  expect(hit).toBe('CANVAS');
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId('properties').getByRole('heading')).toHaveText('TV 55″ – 1.23 × 0.71 m');
});

test('walking: the TV is in view 3 m away and does not block the way', async ({ page }) => {
  await page.evaluate(() => window.__flat!.setClock('manual'));
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  // Séjour, 3 m south of the TV, looking north (yaw 0 looks along -z).
  await page.evaluate(() => window.__flat!.setWalkPose({ x: 2.45, z: 5.3, yawDeg: 0 }));
  await rendered(page);
  const centre = await page.evaluate(() => window.__flat!.project([2.45, 1.1, 2.3]));
  const viewport = page.viewportSize()!;
  expect(centre.x).toBeGreaterThan(viewport.width * 0.3);
  expect(centre.x).toBeLessThan(viewport.width * 0.7);
  expect(centre.y).toBeGreaterThan(0);
  expect(centre.y).toBeLessThan(viewport.height);
  if (CAPTURE_DIR) await savePng(page, `${CAPTURE_DIR}/tv-walk.png`);
});
