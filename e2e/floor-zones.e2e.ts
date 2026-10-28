/**
 * Floor zones: select the Charme kitchen zone ("cuisine"), change its material and undo; add a zone to a room,
 * drag its corner handles with the real mouse (5 cm grid) and check that the zone stops at the room walls; rename
 * and remove through the panel. The scene is asserted through `window.__flat.getScene()`, never through pixels.
 *
 * Screenshots (always written): e2e-selected-zone.png, e2e-clamped.png.
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { zoneProblems } from '../packages/scene/src/index';
import type { Scene } from '../packages/scene/src/index';
import { openApp, rendered } from './helpers';


const getScene = (page: Page): Promise<Scene> => page.evaluate(() => window.__flat!.getScene());
const properties = (page: Page): Locator => page.getByTestId('properties');
const zonesOf = (scene: Scene, roomId: string) => scene.rooms.find((r) => r.id === roomId)!.floorZones ?? [];

test.describe('floor zones (desktop)', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('the cuisine zone: a click on its floor selects it, a texture changes it, undo restores it', async ({ page }) => {
    test.slow();
    const before = await getScene(page);
    expect(zonesOf(before, 'sejour').map((z) => z.id)).toEqual(['cuisine']);
    const cuisine = zonesOf(before, 'sejour')[0]!;

    // A real click on the kitchen tiles from above selects the zone; a click on the parquet next to it selects the room floor.
    await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
    await rendered(page);
    const centre: [number, number, number] = [(cuisine.polygon[0]![0] + cuisine.polygon[1]![0]) / 2, 0, cuisine.polygon[0]![1] + 0.2];
    const at = await page.evaluate((p) => window.__flat!.project(p), centre);
    await page.mouse.click(at.x, at.y);
    await rendered(page);
    const panel = properties(page);
    await expect(panel.locator('h2')).toHaveText('Cuisine (floor zone)');
    await expect(panel.getByTestId('finish-zone')).toContainText('Grey floor tiles');
    await expect(panel.getByRole('button', { name: /^This zone/ })).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: test.info().outputPath('e2e-selected-zone.png') });

    const parquet = await page.evaluate((p) => window.__flat!.project(p), [2.0, 0, 5.2] as [number, number, number]);
    await page.mouse.click(parquet.x, parquet.y);
    await rendered(page);
    await expect(panel.locator('h2')).toHaveText('Séjour / Cuisine');
    await expect(panel.getByTestId('zone-row-cuisine')).toBeVisible();

    // Back to the zone through the list, then change its material with a library texture.
    await panel.getByTestId('zone-row-cuisine').getByRole('button', { name: /Cuisine/ }).first().click();
    await rendered(page);
    const finish = panel.getByRole('region', { name: 'Finish' });
    await finish.getByRole('tab', { name: 'Textures' }).click();
    await finish.getByRole('button', { name: 'White metro tiles' }).click();
    await rendered(page);
    const changed = await getScene(page);
    expect(zonesOf(changed, 'sejour')[0]!.material).toBe('lib-tile-white-metro');
    expect(zonesOf(changed, 'sejour')[0]!.polygon).toEqual(cuisine.polygon);
    expect(changed.rooms.find((r) => r.id === 'sejour')!.floorMaterial).toBe(before.rooms.find((r) => r.id === 'sejour')!.floorMaterial);
    await expect(panel.getByTestId('finish-zone')).toContainText('White metro tiles');

    // The room floor below it is untouched, the WC keeps its tiles, and one undo brings the old material back.
    await page.getByRole('button', { name: 'Undo' }).click();
    await rendered(page);
    expect(await getScene(page)).toEqual(before);
    await page.getByRole('button', { name: 'Redo' }).click();
    await rendered(page);
    expect(zonesOf(await getScene(page), 'sejour')[0]!.material).toBe('lib-tile-white-metro');
    await page.getByRole('button', { name: 'Undo' }).click();
    await rendered(page);
    expect(await getScene(page)).toEqual(before);

    // "Match the floor around" gives the zone the room floor material.
    await finish.getByRole('button', { name: 'Match the floor around' }).click();
    await rendered(page);
    expect(zonesOf(await getScene(page), 'sejour')[0]!.material).toBe('lib-parquet-light-oak');
  });

  test('Add zone makes a 1 x 1 m square at the room centre; its corner handles drag on a 5 cm grid and stop at the walls', async ({ page }) => {
    test.slow();
    const before = await getScene(page);
    const alcove = before.rooms.find((r) => r.id === 'alcove')!; // top-left of the plan: clear of the properties dock
    await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
    await page.evaluate(() => window.__flat!.select('alcove'));
    await rendered(page);
    const panel = properties(page);
    await panel.getByTestId('add-zone').click();
    await rendered(page);

    let scene = await getScene(page);
    expect(zonesOf(scene, 'alcove')).toHaveLength(1);
    const zone = zonesOf(scene, 'alcove')[0]!;
    expect(zone.id).toBe('zone-1');
    const xs = zone.polygon.map((p) => p[0]);
    const ys = zone.polygon.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(1, 6);
    const cx = alcove.polygon.reduce((s, p) => s + p[0], 0) / 4;
    const cy = alcove.polygon.reduce((s, p) => s + p[1], 0) / 4;
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(cx, 1);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(cy, 1);
    expect(zone.material).not.toBe(alcove.floorMaterial);
    await expect(panel.locator('h2')).toHaveText('Zone 1 (floor zone)');

    const project = (x: number, z: number) => page.evaluate((p) => window.__flat!.project(p), [x, 0.03, z] as [number, number, number]);
    const drag = async (from: [number, number], to: [number, number]) => {
      const a = await project(...from);
      const b = await project(...to);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
      await page.mouse.move(b.x, b.y, { steps: 6 });
      await page.mouse.up();
      await rendered(page);
    };

    // Drag the bottom-right corner 0.43 m east and 0.3 m south: it lands on the 5 cm grid.
    const br: [number, number] = [Math.max(...xs), Math.max(...ys)];
    await drag(br, [br[0] + 0.43, br[1] + 0.3]);
    scene = await getScene(page);
    const grown = zonesOf(scene, 'alcove')[0]!;
    const gx = grown.polygon.map((p) => p[0]);
    const gy = grown.polygon.map((p) => p[1]);
    expect(Math.min(...gx)).toBeCloseTo(Math.min(...xs), 6);
    expect(Math.min(...gy)).toBeCloseTo(Math.min(...ys), 6);
    expect(Math.round(Math.max(...gx) * 20) / 20).toBeCloseTo(Math.max(...gx), 6);
    expect(Math.round(Math.max(...gy) * 20) / 20).toBeCloseTo(Math.max(...gy), 6);
    expect(Math.max(...gx)).toBeGreaterThan(br[0] + 0.3);
    expect(Math.max(...gy)).toBeGreaterThan(br[1] + 0.2);

    // The drag is ONE undo step.
    const history = await page.evaluate(() => window.__flat!.history());
    expect(history.labels.filter((l) => l.startsWith('Resize floor zone'))).toHaveLength(1);

    // Drag the same corner far outside the room (and below the screen centre): the zone stops at the walls.
    const corner: [number, number] = [Math.max(...gx), Math.max(...gy)];
    const wall = await project(alcove.polygon[2]![0] + 3, alcove.polygon[2]![1] + 3);
    const from = await project(...corner);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + wall.x) / 2, (from.y + wall.y) / 2, { steps: 5 });
    await page.mouse.move(wall.x, wall.y, { steps: 5 });
    await page.screenshot({ path: test.info().outputPath('e2e-clamped.png') });
    await page.mouse.up();
    await rendered(page);
    scene = await getScene(page);
    const clamped = zonesOf(scene, 'alcove')[0]!;
    const room = scene.rooms.find((r) => r.id === 'alcove')!;
    expect(zoneProblems(room.polygon, [clamped])).toEqual([]);
    const maxX = Math.max(...room.polygon.map((p) => p[0]));
    const maxY = Math.max(...room.polygon.map((p) => p[1]));
    expect(Math.max(...clamped.polygon.map((p) => p[0]))).toBeGreaterThan(maxX - 0.2);
    expect(Math.max(...clamped.polygon.map((p) => p[0]))).toBeLessThanOrEqual(maxX + 0.011);
    expect(Math.max(...clamped.polygon.map((p) => p[1]))).toBeGreaterThan(maxY - 0.2);
    expect(Math.max(...clamped.polygon.map((p) => p[1]))).toBeLessThanOrEqual(maxY + 0.011);

    // Undo steps back through the two drags and the add.
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Undo' }).click();
      await rendered(page);
    }
    expect(await getScene(page)).toEqual(before);
  });

  test('the list renames and removes zones; every edit is undoable', async ({ page }) => {
    const before = await getScene(page);
    await page.evaluate(() => window.__flat!.select('sejour'));
    await rendered(page);
    const row = properties(page).getByTestId('zone-row-cuisine');
    const name = row.getByLabel('Name of zone cuisine');
    await name.fill('Kitchen corner');
    await name.press('Enter');
    await rendered(page);
    expect(zonesOf(await getScene(page), 'sejour')[0]!.name).toBe('Kitchen corner');
    await expect(row.getByRole('button', { name: /Kitchen corner/ }).first()).toBeVisible();

    await properties(page).getByRole('button', { name: 'Remove zone Kitchen corner' }).click();
    await rendered(page);
    expect(zonesOf(await getScene(page), 'sejour')).toHaveLength(0);
    expect(await page.evaluate(() => window.__flat!.getScene().rooms.find((r) => r.id === 'sejour')!.floorZones)).toBeUndefined();

    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    await rendered(page);
    expect(await getScene(page)).toEqual(before);
  });
});
