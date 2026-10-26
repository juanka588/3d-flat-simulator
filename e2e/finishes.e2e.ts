/**
 * Finish UI (M3.9, M3.10) and the structural UI (M3.15): scope buttons, paint swatches, textures,
 * reset, undo/redo, the structural badge/toggle, the top-view overlay and the mobile bottom sheet.
 * The scene is asserted through `window.__flat.getScene()`, never through pixels.
 *
 * Screenshots (always written): /tmp/finish-panel-desktop.png, /tmp/finish-panel-mobile.png,
 * /tmp/structural-overlay.png.
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { roomWallSides, wallLeftNormal, wallStats } from '../packages/scene/src/index';
import type { Scene } from '../packages/scene/src/index';
import { openApp, rendered } from './helpers';

const ROOM = 'sejour';
const SAGE_ID = 'paint-a3ae93-matt';

const getScene = (page: Page): Promise<Scene> => page.evaluate(() => window.__flat!.getScene());
const properties = (page: Page): Locator => page.getByTestId('properties');

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

/**
 * Clicks a wall face of `roomId` in the orbit view (a real canvas click) until the properties panel
 * shows a wall side. Tries each wall around the room, on the room's side, at several heights/offsets.
 */
async function clickWallOfRoom(page: Page, roomId: string): Promise<string> {
  const scene = await getScene(page);
  const sides = roomWallSides(scene, roomId);
  const roomName = scene.rooms.find((r) => r.id === roomId)!.name;
  for (const { wallId, side } of sides) {
    const wall = scene.walls.find((w) => w.id === wallId)!;
    const n = wallLeftNormal(wall);
    const sign = side === 'left' ? 1 : -1;
    for (const t of [0.5, 0.3, 0.7]) {
      for (const y of [1.3, 0.8, 1.8]) {
        const off = sign * (wall.thickness / 2 + 0.001);
        const p: [number, number, number] = [
          wall.start[0] + (wall.end[0] - wall.start[0]) * t + n[0] * off,
          y,
          wall.start[1] + (wall.end[1] - wall.start[1]) * t + n[1] * off,
        ];
        const at = await page.evaluate((pt) => window.__flat!.project(pt), p);
        const box = await page.locator('canvas').boundingBox();
        if (!box || at.x < box.x || at.y < box.y || at.x > box.x + box.width || at.y > box.y + box.height) continue;
        await page.mouse.click(at.x, at.y);
        await rendered(page);
        const panel = properties(page);
        if ((await panel.locator('h2').textContent())?.startsWith('Wall') && (await panel.getByRole('button', { name: new RegExp(`^All walls of ${roomName}`) }).count()) > 0) {
          return wallId;
        }
      }
    }
  }
  throw new Error(`could not click a wall face of ${roomId}`);
}

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('all walls of this room + a swatch changes exactly the room wall sides; undo and redo via buttons and keys', async ({ page }) => {
    test.slow();
    const before = await getScene(page);
    const baseline = faceMaterials(before);
    await clickWallOfRoom(page, ROOM);
    const panel = properties(page);
    const finish = panel.getByRole('region', { name: 'Finish' });
    await finish.getByRole('button', { name: /^All walls of/ }).click();
    await expect(finish.getByRole('button', { name: /^All walls of/ })).toHaveAttribute('aria-pressed', 'true');
    await finish.getByRole('radio', { name: /^Sage / }).click();
    await rendered(page);

    const after = await getScene(page);
    expect(after.materials.some((m) => m.id === SAGE_ID)).toBe(true);
    const next = faceMaterials(after);
    const room = after.rooms.find((r) => r.id === ROOM)!;
    expect(roomWallSides(after, ROOM).length).toBeGreaterThan(0);
    for (const [key, material] of next) {
      const inRoom = key.endsWith(`|${ROOM}`);
      if (inRoom) expect(material, key).toBe(SAGE_ID);
      else expect(material, key).toBe(baseline.get(key));
    }
    // Nothing else changed: floors, ceilings, other rooms.
    expect(room.floorMaterial).toEqual(before.rooms.find((r) => r.id === ROOM)!.floorMaterial);
    for (const r of after.rooms.filter((x) => x.id !== ROOM)) expect(r.wallFinish).toEqual(before.rooms.find((x) => x.id === r.id)!.wallFinish);
    await expect(finish.locator('[data-testid^="finish-"]').filter({ hasText: 'Sage' }).first()).toBeVisible();
    await page.screenshot({ path: '/tmp/finish-panel-desktop.png' });

    // Undo / redo through the buttons.
    const undo = page.getByRole('button', { name: 'Undo' });
    const redo = page.getByRole('button', { name: 'Redo' });
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
    await undo.click();
    await rendered(page);
    expect(faceMaterials(await getScene(page))).toEqual(baseline);
    await expect(redo).toBeEnabled();
    await redo.click();
    await rendered(page);
    expect(faceMaterials(await getScene(page))).toEqual(next);

    // ... and through the keyboard (focus on the page, not in a field).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+z');
    await rendered(page);
    expect(faceMaterials(await getScene(page))).toEqual(baseline);
    await page.keyboard.press('Control+Shift+z');
    await rendered(page);
    expect(faceMaterials(await getScene(page))).toEqual(next);

    // The history popover lists the entry with its label.
    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByTestId('history-list')).toContainText('Paint');
    await expect(page.getByTestId('history-list')).toContainText('Sage');
  });

  test('a texture applies to the floor; reset to default clears it', async ({ page }) => {
    test.slow();
    await page.evaluate(() => window.__flat!.select('sejour'));
    await rendered(page);
    const finish = properties(page).getByRole('region', { name: 'Finish' });
    await expect(finish.getByRole('button', { name: 'Floor' })).toHaveAttribute('aria-pressed', 'true');
    await finish.getByRole('tab', { name: 'Textures' }).click();
    const card = finish.getByRole('button', { name: 'Light oak parquet' });
    await expect(card).toBeVisible();
    await expect(card.locator('img')).toHaveAttribute('loading', 'lazy');
    await card.click();
    await rendered(page);
    let room = (await getScene(page)).rooms.find((r) => r.id === ROOM)!;
    expect(room.floorMaterial).toBe('lib-parquet-light-oak');
    expect((await getScene(page)).materials.find((m) => m.id === 'lib-parquet-light-oak')).toMatchObject({ kind: 'texture', textureUrl: 'lib:parquet-light-oak' });
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    await expect(finish.getByTestId('finish-floor')).toContainText('Light oak parquet');

    // The category filter narrows the grid.
    await finish.getByLabel('Category').selectOption('wall-plaster');
    await expect(finish.getByRole('button', { name: 'Light oak parquet' })).toHaveCount(0);
    await finish.getByLabel('Category').selectOption('all');

    // The ceiling scope is offered from a room selection.
    await finish.getByRole('button', { name: 'Ceiling' }).click();
    await finish.getByRole('tab', { name: 'Paint' }).click();
    await finish.getByRole('radio', { name: /^Chalk white / }).click();
    await rendered(page);
    room = (await getScene(page)).rooms.find((r) => r.id === ROOM)!;
    expect(room.ceilingMaterial).toBe('paint-f2eee6-matt');

    await finish.getByRole('button', { name: 'Floor' }).click();
    await finish.getByRole('button', { name: 'Reset to default' }).click();
    await rendered(page);
    room = (await getScene(page)).rooms.find((r) => r.id === ROOM)!;
    expect(room.floorMaterial ?? null).toBeNull();
    expect(room.ceilingMaterial).toBe('paint-f2eee6-matt');
  });

  test('custom colour: invalid hex is flagged, a valid hex applies, swatches support arrow keys', async ({ page }) => {
    test.slow();
    await page.evaluate(() => window.__flat!.select('sejour'));
    await rendered(page);
    const finish = properties(page).getByRole('region', { name: 'Finish' });
    const hex = finish.getByLabel('Hex');
    await hex.fill('nope');
    await hex.press('Enter');
    await expect(hex).toHaveAttribute('aria-invalid', 'true');
    await expect(finish.getByRole('alert')).toContainText('hex colour');
    await hex.fill('#123456');
    await hex.press('Enter');
    await rendered(page);
    expect((await getScene(page)).rooms.find((r) => r.id === ROOM)!.floorMaterial).toBe('paint-123456-matt');
    await expect(finish.getByRole('radio', { name: 'Recent #123456' })).toBeVisible();

    // Arrow keys move between the swatches of a group.
    const first = finish.getByRole('radio', { name: /^Chalk white / });
    await first.focus();
    await page.keyboard.press('ArrowRight');
    await expect(finish.getByRole('radio', { name: /^Warm white / })).toBeFocused();

    // Sheen change re-applies the active paint with the new sheen.
    await finish.getByLabel('Sheen').selectOption('gloss');
    await rendered(page);
    expect((await getScene(page)).rooms.find((r) => r.id === ROOM)!.floorMaterial).toBe('paint-123456-gloss');
  });

  test('openings and wall edges explain that only wall sides, floors and ceilings take finishes', async ({ page }) => {
    const scene = await getScene(page);
    await page.evaluate((id) => window.__flat!.select(id), scene.openings[0]!.id);
    await rendered(page);
    await expect(page.getByTestId('finish-note')).toContainText('Only wall sides, floors and ceilings');
    await expect(properties(page).getByRole('region', { name: 'Finish' })).toHaveCount(0);
  });

  test('structural badge and toggle are undoable; the top view draws the overlay with a legend', async ({ page }) => {
    test.slow();
    const scene = await getScene(page);
    const wall = scene.walls.find((w) => w.structural === undefined && w.thickness < 0.15) ?? scene.walls[0]!;
    await page.evaluate((id) => window.__flat!.select(id), wall.id);
    await rendered(page);
    const badge = page.getByTestId('structural-badge');
    const was = /Structural/.test((await badge.textContent()) ?? '');
    await expect(badge).toContainText(was ? 'Structural (load-bearing/façade)' : 'Removable partition');

    await page.getByTestId('structural-control').getByRole('button', { name: 'Structural wall' }).click();
    await rendered(page);
    expect((await getScene(page)).walls.find((w) => w.id === wall.id)!.structural).toBe(!was);
    await expect(badge).toContainText('set manually');
    await expect(badge).toContainText(was ? 'Removable partition' : 'Structural (load-bearing/façade)');

    await page.getByRole('button', { name: 'Undo' }).click();
    await rendered(page);
    expect((await getScene(page)).walls.find((w) => w.id === wall.id)!.structural).toBe(wall.structural);
    await expect(badge).toContainText(was ? 'Structural (load-bearing/façade)' : 'Removable partition');

    // Top view: overlay meshes, legend, toggle.
    await expect(page.getByTestId('structural-legend')).toHaveCount(0);
    await page.getByRole('button', { name: 'Top', exact: true }).click();
    await rendered(page);
    const legend = page.getByTestId('structural-legend');
    await expect(legend).toContainText('Structural');
    await expect(legend).toContainText('Removable partition');
    expect((await page.evaluate(() => window.__flat!.stats())).meshes).toContain('structural-walls');
    await page.screenshot({ path: '/tmp/structural-overlay.png' });

    await legend.getByRole('checkbox', { name: 'Show structural walls' }).uncheck();
    await rendered(page);
    expect((await page.evaluate(() => window.__flat!.stats())).meshes).not.toContain('structural-walls');
    await legend.getByRole('checkbox', { name: 'Show structural walls' }).check();
    await rendered(page);
    expect((await page.evaluate(() => window.__flat!.stats())).meshes).toContain('structural-walls');

    // Back in orbit there is no overlay.
    await page.getByRole('button', { name: 'Orbit', exact: true }).click();
    await rendered(page);
    expect((await page.evaluate(() => window.__flat!.stats())).meshes).not.toContain('structural-walls');
  });
});

