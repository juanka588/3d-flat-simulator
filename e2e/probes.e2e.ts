import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { charmeFlat, expectLighting, flat, floorPoint, meanLuma, meanLumas, rendered } from './helpers';

/**
 * The baked light probes (viewer/ProbeGI.tsx): the indirect light of the flat. These tests guard the main risk of a probe grid,
 * light leaking through thin walls, and the contract with the test hook (`whenRendered` waits for the bake).
 *
 * The suite runs on a software renderer, where the viewer keeps the cheap per-room path by default (a bake there costs seconds and
 * the probe lookup slows every frame): `?gi=on` forces the probes. The first bake compiles the bake's shader variants (about 10 s),
 * hence `test.slow()`.
 */
test.slow();

async function openProbes(page: Page): Promise<void> {
  await page.goto('/?gi=on');
  await page.evaluate(() => window.__flat!.ready);
  await expect(page.locator('canvas')).toBeVisible();
}

const lights = charmeFlat.lights as { id: string }[];
const onlyLamps = (ids: string[]) => Object.fromEntries(lights.map((l) => [l.id, { on: ids.includes(l.id) }]));
const setLighting = (page: Page, partial: Record<string, unknown>) => page.evaluate((p) => window.__flat!.setLighting(p), partial);
const walk = async (page: Page, x: number, z: number, yawDeg: number) => {
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await page.evaluate((p) => window.__flat!.setWalkPose(p), { x, z, yawDeg });
  await rendered(page);
};
const lumas = (page: Page, points: [number, number, number][]) => meanLumas(page, points.map((point) => ({ point, half: 3 })));

/** The 7 cm partition `w-ch2-ch1` stands at x = 6.875: Chambre 2's wall face is at x 6.84, Chambre 1's at x 6.91. */
const CH2_FACE = 6.84;
const CH1_FACE = 6.91;

test.describe('probes: the default indirect light', () => {
  test.beforeEach(async ({ page }) => {
    // Walk mode switches every lamp on by default (a comfort feature); these tests light single rooms.
    await page.addInitScript(() => localStorage.setItem('flat.walkLightsOn', '0'));
    await openProbes(page);
    await expectLighting(page);
  });

  test('a rendered frame always shows a finished bake', async ({ page }) => {
    const idle = await flat(page, (f) => f.probes());
    expect(idle.mode).toBe('probes');
    expect(idle.pending).toBe(false);
    expect(idle.bakes).toBeGreaterThan(0);
    expect(idle.displayedKey).toBe(idle.wantedKey);
    expect(idle.res![1]).toBe(3);
    // A lighting change makes the bake stale; whenRendered resolves only once the new grid is shown.
    await setLighting(page, { sunEnabled: false, lamps: onlyLamps(['l-ch1']) });
    const after = await flat(page, (f) => f.probes());
    expect(after.pending).toBe(false);
    expect(after.displayedKey).toBe(after.wantedKey);
    expect(after.displayedKey).not.toBe(idle.displayedKey);
    expect(after.bakes).toBeGreaterThan(idle.bakes);
  });

  test('the bake is deterministic: the same scene and lighting give a byte-identical grid', async ({ page }) => {
    await setLighting(page, { sunEnabled: false, lamps: onlyLamps(['l-ch1', 'l-sejour']) });
    const first = await flat(page, (f) => f.probeHash());
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    await flat(page, (f) => f.rebakeProbes());
    expect(await flat(page, (f) => f.probeHash())).toBe(first);
    // ...and it is not a constant: another lighting state gives another grid.
    await setLighting(page, { lamps: onlyLamps(['l-ch2']) });
    expect(await flat(page, (f) => f.probeHash())).not.toBe(first);
  });

  test('a lit Chambre 1 does not glow through the 7 cm partition into the dark Chambre 2', async ({ page }) => {
    await setLighting(page, { sunEnabled: false, lamps: onlyLamps(['l-ch1']) });
    // From Chambre 2, looking at the partition: its wall face, the floor and the ceiling right beside it.
    await walk(page, 5.1, 2.0, -90);
    const dark = await lumas(page, [
      [CH2_FACE, 1.3, 1.1],
      [CH2_FACE, 1.3, 2.9],
      [CH2_FACE, 2.2, 2.0],
      [CH2_FACE - 0.05, 0, 2.0],
    ]);
    // From Chambre 1, looking at the other face of the same partition: lit.
    await walk(page, 9.2, 2.0, 90);
    const lit = await lumas(page, [
      [CH1_FACE, 1.3, 1.1],
      [CH1_FACE, 1.3, 2.9],
    ]);
    expect(Math.min(...lit), `lit face of the partition ${lit}`).toBeGreaterThan(0.2);
    // (The lit face reads 0.6-0.75; the dark side is near-black, the ceiling line up to 5 % of it from the soft probe interpolation.)
    for (const [i, value] of dark.entries()) expect(value, `Chambre 2 point ${i}: ${value} (lit side ${lit})`).toBeLessThan(0.05);
    // The mirror image: only Chambre 2 on, Chambre 1 dark.
    await setLighting(page, { lamps: onlyLamps(['l-ch2']) });
    await walk(page, 9.2, 2.0, 90);
    const dark1 = await lumas(page, [
      [CH1_FACE, 1.3, 1.1],
      [CH1_FACE, 1.3, 2.9],
      [CH1_FACE + 0.05, 0, 2.0],
    ]);
    for (const [i, value] of dark1.entries()) expect(value, `Chambre 1 point ${i}: ${value}`).toBeLessThan(0.05);
  });

  test('daylight: the windowless bathroom and WC stay dark, the Séjour is lit through its windows', async ({ page }) => {
    await setLighting(page, { date: '2026-06-21', time: '12:00', sunEnabled: true, lamps: onlyLamps([]) });
    await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
    await rendered(page);
    const [sejour, sdbFloor, sdbFar, wc, sdbWall] = await lumas(page, [
      floorPoint(1.0, 5.2), // Séjour, beside the balcony doors
      floorPoint(5.2, 7.2), // bare floor of the bathroom, away from its door
      floorPoint(6.0, 6.8),
      // WC bare floor: (9.0, 4.75) is under the hand basin since 2b00eb8 (white ceramic, not the floor); the door is z 4.6-5.3 on x 8.735.
      floorPoint(9.2, 5.6),
      floorPoint(4.7, 6.9), // floor beside the Séjour/bathroom partition
    ]);
    expect(sejour!).toBeGreaterThan(0.1); // 0.15 while the sky fill lit every room; the probes alone carry the window light now
    for (const [name, value] of Object.entries({ sdbFloor, sdbFar, wc, sdbWall })) expect(value, `${name}: ${value} (Séjour ${sejour})`).toBeLessThan(0.06);
  });

  test('lamp toggles keep the shader programs and the texture-unit budget', async ({ page }) => {
    const before = await flat(page, (f) => f.stats());
    await setLighting(page, { sunEnabled: false, lamps: onlyLamps(['l-ch1']) });
    await setLighting(page, { lamps: onlyLamps(['l-ch1', 'l-ch2', 'l-sejour']) });
    const after = await flat(page, (f) => f.stats());
    await setLighting(page, { lamps: onlyLamps([]) });
    const off = await flat(page, (f) => f.stats());
    // (the first bake compiles the bake variants: only compare states after a bake)
    expect(off.programs).toBe(after.programs);
    expect(before.maxTextures).toBeGreaterThanOrEqual(16);
  });
});

