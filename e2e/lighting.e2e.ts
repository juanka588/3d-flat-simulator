import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { charmeFlat, flat, lightingAvailable, meanLuma, openApp, rendered } from './helpers';

const MAX_DRAW_CALLS = 70;
const SUMMER_NOON = { date: '2026-06-21', time: '12:00' };

/** Lamp ids with the plan positions of their ceiling points (floor point is the same x/z at y = 0). */
const lampPosition = (id: string): [number, number, number] => {
  const light = (charmeFlat.lights as { id: string; position: [number, number] }[]).find((l) => l.id === id)!;
  return [light.position[0], 0, light.position[1]];
};
const allLampIds = (charmeFlat.lights as { id: string }[]).map((l) => l.id);

test.beforeEach(async ({ page }) => {
  await openApp(page);
  const lighting = await lightingAvailable(page);
  test.skip(!lighting.ok, lighting.ok ? '' : lighting.reason);
});

const preset = async (page: Page, name: 'Day' | 'Evening' | 'Night') => {
  await page.getByRole('group', { name: 'Lighting presets' }).getByRole('button', { name, exact: true }).click();
  await rendered(page);
};

const onlyLamps = (ids: string[]) =>
  Object.fromEntries(allLampIds.map((id) => [id, { on: ids.includes(id) }]));

test('noon is much brighter than midnight', async ({ page }) => {
  await page.evaluate((v) => window.__flat!.setLighting({ ...v, sunEnabled: true, lamps: {} }), SUMMER_NOON);
  const noon = await meanLuma(page);
  await page.evaluate(() => window.__flat!.setLighting({ time: '00:00' }));
  const midnight = await meanLuma(page);
  expect(noon).toBeGreaterThan(0.15);
  expect(midnight).toBeLessThan(noon * 0.5);
});

test('the Night preset turns the sun off and every lamp on', async ({ page }) => {
  await preset(page, 'Night');
  const stats = await flat(page, (f) => f.stats());
  expect(stats.lights.sunIntensity).toBe(0);
  expect([...stats.lights.lampsLit].sort()).toEqual([...allLampIds].sort());
  await expect(page.getByLabel('Sun and sky')).not.toBeChecked();

  await preset(page, 'Day');
  const day = await flat(page, (f) => f.stats());
  expect(day.lights.sunIntensity).toBeGreaterThan(0);
  expect(day.lights.lampsLit).toEqual([]);
});

test('sun and shadows: one shadow-casting sun, glass does not cast', async ({ page }) => {
  await page.evaluate((v) => window.__flat!.setLighting({ ...v, sunEnabled: true, lamps: {} }), SUMMER_NOON);
  const stats = await flat(page, (f) => f.stats());
  expect(stats.lights.directional).toBe(1);
  expect(stats.lights.sunIntensity).toBeGreaterThan(10_000);
  expect(stats.lights.shadowCasterNames).toContain('sun');
  expect(stats.shadowCasterMeshes).toContain('shadow-casters');
  expect(stats.shadowCasterMeshes).not.toContain('glass');
  expect(stats.toneMapping).toBe('neutral');
});

test('toggling a lamp off darkens the floor under it', async ({ page }) => {
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  await preset(page, 'Night');
  const floor = lampPosition('l-ch1');
  const lit = await meanLuma(page, { point: floor });
  await page.getByLabel('Chambre 1 ceiling on', { exact: true }).uncheck();
  await rendered(page);
  const dark = await meanLuma(page, { point: floor });
  expect(lit).toBeGreaterThan(0.1);
  expect(dark).toBeLessThan(lit * 0.5);
});

test('light does not leak through walls: only the Chambre 1 lamp on lights Chambre 1, not Chambre 2', async ({ page }) => {
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  await page.evaluate((lamps) => window.__flat!.setLighting({ sunEnabled: false, lamps }), onlyLamps(['l-ch1']));
  const ch1 = await meanLuma(page, { point: lampPosition('l-ch1') });
  const ch2 = await meanLuma(page, { point: lampPosition('l-ch2') });
  expect(ch1).toBeGreaterThan(0.1);
  expect(ch1).toBeGreaterThan(ch2 * 3);
});