test.describe('mobile bottom sheet', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile layout');

  test('finish flow works in the bottom sheet with 44 px tap targets', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__flat!.select('sejour'));
    await rendered(page);
    const sheet = properties(page);
    const finish = sheet.getByRole('region', { name: 'Finish' });
    // The sheet opens compact (summary and a Finish button); Finish expands it to the controls.
    const vh = page.viewportSize()!.height;
    expect((await sheet.boundingBox())!.height).toBeLessThan(vh * 0.46);
    await expect(finish).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Finish', exact: true }).tap();
    await expect(finish).toBeVisible();
    const open = (await sheet.boundingBox())!.height;
    expect(open).toBeGreaterThan(vh * 0.55);
    expect(open).toBeLessThanOrEqual(vh * 0.7);

    const small = async (loc: Locator) => {
      const boxes = await loc.evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { w: r.width, h: r.height, name: e.getAttribute('aria-label') ?? e.textContent };
        }),
      );
      return boxes.filter((b) => b.w < 43.5 || b.h < 43.5);
    };
    await finish.getByRole('radio', { name: /^Sage / }).scrollIntoViewIfNeeded();
    expect(await small(finish.getByRole('button'))).toEqual([]);
    expect(await small(finish.getByRole('radio'))).toEqual([]);
    expect(await small(finish.getByRole('tab'))).toEqual([]);
    expect(await small(sheet.getByRole('button', { name: /Undo|Redo|History/ }))).toEqual([]);

    // The sheet scrolls rather than overflowing the screen.
    const scroll = await sheet.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight, bottom: el.getBoundingClientRect().bottom, vh: innerHeight }));
    expect(scroll.scroll).toBeGreaterThan(scroll.client);
    expect(scroll.bottom).toBeLessThanOrEqual(scroll.vh + 1);

    await finish.getByRole('button', { name: 'Ceiling' }).tap();
    await finish.getByRole('radio', { name: /^Sage / }).tap();
    await rendered(page);
    expect((await getScene(page)).rooms.find((r) => r.id === ROOM)!.ceilingMaterial).toBe(SAGE_ID);

    await finish.getByRole('tab', { name: 'Textures' }).tap();
    await finish.getByRole('button', { name: 'Light oak parquet' }).scrollIntoViewIfNeeded();
    await finish.getByRole('button', { name: 'Floor', exact: true }).tap();
    await finish.getByRole('button', { name: 'Light oak parquet' }).tap();
    await rendered(page);
    expect((await getScene(page)).rooms.find((r) => r.id === ROOM)!.floorMaterial).toBe('lib-parquet-light-oak');

    await sheet.getByRole('button', { name: 'Undo' }).tap();
    await rendered(page);
    expect((await getScene(page)).rooms.find((r) => r.id === ROOM)!.floorMaterial ?? null).toBeNull();
    await finish.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/finish-panel-mobile.png' });
  });
});
