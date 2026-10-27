/**
 * Walk-mode comfort: translucent door leaves (opaque in orbit and top) and "Lights on in walk mode"
 * (every lamp on and +0.5 EV in walk mode only, as a derived layer over the stored lighting).
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, rendered } from './helpers';

const MAX_DRAW_CALLS = 70;

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

const mode = async (page: Page, m: 'orbit' | 'top' | 'walk') => {
  await page.evaluate((x) => window.__flat!.setView({ mode: x }), m);
  await rendered(page);
};
const leaves = async (page: Page) => {
  const all = await page.evaluate(() => window.__flat!.doorLeaves());
  return [...new Map(all.map((l) => [l.id, l])).values()];
};
const stats = (page: Page) => page.evaluate(() => window.__flat!.stats());

test('door leaves are translucent in walk mode and opaque in orbit and top', async ({ page }) => {
  for (const m of ['orbit', 'top'] as const) {
    await mode(page, m);
    const l = await leaves(page);
    expect(l.map((x) => x.id), m).toEqual(['builtin:door']);
    expect(l[0]).toMatchObject({ transparent: false, opacity: 1 });
  }
  await mode(page, 'walk');
  const walk = await leaves(page);
  expect(walk.map((x) => x.id)).toEqual(['builtin:door-walk']);
  expect(walk[0]!.transparent).toBe(true);
  expect(walk[0]!.opacity).toBeLessThan(0.5);
  expect(walk[0]!.depthWrite).toBe(false);
  // Back to orbit: opaque again, and going back and forth compiles nothing new after the first round trip.
  await mode(page, 'orbit');
  const programs = (await stats(page)).programs;
  await mode(page, 'walk');
  await mode(page, 'orbit');
  expect((await leaves(page))[0]).toMatchObject({ id: 'builtin:door', transparent: false });
  expect((await stats(page)).programs).toBe(programs);
});

test('walk mode turns all lamps on (+0.5 EV); leaving restores the lamp states and EV exactly; the preference turns it off', async ({ page }) => {
  const lampIds = (await page.evaluate(() => window.__flat!.getScene())).lights.map((l) => l.id);
  expect(lampIds.length).toBeGreaterThan(2);
  await page.evaluate(
    (ids) => window.__flat!.setLighting({ exposureEV: 1, lamps: Object.fromEntries(ids.map((id) => [id, { on: id === 'l-cuisine' }])) }),
    lampIds,
  );
  await mode(page, 'orbit');
  const before = await stats(page);
  expect(before.lights.lampsLit).toEqual(['l-cuisine']);

  await mode(page, 'walk');
  const walking = await stats(page);
  expect([...walking.lights.lampsLit].sort()).toEqual([...lampIds].sort());
  // Exposure EV is 1.5 instead of 1 (auto exposure may shift a little with the extra lamps, the net effect is still brighter).
  expect(walking.exposure).toBeGreaterThan(before.exposure * 1.2);
  expect(walking.calls).toBeLessThanOrEqual(MAX_DRAW_CALLS);

  // The sidebar shows the override and the stored lighting is untouched.
  await expect(page.getByTestId('walk-lights-note')).toBeVisible();
  await expect(page.getByTestId('lamp-l-cuisine').getByRole('checkbox')).toBeDisabled();

  await mode(page, 'orbit');
  const after = await stats(page);
  expect(after.lights.lampsLit).toEqual(['l-cuisine']);
  expect(after.exposure).toBe(before.exposure);

  // Preference off: no override in walk mode.
  await page.getByTestId('walk-lights-toggle').uncheck();
  await mode(page, 'walk');
  const plain = await stats(page);
  expect(plain.lights.lampsLit).toEqual(['l-cuisine']);
  expect(plain.exposure).toBeCloseTo(before.exposure, 5);
  await expect(page.getByTestId('walk-lights-note')).toHaveCount(0);
  // ... and it is remembered.
  await page.reload();
  await page.evaluate(() => window.__flat!.ready);
  await expect(page.getByTestId('walk-lights-toggle')).not.toBeChecked();
});