test('a software renderer keeps the per-room bounce and the sky ambient by default; ?gi=off does too', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.__flat!.ready);
  expect((await flat(page, (f) => f.probes())).mode).toBe('legacy');
  await page.goto('/?gi=off');
  await page.evaluate(() => window.__flat!.ready);
  const stats = await flat(page, (f) => f.probes());
  expect(stats.mode).toBe('legacy');
  expect(stats.bakes).toBe(0);
  const lighting = (await flat(page, (f) => f.stats())).lights;
  expect(lighting.hemisphereIntensity).toBeGreaterThan(0);
});

test('no shader fails to compile with the probe grid', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (/Shader Error|WebGLProgram|GL_INVALID|too many|INVALID_OPERATION/i.test(m.text())) errors.push(m.text().slice(0, 300));
  });
  await openProbes(page);
  await setLighting(page, { sunEnabled: false, lamps: onlyLamps(['l-ch1', 'l-sejour', 'l-cuisine']) });
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await rendered(page);
  expect(errors).toEqual([]);
});

test.describe('probes: the sun rising (the exposure must not run ahead of the displayed grid)', () => {
  test('sweeping 06:00-08:00 keeps the picture in a sane band, also in the frames before the new bake is shown', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('flat.walkLightsOn', '0'));
    await openProbes(page);
    await expectLighting(page);
    await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
    await setLighting(page, { date: '2026-06-21', time: '12:00', sunEnabled: true, lamps: onlyLamps([]) });
    const noon = await meanLuma(page);
    const settledLumas: number[] = [];
    for (const time of ['05:50', '07:00', '08:00', '06:00']) {
      // Change the time but do NOT wait for the bake: after two animation frames the page shows the new light with the previous grid.
      await page.evaluate((t) => void window.__flat!.setLighting({ time: t }), time);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const stale = await flat(page, (f) => f.probes());
      const unsettled = await meanLuma(page);
      await rendered(page);
      const settled = await meanLuma(page);
      settledLumas.push(settled);
      const info = `${time}: stale frame ${unsettled.toFixed(3)} (pending ${stale.pending}), settled ${settled.toFixed(3)}, noon ${noon.toFixed(3)}`;
      expect(settled, info).toBeGreaterThan(0.05);
      expect(settled, info).toBeLessThan(0.75);
      // No flash: a frame drawn with the previous grid is never much brighter than the day it came from or the day it goes to.
      expect(unsettled, info).toBeLessThan(Math.max(noon, settled) * 1.5 + 0.05);
    }
    // The settled morning is smooth: no step between two neighbouring times jumps by more than a factor 2.5 (06:00 is the sunrise).
    for (let i = 1; i < settledLumas.length; i++) expect(settledLumas[i]! / settledLumas[i - 1]!, `step ${i}: ${settledLumas}`).toBeLessThan(2.5);
  });
});