test('the time slider moves the sun', async ({ page }) => {
  await page.evaluate((v) => window.__flat!.setLighting(v), SUMMER_NOON);
  const altitude = () => page.evaluate(() => {
    const info = window.__flat!.sunInfo();
    return info.available ? info.altitudeDeg : NaN;
  });
  const noon = await altitude();
  const slider = page.getByRole('slider', { name: 'Time of day' });
  await slider.fill(String(9 * 60));
  await rendered(page);
  const morning = await altitude();
  expect(noon - morning).toBeGreaterThan(10);
  await expect(page.getByTestId('time-output')).toHaveText('09:00');
  await expect(page.getByTestId('sun-altitude')).toContainText('°');
});

test('the day animation advances with a manual clock and stops when paused', async ({ page }) => {
  await page.evaluate((v) => window.__flat!.setLighting({ ...v, time: '08:00' }), SUMMER_NOON);
  await page.evaluate(() => window.__flat!.setClock('manual'));
  await page.getByRole('button', { name: 'Play' }).click();
  await page.getByRole('button', { name: '1 h/s' }).click();
  await page.evaluate(() => window.__flat!.tick(1000));
  await expect(page.getByTestId('time-output')).toHaveText('09:00');
  await page.evaluate(() => window.__flat!.tick(500));
  await expect(page.getByTestId('time-output')).toHaveText('09:30');
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.evaluate(() => window.__flat!.tick(10_000));
  await expect(page.getByTestId('time-output')).toHaveText('09:30');
});

test('the site panel rejects an impossible latitude', async ({ page }) => {
  const latitude = page.getByTestId('site-latitude');
  const before = await page.evaluate(() => window.__flat!.sunInfo());
  await latitude.fill('95');
  await expect(page.getByTestId('site-panel').getByRole('alert')).toBeVisible();
  await expect(latitude).toHaveAttribute('aria-invalid', 'true');
  expect(await page.evaluate(() => window.__flat!.sunInfo())).toEqual(before);

  await latitude.fill('60');
  await expect(page.getByTestId('site-panel').getByRole('alert')).toHaveCount(0);
  await rendered(page);
  const after = await page.evaluate(() => window.__flat!.sunInfo());
  expect(after.available && before.available && after.altitudeDeg !== before.altitudeDeg).toBe(true);
});

test.describe('performance budget (Charme, sun + sky + lamps)', () => {
  for (const name of ['Day', 'Evening', 'Night'] as const) {
    test(`${name}: at most ${MAX_DRAW_CALLS} draw calls`, async ({ page }) => {
      await preset(page, name);
      const stats = await flat(page, (f) => f.stats());
      expect(stats.calls).toBeGreaterThan(0);
      expect(stats.calls).toBeLessThanOrEqual(MAX_DRAW_CALLS);
      expect(stats.lights.shadowCasters).toBeLessThanOrEqual(5); // the sun plus at most 4 lamps
    });
  }

  test('summer noon with every lamp on', async ({ page }) => {
    await page.evaluate(([v, lamps]) => window.__flat!.setLighting({ ...v, sunEnabled: true, lamps }), [SUMMER_NOON, onlyLamps(allLampIds)] as const);
    const stats = await flat(page, (f) => f.stats());
    expect(stats.calls).toBeLessThanOrEqual(MAX_DRAW_CALLS);
  });
});

test('captures of the orbit view at noon, in the evening and at night', async ({ page }) => {
  test.setTimeout(90_000);
  const save = async (file: string) => {
    const url = await flat(page, (f) => f.capture());
    writeFileSync(file, Buffer.from(url.split(',')[1]!, 'base64'));
  };
  await page.evaluate((v) => window.__flat!.setLighting({ ...v, sunEnabled: true, lamps: {} }), SUMMER_NOON);
  await save('/tmp/m2-noon.png');
  await preset(page, 'Evening');
  await save('/tmp/m2-evening.png');
  await preset(page, 'Night');
  await save('/tmp/m2-night.png');
});
