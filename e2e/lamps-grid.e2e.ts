import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectLighting, flat, openApp, rendered } from './helpers';

/** M5.19-M5.21: LED grids and lamp bounce. Toggling lamps must never recompile a shader or change the light structure. */

const GRID = {
  type: 'light.add',
  light: { type: 'grid', id: 'led', roomId: 'sejour', fitToRoom: true, rows: 3, cols: 4, lumensEach: 450, kelvin: 2700 },
};
const setLighting = (page: Page, partial: Record<string, unknown>) => page.evaluate((p) => window.__flat!.setLighting(p), partial);
const addGrid = (page: Page) => page.evaluate((c) => window.__flat!.applyCommand(c), GRID);

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await expectLighting(page);
  await setLighting(page, { sunEnabled: false, time: '23:00', lamps: {} });
  await rendered(page);
});

test('a grid switches on and off without recompiling shaders or changing the lights', async ({ page }) => {
  const res = await addGrid(page);
  expect(res.ok).toBe(true);
  await rendered(page);
  const on = await flat(page, (f) => f.stats());
  expect(on.lights.lampsLit).toContain('led');
  expect(on.lights.lampLights).toBeGreaterThan(0);

  await setLighting(page, { lamps: { led: { on: false } } });
  await rendered(page);
  const off = await flat(page, (f) => f.stats());
  expect(off.lights.lampsLit).not.toContain('led');
  expect(off.programs).toBe(on.programs);
  expect(off.lights.lampLights).toBe(on.lights.lampLights);
  expect(off.lights.lampShadowCasters).toBe(on.lights.lampShadowCasters);

  await setLighting(page, { lamps: { led: { on: true, lumens: 1200 } } });
  await rendered(page);
  const back = await flat(page, (f) => f.stats());
  expect(back.lights.lampsLit).toContain('led');
  expect(back.programs).toBe(on.programs);
  expect(back.lights.lampLights).toBe(on.lights.lampLights);
});

test('switching every lamp off lights nothing and keeps the program count', async ({ page }) => {
  await addGrid(page);
  await rendered(page);
  const before = await flat(page, (f) => f.stats());
  const scene = (await page.evaluate(() => window.__flat!.getScene())) as { lights: { id: string }[] };
  const all = Object.fromEntries(scene.lights.map((l) => [l.id, { on: false }]));
  await setLighting(page, { lamps: all });
  await rendered(page);
  // (mean luma is not compared: auto exposure brightens a dark scene)
  expect((await flat(page, (f) => f.stats())).lights.lampsLit).toEqual([]);
  expect((await flat(page, (f) => f.stats())).programs).toBe(before.programs);
});
