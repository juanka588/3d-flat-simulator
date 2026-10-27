/**
 * M3.16 room-scoped wall finishes in the UI: "This wall (<room> side)" paints only the clicked room's
 * stretch of a wall side shared by several rooms. Real canvas clicks in the orbit view (the click
 * records the room at the hit point), scene assertions through `getScene()`, pixel probes in walk view.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { wallLeftNormal, wallStats } from '../packages/scene/src/index';
import type { Scene } from '../packages/scene/src/index';
import { meanLuma, openApp, rendered, southEastOrbit } from './helpers';

const getScene = (page: Page): Promise<Scene> => page.evaluate(() => window.__flat!.getScene());
const finishPanel = (page: Page) => page.getByTestId('properties').getByRole('region', { name: 'Finish' });

/** Effective material of every wall-face stretch: `wall|side|from-to|roomId` -> material id. */
function faceMaterials(scene: Scene): Map<string, string> {
  const out = new Map<string, string>();
  for (const wall of scene.walls) {
    const stats = wallStats(scene, wall.id)!;
    for (const side of ['left', 'right'] as const) {
      for (const f of stats.faces[side]) out.set(`${wall.id}|${side}|${f.from.toFixed(3)}-${f.to.toFixed(3)}|${f.roomId ?? ''}`, f.material);
    }
  }
  return out;
}

/** The stretches of one wall side that belong to `roomId`. */
const stretch = (m: Map<string, string>, wallId: string, side: string, roomId: string) =>
  [...m].filter(([k]) => k.startsWith(`${wallId}|${side}|`) && k.endsWith(`|${roomId}`));

/** Clicks the face of `wallId` on `side`, `along` metres from the wall start; tries several heights until the panel offers `label`. */
async function clickFace(page: Page, wallId: string, side: 'left' | 'right', along: number, label: RegExp): Promise<void> {
  const scene = await getScene(page);
  const wall = scene.walls.find((w) => w.id === wallId)!;
  const len = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  const n = wallLeftNormal(wall);
  const sign = side === 'left' ? 1 : -1;
  const box = (await page.locator('canvas').boundingBox())!;
  for (const y of [1.3, 0.9, 1.9, 0.5]) {
    for (const dt of [0, 0.15, -0.15]) {
      const t = along / len + dt / len;
      const off = sign * (wall.thickness / 2 + 0.001);
      const p: [number, number, number] = [
        wall.start[0] + (wall.end[0] - wall.start[0]) * t + n[0] * off,
        y,
        wall.start[1] + (wall.end[1] - wall.start[1]) * t + n[1] * off,
      ];
      const at = await page.evaluate((pt) => window.__flat!.project(pt), p);
      if (at.x < box.x || at.y < box.y || at.x > box.x + box.width || at.y > box.y + box.height) continue;
      await page.mouse.click(at.x, at.y);
      await rendered(page);
      if ((await finishPanel(page).getByRole('button', { name: label }).count()) > 0) return;
    }
  }
  throw new Error(`could not click ${wallId} ${side} at ${along} m`);
}

/** Walk-view luma of a wall point seen from `pose`, with nothing selected (the selection highlight tints the whole wall). */
async function wallLuma(page: Page, pose: { x: number; z: number; yawDeg: number }, point: [number, number, number]): Promise<number> {
  await page.evaluate(() => window.__flat!.select(null));
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await page.evaluate((p) => window.__flat!.setWalkPose(p), pose);
  await rendered(page);
  return meanLuma(page, { point, half: 10 });
}

