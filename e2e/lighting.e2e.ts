import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { findWallShadowProbes } from './shadow-rays';
import type { RayFlat } from './shadow-rays';
import { charmeFlat, expectLighting, flat, floorPoint, inPolygon, meanLuma, openApp, rendered, savePng } from './helpers';

/** Budget for a steady frame (nothing changed since the previous one: no shadow-map passes). */
const MAX_DRAW_CALLS = 70;
/** Frames right after a change also re-render shadow maps; they are allowed up to twice the budget. */
const MAX_CHANGE_FRAME_CALLS = 2 * MAX_DRAW_CALLS;
const SUMMER_NOON = { date: '2026-06-21', time: '12:00' };
const SUMMER_18 = { date: '2026-06-21', time: '18:00' };
const WINTER_9 = { date: '2026-12-21', time: '09:00' };

interface LightJson {
  id: string;
  position: [number, number];
}
interface RoomJson {
  id: string;
  polygon: [number, number][];
}
const lights = charmeFlat.lights as LightJson[];
const rooms = charmeFlat.rooms as RoomJson[];
const allLampIds = lights.map((l) => l.id);
const roomPolygon = (id: string) => rooms.find((r) => r.id === id)!.polygon;

/** A floor point a little beside a lamp (so the probe does not read the lamp's fixture). */
const lampFloor = (id: string): [number, number, number] => {
  const light = lights.find((l) => l.id === id)!;
  return floorPoint(light.position[0] + 0.5, light.position[1] + 0.4);
};
const LUMA_HALF = 3;
/** Distance (metres) of the shadow probes from the wall's lee face: well inside the light leak the old, range-scaled bias allowed (about 0.2 m). */
const PROBE_GAP_M = 0.05;
const luma = (page: Page, point: [number, number, number], half = LUMA_HALF) => meanLuma(page, { point, half });

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await expectLighting(page); // the lighting maths must work: these tests never skip
});

const preset = async (page: Page, name: 'Day' | 'Evening' | 'Night') => {
  await page.getByRole('group', { name: 'Lighting presets' }).getByRole('button', { name, exact: true }).click();
  await rendered(page);
};

const onlyLamps = (ids: string[]) => Object.fromEntries(allLampIds.map((id) => [id, { on: ids.includes(id) }]));
const noLamps = onlyLamps([]);
const top = (page: Page) => page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
const setLighting = (page: Page, partial: Record<string, unknown>) => page.evaluate((p) => window.__flat!.setLighting(p), partial);

test('noon is much brighter than midnight', async ({ page }) => {
  await setLighting(page, { ...SUMMER_NOON, sunEnabled: true, lamps: {} });
  const noon = await meanLuma(page);
  await setLighting(page, { time: '00:00' });
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
  await setLighting(page, { ...SUMMER_NOON, sunEnabled: true, lamps: {} });
  const stats = await flat(page, (f) => f.stats());
  expect(stats.lights.directional).toBe(1);
  expect(stats.lights.sunIntensity).toBeGreaterThan(10_000);
  expect(stats.lights.shadowCasterNames).toContain('sun');
  expect(stats.shadowCasterMeshes).toContain('shadow-casters');
  expect(stats.shadowCasterMeshes).not.toContain('glass');
  expect(stats.toneMapping).toBe('neutral');
});

test('toggling a lamp off darkens the floor under it', async ({ page }) => {
  await top(page);
  await preset(page, 'Night');
  const floor = lampFloor('l-ch1');
  const lit = await luma(page, floor);
  await page.getByLabel('Chambre 1 ceiling on', { exact: true }).uncheck();
  await rendered(page);
  const dark = await luma(page, floor);
  expect(lit).toBeGreaterThan(0.1);
  expect(dark).toBeLessThan(lit * 0.5);
});

test('light does not leak through walls: only the Chambre 1 lamp on lights Chambre 1, not Chambre 2', async ({ page }) => {
  await top(page);
  await setLighting(page, { sunEnabled: false, lamps: onlyLamps(['l-ch1']) });
  const ch1 = await luma(page, lampFloor('l-ch1'));
  const ch2 = await luma(page, lampFloor('l-ch2'));
  expect(ch1).toBeGreaterThan(0.1);
  expect(ch1).toBeGreaterThan(ch2 * 3);
});

test('the area panel (Séjour kitchen) does not light through walls either', async ({ page }) => {
  await top(page);
  await setLighting(page, { sunEnabled: false, lamps: onlyLamps(['l-cuisine']) });
  const panel = lights.find((l) => l.id === 'l-cuisine')!;
  const under = await luma(page, floorPoint(panel.position[0] + 0.3, panel.position[1] + 0.9));
  const sdb = await luma(page, floorPoint(5.8, 7.9)); // behind the Séjour/SDB wall
  const entree = await luma(page, floorPoint(6.0, 5.2));
  expect(under).toBeGreaterThan(0.1);
  expect(under).toBeGreaterThan(sdb * 3);
  expect(under).toBeGreaterThan(entree * 3);
});

