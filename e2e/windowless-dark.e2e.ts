import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { CameraPose } from '../packages/scene/src/index';
import { charmeFlat, expectLighting, loadScene } from './helpers';

/**
 * Natural light only enters through the windows (and bounces). A windowless room (the bathroom, the WC) with its lamps off at noon is
 * dark apart from the light that comes in through its door, in both lighting paths: the per-room one (the default on software GL) and
 * the baked probes (`?gi=on`, the default on a real GPU). Before: a uniform glow from the unoccluded sky fill, white strips along every
 * wall (probes on the far side of a wall read through a 3 cm band), hairlines of sun along the corners, and the sky seen through the
 * front door.
 *
 * Measured on the whole frame (mean luma and the share of bright pixels), looking at the east wall of the bathroom (w-sdb-east, the
 * wall towards the landing), the one the report was about, and at the WC.
 */

const lampsOff = Object.fromEntries((charmeFlat.lights as { id: string }[]).map((l) => [l.id, { on: false }]));

interface Frame {
  mean: number;
  /** Share of pixels brighter than 0.35. */
  bright: number;
}

/** Mean luma and bright-pixel share of the whole canvas. */
function frame(page: Page): Promise<Frame> {
  return page.evaluate(async () => {
    const img = new Image();
    img.src = window.__flat!.capture();
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    let sum = 0;
    let bright = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = (0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!) / 255;
      sum += l;
      if (l > 0.35) bright++;
    }
    const n = px.length / 4;
    return { mean: sum / n, bright: bright / n };
  });
}

const VIEWS: Record<'sdbEast' | 'wc' | 'sejour', CameraPose> = {
  /** In the bathroom, looking north-east at w-sdb-east and the column. */
  sdbEast: { mode: 'walk', position: [4.4, 8.0], headingDeg: 55, eyeHeight: 1.5, pitchDeg: 0, fovDeg: 100 },
  /** In the WC, looking south at w-wc-south (towards the landing). */
  wc: { mode: 'walk', position: [9.4, 4.7], headingDeg: 180, eyeHeight: 1.5, pitchDeg: 0, fovDeg: 90 },
  /** In the living room, looking north at its window wall: the control (a lit room must not be dark). */
  sejour: { mode: 'walk', position: [1.5, 6.5], headingDeg: 0, eyeHeight: 1.5, pitchDeg: 0, fovDeg: 90 },
};

async function look(page: Page, view: keyof typeof VIEWS): Promise<Frame> {
  await page.evaluate((p) => window.__flat!.setCamera(p), VIEWS[view]);
  await page.evaluate(() => window.__flat!.whenRendered());
  return frame(page);
}

for (const [path, url] of [['per-room light (legacy)', '/?ao=off'], ['baked probes', '/?ao=off&gi=on']] as const) {
  test.describe(`${path}: a windowless room is dark at noon with the lamps off`, () => {
    test.slow();

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('flat.walkLightsOn', '0'));
      await page.goto(url);
      await page.evaluate(() => window.__flat!.ready);
      expect(await loadScene(page, { ...charmeFlat, items: [] })).toBe(true);
      await expectLighting(page);
      await page.evaluate((l) => window.__flat!.setLighting(l), { date: '2026-10-26', time: '12:30', sunEnabled: true, showContext: true, lamps: lampsOff });
      await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
    });

    test('the bathroom, seen towards w-sdb-east: dark, with no strip of light along the wall (the door to the hall is the only light)', async ({ page }) => {
      const sejour = await look(page, 'sejour');
      expect(sejour.mean, 'the living room, with windows, is lit').toBeGreaterThan(0.08);
      const sdb = await look(page, 'sdbEast');
      expect(sdb.mean, `bathroom mean luma ${sdb.mean.toFixed(3)}`).toBeLessThan(0.06);
      expect(sdb.mean).toBeLessThan(sejour.mean / 3);
      // The bright part of the frame is the doorway to the hall (about 3% of it); leaks were a glow plus long thin strips along every wall.
      expect(sdb.bright, `bathroom bright share ${sdb.bright.toFixed(4)}`).toBeLessThan(0.05);
    });

    test('the bathroom with no door at all is closed: nothing in it is lit', async ({ page }) => {
      const sealed = { ...charmeFlat, items: [], openings: (charmeFlat.openings as { id: string }[]).filter((o) => o.id !== 'door-sdb') };
      expect(await loadScene(page, sealed)).toBe(true);
      const sdb = await look(page, 'sdbEast');
      expect(sdb.mean, `sealed bathroom mean luma ${sdb.mean.toFixed(3)}`).toBeLessThan(0.02);
      expect(sdb.bright, `sealed bathroom bright share ${sdb.bright.toFixed(4)}`).toBeLessThan(0.004);
    });

    test('the WC (no window, the landing behind its south wall): dark', async ({ page }) => {
      const wc = await look(page, 'wc');
      expect(wc.mean, `WC mean luma ${wc.mean.toFixed(3)}`).toBeLessThan(0.02);
      // The only light is the head of its door frame, which looks into the hall (about 1% of the frame); leaks were glows and strips along every wall.
      expect(wc.bright, `WC bright share ${wc.bright.toFixed(4)}`).toBeLessThan(0.02);
    });
  });
}
