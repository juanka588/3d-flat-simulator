/**
 * Plan check: the Charme flat with its two original plan incoherences (the 11.5 cm slot beside the Chambre 2 placard, the TE
 * cupboard inside the SDB with butt joints) shows warnings with proposed fixes; hovering one flags its walls in red; "Apply fix"
 * runs the repair as one undoable batch; "Apply all safe fixes" clears the joint advisories. The scene is asserted through
 * `window.__flat.getScene()`, never through pixels.
 *
 * Screenshot (always written): e2e-plan-check.png.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Scene } from '../packages/scene/src/index';
import { charmeFlat, loadScene, openApp, rendered } from './helpers';

const getScene = (page: Page): Promise<Scene> => page.evaluate(() => window.__flat!.getScene());

interface Raw {
  walls: { id: string; start: [number, number]; end: [number, number] }[];
  rooms: { id: string; polygon: [number, number][] }[];
  items: { id: string }[];
}

/** Charme as it was before the two hand fixes. */
function brokenCharme(): unknown {
  const s = structuredClone(charmeFlat) as unknown as Raw;
  s.items = s.items.filter((i) => i.id !== 'placard-ch2');
  const wall = (id: string) => s.walls.find((w) => w.id === id)!;
  wall('w-te-west').start = [5.95, 6.1];
  wall('w-te-south').end = [6.39, 6.435];
  s.rooms.find((r) => r.id === 'entree')!.polygon = [[4.54, 4.19], [6.91, 4.19], [6.91, 4.49], [8.7, 4.49], [8.7, 6.03], [4.54, 6.03]];
  s.rooms.find((r) => r.id === 'sdb')!.polygon = [[4.54, 6.1], [6.39, 6.1], [6.39, 8.28], [3.78, 8.28], [3.78, 6.65], [4.54, 6.65]];
  return s;
}

test.describe('plan check (desktop)', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('warnings with fixes, red highlight on hover, one undo step per fix', async ({ page }) => {
    test.slow();
    await openApp(page);
    expect(await loadScene(page, brokenCharme())).toBe(true);
    await rendered(page);

    const panel = page.getByTestId('warnings');
    const gap = panel.locator('li[data-code="wall-gap"]');
    const recess = panel.locator('li[data-code="room-includes-foreign-recess"]');
    await expect(gap).toHaveCount(1);
    await expect(recess).toHaveCount(1);
    await expect(page.getByTestId('plan-badge')).toBeVisible();
    await expect(gap).toContainText('11.5 cm');
    await expect(gap.getByTestId('plan-fix')).toBeVisible();

    // Hovering a warning flags its walls in red in the view.
    await gap.hover();
    await rendered(page);
    expect((await page.evaluate(() => window.__flat!.stats().meshes)).filter((n) => n === 'plan-highlight').length).toBeGreaterThan(0);
    // The recess finding flags the two rooms involved, which shows well from above.
    await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
    await recess.hover();
    await rendered(page);
    await page.screenshot({ path: test.info().outputPath('e2e-plan-check.png') });
    await page.mouse.move(900, 600);
    await rendered(page);
    expect((await page.evaluate(() => window.__flat!.stats().meshes)).filter((n) => n === 'plan-highlight')).toEqual([]);

    // Apply the gap fix: both walls meet at the corner, the warning is gone, undo brings the slot back.
    const before = await getScene(page);
    await gap.getByTestId('plan-fix').click();
    await expect(gap).toHaveCount(0);
    const after = await getScene(page);
    expect(after.walls.find((w) => w.id === 'w-ch2-south-west')!.end).toEqual([4.505, 4.155]);
    expect(after.walls.find((w) => w.id === 'w-sejour-entree')!.start).toEqual([4.505, 4.155]);
    // One undo step for the whole repair of two walls.
    expect((await page.evaluate(() => window.__flat!.history())).entries).toHaveLength(1);
    expect((await page.evaluate(() => window.__flat!.undo())).ok).toBe(true);
    await expect(gap).toHaveCount(1);
    expect(await getScene(page)).toEqual(before);

    // The recess moves from the SDB to the Entrée in one step.
    await recess.getByTestId('plan-fix').click();
    await expect(recess).toHaveCount(0);
    const moved = await getScene(page);
    expect(moved.rooms.find((r) => r.id === 'sdb')!.polygon).toEqual([[4.54, 6.1], [5.915, 6.1], [5.915, 6.47], [6.39, 6.47], [6.39, 8.28], [3.78, 8.28], [3.78, 6.65], [4.54, 6.65]]);
    expect(moved.rooms.find((r) => r.id === 'entree')!.polygon).toHaveLength(10);

    // All safe fixes together: the joint advisories and the slot go, the documented closet fronts stay.
    const all = page.getByTestId('plan-fix-all');
    await expect(all).toBeVisible();
    await all.click();
    await expect(page.getByTestId('plan-advisories')).toHaveCount(0);
    await expect(all).toHaveCount(0);
    await expect(panel.locator('li[data-code="wall-gap"]')).toHaveCount(0);
    await expect(panel.locator('li')).toHaveCount(2);
    await expect(panel.locator('li[data-code="room-edge-unwalled"]')).toHaveCount(2);
  });

  test('the Charme fixture lists only its two documented warnings (badge 2) and the joint advisories apart', async ({ page }) => {
    await openApp(page);
    expect(await loadScene(page, charmeFlat)).toBe(true);
    await expect(page.getByTestId('warnings').locator(':scope > ul > li')).toHaveCount(2);
    await expect(page.getByTestId('plan-badge')).toContainText('2');
    expect(await page.getByTestId('plan-advisories').locator('li').count()).toBeGreaterThan(0);
  });
});
