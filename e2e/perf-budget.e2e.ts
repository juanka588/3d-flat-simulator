/**
 * Performance budget and phone-GPU boot tests (SwiftShader, not timing based, so CI-friendly).
 *
 * - Budget: draw calls, triangles, shader programs and texture counts of the shipped fixture stay within a margin of what
 *   they were when measured (scripts/perf/measure.mjs). A regression that doubles them fails here.
 * - Phone boot: the page is started with a phone GPU's limits and missing extensions (scripts/perf/gl-caps.mjs: Mali without
 *   float32 linear filtering, a low-end Mali without float render targets) and must reach a first frame with the flat drawn,
 *   no shader/GL errors, and without the float-texture light probes (they read black on such a GPU).
 * - No WebGL2 at all: a visible explanation with the reason, never a blank page; `?debug=gl` lists the failure.
 */
import { expect, test } from '@playwright/test';
import { devices } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installGlCaps } from '../scripts/perf/gl-caps.mjs';
import { flat, openApp } from './helpers';

/** Measured on the Charme fixture in SwiftShader (desktop profile): ~43 calls, ~22k triangles, ~38 programs. */
const BUDGET = { calls: 65, triangles: 30_000, programs: 40, geometries: 40, textures: 50 };

test('the shipped fixture stays within the rendering budget', async ({ page }) => {
  await openApp(page);
  const s = await flat(page, (h) => h.stats());
  console.log(`[budget] calls=${s.calls} triangles=${s.triangles} programs=${s.programs} geometries=${s.geometries} textures=${s.textures}`);
  expect(s.calls).toBeLessThanOrEqual(BUDGET.calls);
  expect(s.triangles).toBeLessThanOrEqual(BUDGET.triangles);
  expect(s.programs).toBeLessThanOrEqual(BUDGET.programs);
  expect(s.geometries).toBeLessThanOrEqual(BUDGET.geometries);
  expect(s.textures).toBeLessThanOrEqual(BUDGET.textures);
  expect(s.triangles).toBeGreaterThan(5000);
});

test('the fixture, furnished with every item, does not blow the draw-call budget', async ({ page }) => {
  await openApp(page);
  const s = await flat(page, (h) => h.stats());
  // Items are drawn from a few merged meshes: the call count must not scale with the number of items.
  const items = await flat(page, (h) => h.getScene().items.length);
  expect(items).toBeGreaterThan(5);
  expect(s.calls).toBeLessThan(items * 6 + 40);
});

const pixel7: Record<string, unknown> = { ...devices['Pixel 7'] };
delete pixel7['defaultBrowserType'];

test.describe('phone GPUs', () => {
  test.use(pixel7);

  async function boot(page: Page, preset: string, query = ''): Promise<{ errors: string[] }> {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error' || /Shader Error|THREE\.WebGLProgram|GL_INVALID|INVALID_OPERATION|incomplete/i.test(t)) errors.push(`${m.type()}: ${t.slice(0, 300)}`);
    });
    await installGlCaps(page, preset);
    await page.goto(`/?test${query}`);
    await page.evaluate(() => window.__flat!.ready);
    return { errors };
  }

  for (const preset of ['pixel8', 'mali-lowend']) {
    test(`${preset}: reaches the first frame, flat drawn, no GL errors, no float-texture probes`, async ({ page }) => {
      const { errors } = await boot(page, preset);
      const s = await flat(page, (h) => h.stats());
      expect(s.triangles).toBeGreaterThan(5000);
      expect(s.meshes).toEqual(expect.arrayContaining(['walls', 'floors']));
      expect(await flat(page, (h) => h.probes().mode)).toBe('legacy');
      await expect(page.getByTestId('viewer-error')).toBeHidden();
      // The low tier: capped pixel ratio and no contact shadows.
      expect(s.dpr).toBeLessThanOrEqual(1.5);
      expect(s.meshes).not.toContain('contact-shadows');
      expect(errors.filter((e) => !/deprecated|GPU stall|ReadPixels/i.test(e))).toEqual([]);
    });
  }

  test('pixel8: even asking for the probes (?gi=on) does not use them without float filtering', async ({ page }) => {
    await boot(page, 'pixel8', '&gi=on');
    expect(await flat(page, (h) => h.probes().mode)).toBe('legacy');
  });

  for (const preset of ['webgl1', 'nogl']) {
    test(`${preset}: a visible explanation instead of a blank page; ?debug=gl lists the failure`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await installGlCaps(page, preset);
      await page.goto('/?test&debug=gl');
      await expect(page.getByTestId('viewer-nogl')).toBeVisible();
      await expect(page.getByTestId('viewer-nogl')).toContainText(/WebGL/);
      await expect(page.getByTestId('viewer-error')).toBeVisible();
      await expect(page.getByTestId('gl-debug')).toContainText('webgl: FAILED');
      expect(errors).toEqual([]);
    });
  }

  test('?debug=gl on a working phone GPU lists the capabilities and the tier', async ({ page }) => {
    await boot(page, 'pixel8', '&debug=gl');
    const panel = page.getByTestId('gl-debug');
    await expect(panel).toContainText('webgl: OK');
    await expect(panel).toContainText('Mali-G715');
    await expect(panel).toContainText('float linear: false');
    await expect(panel).toContainText('tier: low');
    await expect(panel).toContainText('shader failures: 0');
  });
});