test.describe('room-scoped wall finishes', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('painting w-west from the séjour leaves the alcove stretch unchanged (scene and pixels); undo is exact', async ({ page }) => {
    test.slow();
    const original = await getScene(page);
    const before = faceMaterials(original);
    // w-west runs from y=8.38 (s=0) to y=-0.1: the séjour is y 2.27..8.28 (s 0.1..6.1), the alcove y 0..2.2.
    const sejourView = { pose: { x: 1.8, z: 5.2, yawDeg: 90 }, point: [0, 1.2, 5.2] as [number, number, number] };
    const alcoveView = { pose: { x: 1.8, z: 1.0, yawDeg: 90 }, point: [0, 1.2, 1.0] as [number, number, number] };
    const sejourBefore = await wallLuma(page, sejourView.pose, sejourView.point);
    const alcoveBefore = await wallLuma(page, alcoveView.pose, alcoveView.point);

    await page.evaluate(() => window.__flat!.setView({ mode: 'orbit' }));
    // The séjour stretch of w-west is hidden from the default orbit camera: select it as a click in the séjour would (the hook records the room).
    expect(await page.evaluate(() => window.__flat!.select({ wallId: 'w-west', side: 'right', roomId: 'sejour' }))).toBe(true);
    await rendered(page);
    const finish = finishPanel(page);
    await expect(finish.getByRole('button', { name: 'This wall (Séjour side)' })).toHaveAttribute('aria-pressed', 'true');
    await expect(finish.getByTestId('finish-here')).toBeVisible();
    await finish.getByRole('radio', { name: /^Navy / }).click();
    await rendered(page);

    const after = await getScene(page);
    const next = faceMaterials(after);
    const navy = 'paint-26354f-matt';
    expect(stretch(next, 'w-west', 'right', 'sejour').every(([, m]) => m === navy)).toBe(true);
    expect(stretch(next, 'w-west', 'right', 'alcove')).toEqual(stretch(before, 'w-west', 'right', 'alcove'));
    expect(after.walls.find((w) => w.id === 'w-west')!.roomFinishes).toEqual({ sejour: { right: navy } });
    // Everything else on the plan is untouched.
    for (const [key, m] of next) if (!key.startsWith('w-west|right|') || !key.endsWith('|sejour')) expect(m, key).toBe(before.get(key));
    await expect(finish.getByTestId('finish-here')).toContainText('Navy');

    const sejourAfter = await wallLuma(page, sejourView.pose, sejourView.point);
    const alcoveAfter = await wallLuma(page, alcoveView.pose, alcoveView.point);
    expect(sejourAfter).toBeLessThan(sejourBefore - 0.1);
    expect(Math.abs(alcoveAfter - alcoveBefore)).toBeLessThan(0.02);

    await page.evaluate(() => window.__flat!.setView({ mode: 'orbit' }));
    await page.getByRole('button', { name: 'Undo' }).click();
    await rendered(page);
    expect(await getScene(page)).toEqual(original);
    expect(Math.abs((await wallLuma(page, sejourView.pose, sejourView.point)) - sejourBefore)).toBeLessThan(0.02);

    // Reset clears only that room's stretch.
    await page.evaluate(() => window.__flat!.setView({ mode: 'orbit' }));
    await page.getByRole('button', { name: 'Redo' }).click();
    expect(await page.evaluate(() => window.__flat!.select({ wallId: 'w-west', side: 'right', roomId: 'sejour' }))).toBe(true);
    await finish.getByRole('button', { name: 'Reset to default' }).click();
    await rendered(page);
    const reset = await getScene(page);
    expect(faceMaterials(reset)).toEqual(before);
  });

  test('a real click on w-north inside chambre 1 paints only chambre 1; the alcove and chambre 2 stretches are unchanged', async ({ page }) => {
    test.slow();
    await southEastOrbit(page);
    const original = await getScene(page);
    const before = faceMaterials(original);
    // w-north starts at x=-1.6; chambre 1 is x 6.91..10.05 (s 8.51..11.65), away from its window (s 10.44..11.34).
    await clickFace(page, 'w-north', 'right', 9.0, /^This wall \(Chambre 1 side\)$/);
    const finish = finishPanel(page);
    await expect(finish.getByRole('button', { name: 'This wall (Chambre 1 side)' })).toHaveAttribute('aria-pressed', 'true');
    await finish.getByRole('radio', { name: /^Terracotta / }).click();
    await rendered(page);

    const after = await getScene(page);
    const next = faceMaterials(after);
    const terracotta = 'paint-b8613f-matt';
    expect(stretch(next, 'w-north', 'right', 'ch1').every(([, m]) => m === terracotta)).toBe(true);
    for (const room of ['alcove', 'ch2']) expect(stretch(next, 'w-north', 'right', room), room).toEqual(stretch(before, 'w-north', 'right', room));
    expect(after.walls.find((w) => w.id === 'w-north')!.roomFinishes).toEqual({ ch1: { right: terracotta } });

    await page.getByRole('button', { name: 'Undo' }).click();
    await rendered(page);
    expect(await getScene(page)).toEqual(original);
  });

  test('both faces of w-alcove take different colours; "Both faces here" paints each within its room; one undo each', async ({ page }) => {
    test.slow();
    const original = await getScene(page);
    // w-alcove runs +x at y=2.235: its left face looks north into the alcove, the right face south into the séjour.
    await page.evaluate(() => window.__flat!.select({ wallId: 'w-alcove', side: 'left', roomId: 'alcove' }));
    await rendered(page);
    const finish = finishPanel(page);
    await expect(finish.getByRole('button', { name: 'This wall (Alcôve side)' })).toBeVisible();
    await finish.getByRole('radio', { name: /^Sage / }).click();
    await page.evaluate(() => window.__flat!.select({ wallId: 'w-alcove', side: 'right', roomId: 'sejour' }));
    await rendered(page);
    await finish.getByRole('radio', { name: /^Terracotta / }).click();
    await rendered(page);
    let wall = (await getScene(page)).walls.find((w) => w.id === 'w-alcove')!;
    expect(wall.roomFinishes).toEqual({ alcove: { left: 'paint-a3ae93-matt' }, sejour: { right: 'paint-b8613f-matt' } });
    expect(wall.finish).toEqual({});

    // "Both faces here" from the séjour face: one batch, both faces, each in its own room.
    await finish.getByRole('button', { name: 'Both faces here' }).click();
    await finish.getByRole('radio', { name: /^Navy / }).click();
    await rendered(page);
    wall = (await getScene(page)).walls.find((w) => w.id === 'w-alcove')!;
    expect(wall.roomFinishes).toEqual({ alcove: { left: 'paint-26354f-matt' }, sejour: { right: 'paint-26354f-matt' } });
    expect((await page.evaluate(() => window.__flat!.history())).entries.length).toBeGreaterThanOrEqual(3);

    await page.getByRole('button', { name: 'Undo' }).click();
    await rendered(page);
    wall = (await getScene(page)).walls.find((w) => w.id === 'w-alcove')!;
    expect(wall.roomFinishes).toEqual({ alcove: { left: 'paint-a3ae93-matt' }, sejour: { right: 'paint-b8613f-matt' } });
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    await rendered(page);
    expect(await getScene(page)).toEqual(original);
  });

  test('a wall selected by id alone has no face: the finish panel keeps its note', async ({ page }) => {
    await page.evaluate(() => window.__flat!.select('w-west'));
    await rendered(page);
    await expect(page.getByTestId('finish-note')).toContainText('Select a wall side');
  });
});
