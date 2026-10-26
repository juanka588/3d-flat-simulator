import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { charmeFlat, expectLighting, openApp } from './helpers';

/**
 * Regression: the interior face of the south wall (it faces north, away from the noon sun) showed a
 * sharp diagonal dark wedge above a much brighter area. The cause was not sun light leaking through
 * the wall: the per-room ambient (`aoMap`) was assigned per triangle, and one wall quad spans two
 * rooms (séjour and the windowless bathroom), so its two triangles got different rooms' ambient.
 *
 * With every lamp off, that face receives only the hemisphere ambient, so its brightness must be
 * (nearly) the same everywhere on the stretch that belongs to the séjour. A sun leak or a stray
 * ambient texel would show up as a large spread between probe points. The probes are compared with
 * each other (not with an absolute value) so the test does not depend on exposure or tone mapping.
 */

const lampsOff = Object.fromEntries((charmeFlat.lights as { id: string }[]).map((l) => [l.id, { on: false }]));

/** Interior (north-facing) face of w-south in the séjour: z = 8.38 - 0.1 minus a hair; x in 0..3.7 is the séjour. */
const WALL_Z = 8.27;
const PROBE_X = [0.8, 1.6, 2.4, 3.2];
const PROBE_Y = [0.5, 1.2, 1.9, 2.3];
/** Allowed spread (max / min of the mean luma) between probes on the lee face. */
const MAX_SPREAD = 1.06;

/** Mean luma (0-1) of a small window around each world point, from ONE capture. */
function probeLumas(page: Page, points: [number, number, number][]): Promise<number[]> {
  return page.evaluate(async (list) => {
    const hook = window.__flat!;
    const img = new Image();
    img.src = hook.capture();
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const rect = document.querySelector('canvas')!.getBoundingClientRect();
    const scale = img.width / rect.width;
    return list.map((p) => {
      const at = hook.project(p);
      const half = Math.round(4 * scale);
      const x0 = Math.round((at.x - rect.left) * scale) - half;
      const y0 = Math.round((at.y - rect.top) * scale) - half;
      if (x0 < 0 || y0 < 0 || x0 + 2 * half >= img.width || y0 + 2 * half >= img.height) return NaN; // probe is off-screen
      const px = ctx.getImageData(x0, y0, 2 * half + 1, 2 * half + 1).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += (0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!) / 255;
      return sum / (px.length / 4);
    });
  }, points);
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await expectLighting(page);
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
});

const cases: [string, string, string][] = [
  ['26 Oct 12:30 (sun due south, 28.7 deg)', '2026-10-26', '12:30'],
  ['21 Dec 12:00 (low sun)', '2026-12-21', '12:00'],
  ['21 Jun 12:00 (high sun)', '2026-06-21', '12:00'],
];

for (const showContext of [true, false]) {
  for (const [name, date, time] of cases) {
    test(`the north-facing interior of w-south is uniformly lit: ${name}, context ${showContext ? 'on' : 'off'}`, async ({ page }) => {
      await page.evaluate((l) => window.__flat!.setLighting(l), { date, time, sunEnabled: true, showContext, lamps: lampsOff });
      // Looking south (+z on the plan) from inside the séjour; yaw 180 faces +z.
      await page.evaluate(() => window.__flat!.setWalkPose({ x: 2.0, z: 5.4, yawDeg: 180 }));
      await page.evaluate(() => window.__flat!.whenRendered());

      const points = PROBE_X.flatMap((x) => PROBE_Y.map((y): [number, number, number] => [x, y, WALL_Z]));
      const lumas = await probeLumas(page, points);
      expect(lumas.every((l) => Number.isFinite(l)), 'all probes must be on screen').toBe(true);
      const lo = Math.min(...lumas);
      const hi = Math.max(...lumas);
      expect(lo).toBeGreaterThan(0.1); // not in the dark either
      expect(hi / lo, `luma spread ${lumas.map((l) => l.toFixed(3)).join(' ')}`).toBeLessThan(MAX_SPREAD);
    });
  }
}