test('toggling one lamp does not change the lighting of another room or recompile shaders', async ({ page }) => {
  await top(page);
  await preset(page, 'Night');
  const ch2Floor = lampFloor('l-ch2');
  const ch1Floor = lampFloor('l-ch1');
  const before = { ch2: await luma(page, ch2Floor, 30), ch1: await luma(page, ch1Floor, 30), programs: (await flat(page, (f) => f.stats())).programs };
  await page.getByLabel('Chambre 1 ceiling on', { exact: true }).uncheck();
  await rendered(page);
  const after = { ch2: await luma(page, ch2Floor, 30), ch1: await luma(page, ch1Floor, 30), programs: (await flat(page, (f) => f.stats())).programs };
  // The exposure follows the total lamp flux (one lamp fewer = a few % brighter), nothing else may move.
  expect(Math.abs(after.ch2 - before.ch2)).toBeLessThan(0.02);
  expect(before.ch1).toBeGreaterThan(0.1);
  expect(after.ch1).toBeLessThan(before.ch1 * 0.2);
  expect(after.programs).toBe(before.programs); // the shadow-light count is constant: no recompiles
});

test('the time slider moves the sun', async ({ page }) => {
  await setLighting(page, SUMMER_NOON);
  const altitude = () =>
    page.evaluate(() => {
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
  await setLighting(page, { ...SUMMER_NOON, time: '08:00' });
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

test('after the Evening preset (20:00, past sunset) Play starts at the start of the range', async ({ page }) => {
  await preset(page, 'Evening');
  await expect(page.getByTestId('time-output')).toHaveText('20:00');
  const info = await page.evaluate(() => window.__flat!.sunInfo());
  if (!info.available) throw new Error('lighting unavailable');
  await page.evaluate(() => window.__flat!.setClock('manual'));
  await page.getByRole('button', { name: 'Play' }).click();
  await page.evaluate(() => window.__flat!.tick(16));
  await expect(page.getByTestId('time-output')).toHaveText(info.rangeStart);
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

test('the IGN attribution shows with the site context and the context is hidden when the site moves away', async ({ page }) => {
  const attribution = page.getByTestId('context-attribution');
  const stale = page.getByTestId('context-stale');
  await expect(attribution).toHaveText('© IGN – BD TOPO, Licence Ouverte 2.0');
  await expect(stale).toHaveCount(0);

  // Hiding the context hides the credit.
  await page.getByTestId('context-toggle').uncheck();
  await expect(attribution).toHaveCount(0);
  await page.getByTestId('context-toggle').check();
  await expect(attribution).toBeVisible();

  const latitude = page.getByTestId('site-latitude');
  const original = await latitude.inputValue();
  await latitude.fill(String(Number(original) + 0.01)); // ~1.1 km away from where the context was generated
  await expect(stale).toContainText('re-run tools/site-context');
  await expect(attribution).toHaveCount(0);
  await rendered(page);
  expect((await flat(page, (f) => f.stats())).meshes).not.toContain('context-buildings');

  await latitude.fill(original);
  await expect(stale).toHaveCount(0);
  await expect(attribution).toBeVisible();
});

test.describe('shadows are tight (no light under walls)', () => {
  const flatJson = charmeFlat as unknown as RayFlat;
  const sunDirection = async (page: Page): Promise<[number, number, number]> => {
    const info = await page.evaluate(() => window.__flat!.sunInfo());
    if (!info.available) throw new Error('lighting unavailable');
    return info.direction;
  };

  for (const time of ['19:30', '20:00']) {
    test(`low sun (21 Jun ${time}): the floor just behind a thin partition is dark, the floor in front of it is sunlit`, async ({ page }) => {
      await top(page);
      await setLighting(page, { date: SUMMER_18.date, time, sunEnabled: true, lamps: noLamps });
      const probes = findWallShadowProbes(flatJson, await sunDirection(page), true, PROBE_GAP_M);
      expect(probes.length, 'a floor point behind a partition, whose only occluder is that partition').toBeGreaterThan(0);
      // A few probes on distinct walls.
      const chosen = [...new Map(probes.map((p) => [p.wallId, p])).values()].slice(0, 3);
      let compared = 0;
      for (const probe of chosen) {
        const lit = await luma(page, floorPoint(...probe.lit!));
        const behind = await luma(page, floorPoint(...probe.behind));
        // The probe must be sunlit in the render (the neighbouring buildings can shade it): then the wall's shadow must hold.
        if (lit < 0.5) continue;
        compared++;
        expect(behind, `behind ${probe.wallId} at ${probe.behind}: ${behind} vs sunlit side ${lit}`).toBeLessThan(lit * 0.87);
      }
      expect(compared, 'at least one sunlit/behind pair was measured').toBeGreaterThan(0);
    });
  }

  test('low sun (21 Jun 18:00): the floor just inside a sun-facing exterior wall is dark compared with a sun patch', async ({ page }) => {
    await top(page);
    await setLighting(page, { ...SUMMER_18, sunEnabled: true, lamps: noLamps });
    const probes = findWallShadowProbes(flatJson, await sunDirection(page), false, PROBE_GAP_M);
    expect(probes.length).toBeGreaterThan(0);
    const patches = await flat(page, (f) => f.sunPatches());
    expect(patches.length).toBeGreaterThan(0);
    const lit = await luma(page, [...patches].sort((a, b) => b.area - a.area)[0]!.centroid);
    expect(lit).toBeGreaterThan(0.5);
    for (const probe of [...new Map(probes.map((p) => [p.wallId, p])).values()].slice(0, 3)) {
      const behind = await luma(page, floorPoint(...probe.behind));
      expect(behind, `behind ${probe.wallId} at ${probe.behind}: ${behind} vs patch ${lit}`).toBeLessThan(lit * 0.6);
    }
  });

  test('grazing winter sun (21 Dec 09:00): floors beside the sun-facing walls are as dark as the middle of the room', async ({ page }) => {
    await top(page);
    await setLighting(page, { ...WINTER_9, sunEnabled: true, lamps: noLamps });
    expect(await flat(page, (f) => f.sunPatches())).toEqual([]); // the sun comes from the south-east: no window gets it
    // [room, floor point 12 cm inside a wall facing the sun, floor point in the middle of the room]
    const pairs: [string, [number, number], [number, number]][] = [
      ['ch1', [9.93, 3.2], [8.0, 3.4]],
      ['sejour', [2.5, 8.16], [2.5, 5.2]],
    ];
    for (const [room, beside, middle] of pairs) {
      expect(inPolygon(beside, roomPolygon(room)) && inPolygon(middle, roomPolygon(room)), room).toBe(true);
      const edge = await luma(page, floorPoint(...beside));
      const centre = await luma(page, floorPoint(...middle));
      expect(centre, room).toBeGreaterThan(0.05);
      expect(edge, `${room}: floor beside the wall ${edge} vs middle ${centre}`).toBeLessThan(centre * 1.12);
    }
  });
});

test('a sun patch on the Séjour floor is brighter than the floor beside it (21 Jun 18:00, top view)', async ({ page }) => {
  await top(page);
  await setLighting(page, { ...SUMMER_18, sunEnabled: true, lamps: noLamps });
  const patches = await flat(page, (f) => f.sunPatches());
  const sejour = patches.filter((p) => p.roomId === 'sejour').sort((a, b) => b.area - a.area);
  expect(sejour.length).toBeGreaterThan(0);
  const outside: [number, number] = [3.5, 5.3];
  expect(inPolygon(outside, roomPolygon('sejour'))).toBe(true);
  expect(patches.some((p) => inPolygon(outside, p.polygon))).toBe(false);
  const inside = await luma(page, sejour[0]!.centroid);
  const beside = await luma(page, floorPoint(...outside));
  expect(inside).toBeGreaterThan(beside * 1.2);
});

test('windowless rooms get less sky ambient: at noon the WC and SDB floors are darker than the Séjour floor', async ({ page }) => {
  await top(page);
  await setLighting(page, { ...SUMMER_NOON, sunEnabled: true, lamps: noLamps });
  const sejourPoint: [number, number] = [2.5, 5.2];
  const wcPoint: [number, number] = [9.0, 4.75];
  const sdbPoint: [number, number] = [5.8, 7.9];
  expect(inPolygon(sejourPoint, roomPolygon('sejour'))).toBe(true);
  expect(inPolygon(wcPoint, roomPolygon('wc'))).toBe(true);
  expect(inPolygon(sdbPoint, roomPolygon('sdb'))).toBe(true);
  const patches = await flat(page, (f) => f.sunPatches());
  expect(patches.some((p) => inPolygon(sejourPoint, p.polygon))).toBe(false); // sky only
  const sejour = await luma(page, floorPoint(...sejourPoint));
  const wc = await luma(page, floorPoint(...wcPoint));
  const sdb = await luma(page, floorPoint(...sdbPoint));
  expect(sejour).toBeGreaterThan(0.3);
  expect(wc).toBeLessThan(sejour * 0.6);
  expect(sdb).toBeLessThan(sejour * 0.6);

  // Only the sky is dimmed: at night the lamp lights the windowless WC just as it lights a bedroom.
  await preset(page, 'Night');
  const wcNight = await luma(page, floorPoint(...wcPoint));
  const ch1Night = await luma(page, lampFloor('l-ch1'));
  expect(wcNight).toBeGreaterThan(0.1);
  expect(ch1Night).toBeGreaterThan(0.1);
});

test.describe('performance budget (Charme, sun + sky + lamps)', () => {
  for (const name of ['Day', 'Evening', 'Night'] as const) {
    test(`${name}: at most ${MAX_DRAW_CALLS} draw calls in a steady frame`, async ({ page }) => {
      await page.evaluate(() => window.__flat!.clearFrameCalls());
      await preset(page, name);
      const changeFrames = await page.evaluate(() => window.__flat!.frameCalls());
      await rendered(page); // a steady frame: nothing changed since the last one
      const stats = await flat(page, (f) => f.stats());
      expect(stats.calls).toBeGreaterThan(0);
      expect(stats.calls).toBeLessThanOrEqual(MAX_DRAW_CALLS);
      expect(Math.max(...changeFrames)).toBeLessThanOrEqual(MAX_CHANGE_FRAME_CALLS);
      expect(stats.lights.shadowCasters).toBeLessThanOrEqual(1 + allLampIds.length); // the sun plus one per lamp, whatever their state
    });
  }

  test('summer noon with every lamp on', async ({ page }) => {
    await setLighting(page, { ...SUMMER_NOON, sunEnabled: true, lamps: onlyLamps(allLampIds) });
    await rendered(page);
    const stats = await flat(page, (f) => f.stats());
    expect(stats.calls).toBeLessThanOrEqual(MAX_DRAW_CALLS);
  });

  test('the shadow-light count is constant: toggling lamps and walking compile no new program', async ({ page }) => {
    await setLighting(page, { ...SUMMER_NOON, sunEnabled: true, lamps: noLamps });
    await rendered(page);
    const programs = (await flat(page, (f) => f.stats())).programs;
    await setLighting(page, { lamps: onlyLamps(allLampIds) });
    await setLighting(page, { lamps: onlyLamps(['l-sejour']) });
    await setLighting(page, { lamps: noLamps });
    expect((await flat(page, (f) => f.stats())).programs).toBe(programs);
  });
});

test.describe('regression scenes (Charme, orbit)', () => {
  const scenes = [
    { file: 'm2-winter-0800', date: '2026-12-21', time: '08:00', night: false },
    { file: 'm2-winter-1200', date: '2026-12-21', time: '12:00', night: false },
    { file: 'm2-summer-1800', date: '2026-06-21', time: '18:00', night: false },
    { file: 'm2-night', date: '2026-06-21', time: '23:00', night: true },
  ];

  test('the 4 fixed scenes: not blank, ordered by brightness, within the draw-call budget (PNGs go to test-results/)', async ({ page }) => {
    test.setTimeout(90_000);
    const mean: Record<string, number> = {};
    for (const s of scenes) {
      if (s.night) await preset(page, 'Night');
      else {
        await preset(page, 'Day');
        await setLighting(page, { date: s.date, time: s.time });
      }
      await rendered(page);
      const stats = await flat(page, (f) => f.stats());
      expect(stats.calls, `${s.file} draw calls`).toBeLessThanOrEqual(MAX_DRAW_CALLS);
      expect(stats.calls).toBeGreaterThan(0);
      const m = await meanLuma(page);
      const colours = await page.evaluate(async () => {
        const img = new Image();
        img.src = window.__flat!.capture();
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        const seen = new Set<number>();
        for (let i = 0; i < px.length; i += 16) seen.add(((px[i]! >> 3) << 10) | ((px[i + 1]! >> 3) << 5) | (px[i + 2]! >> 3));
        return seen.size;
      });
      expect(colours, `${s.file} is not blank`).toBeGreaterThan(20);
      expect(m, `${s.file} is not black`).toBeGreaterThan(0.005);
      mean[s.file] = m;
      await savePng(page, `test-results/${s.file}.png`);
    }
    // Night (lamps only) < winter dawn < winter noon; the summer evening is also brighter than night.
    expect(mean['m2-night']!).toBeLessThan(mean['m2-winter-0800']!);
    expect(mean['m2-winter-0800']!).toBeLessThan(mean['m2-winter-1200']!);
    expect(mean['m2-night']!).toBeLessThan(mean['m2-summer-1800']!);
    const values = Object.values(mean).sort((a, b) => a - b);
    for (let i = 1; i < values.length; i++) expect(values[i]! - values[i - 1]!, 'scenes are distinguishable').toBeGreaterThan(0.01);
  });
});
