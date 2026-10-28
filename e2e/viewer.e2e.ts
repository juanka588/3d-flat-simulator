import { expect, test } from '@playwright/test';
import { charmeFlat, flat, inPolygon, loadScene, openApp, polygonArea, rendered, sampleFlat } from './helpers';

const MAX_DRAW_CALLS = 70;
const MAX_TRIANGLES = 60_000;

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test.describe('performance budgets (Charme)', () => {
  const withinBudget = async (page: import('@playwright/test').Page) => {
    const s = await flat(page, (f) => f.stats());
    expect(s.sceneName).toContain('Charme');
    expect(s.calls).toBeGreaterThan(0);
    expect(s.calls).toBeLessThanOrEqual(MAX_DRAW_CALLS);
    expect(s.triangles).toBeGreaterThan(0);
    expect(s.triangles).toBeLessThanOrEqual(MAX_TRIANGLES);
  };

  test('orbit', async ({ page }) => {
    await rendered(page);
    await withinBudget(page);
  });

  test('walk', async ({ page }) => {
    await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
    await withinBudget(page);
  });

  test('with a selection', async ({ page }) => {
    expect(await page.evaluate(() => window.__flat!.select('w-north'))).toBe(true);
    await rendered(page);
    await withinBudget(page);
  });
});

test('clicking a wall and a room in top view selects them', async ({ page }) => {
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  const properties = page.getByTestId('properties');

  const wall = charmeFlat.walls.find((w) => w.id === 'w-north')!;
  const wallPoint = await page.evaluate(
    ([x, z]) => window.__flat!.project([x!, 2.5, z!]),
    [(wall.start[0] + wall.end[0]) / 2, (wall.start[1] + wall.end[1]) / 2],
  );
  // Make sure nothing (panel, compass) covers the point we are about to click.
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, wallPoint)).toBe('CANVAS');
  await page.mouse.click(wallPoint.x, wallPoint.y);
  await expect(properties.getByRole('heading')).toHaveText(`Wall ${wall.id}`);

  // The properties dock sits on the right edge and may cover the east rooms (it scrolls within a max
  // height and never reaches the plan centre); collapsing it to its title bar uncovers them.
  await properties.getByRole('button', { name: 'Hide details' }).click();
  const room = charmeFlat.rooms.find((r) => r.id === 'ch1')!;
  const centroid = room.polygon.reduce<[number, number]>((c, p) => [c[0] + p[0] / 4, c[1] + p[1] / 4], [0, 0]);
  const roomPoint = await page.evaluate(([x, z]) => window.__flat!.project([x!, 0, z!]), centroid);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, roomPoint)).toBe('CANVAS');
  await page.mouse.click(roomPoint.x, roomPoint.y);
  await expect(properties.getByRole('heading')).toHaveText(room.name);
  await properties.getByRole('button', { name: 'Show details' }).click();
  await expect(properties).toContainText(`${polygonArea(room.polygon).toFixed(2)} m²`);

  // Clicking empty space deselects.
  await properties.getByRole('button', { name: 'Hide details' }).click();
  const empty = await page.evaluate(() => window.__flat!.project([9, 0, 7.5])); // south-east, outside the flat
  await page.mouse.click(empty.x, empty.y);
  await expect(properties).toContainText('Click a wall');
});

test('the compass needle follows site.northAngle in top view', async ({ page }) => {
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  const needle = page.getByTestId('compass-needle');
  const angle = async () => Number(await needle.getAttribute('data-angle'));

  expect(await loadScene(page, { ...sampleFlat, site: { ...sampleFlat.site, northAngle: 0 } })).toBe(true);
  expect(Math.abs(await angle())).toBeLessThan(1);

  expect(await loadScene(page, { ...sampleFlat, site: { ...sampleFlat.site, northAngle: 90 } })).toBe(true);
  expect(Math.abs((await angle()) - 90)).toBeLessThan(1);
});

test('ceilings are hidden in orbit and top and drawn in walk', async ({ page }) => {
  const meshes = async () => (await flat(page, (f) => f.stats())).meshes;
  await rendered(page);
  expect(await meshes()).not.toContain('ceilings');
  expect(await meshes()).toContain('floors');

  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  expect(await meshes()).not.toContain('ceilings');

  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  expect(await meshes()).toContain('ceilings');

  await page.evaluate(() => window.__flat!.setView({ mode: 'orbit' }));
  expect(await meshes()).not.toContain('ceilings');
});

/**
 * Enters walk mode with the manual clock: the walker then moves only through `stepWalk(ms)` (fixed 16 ms
 * frames), never with the real frame time, so distances do not depend on how fast the machine renders.
 */
async function startWalk(page: import('@playwright/test').Page, pose: { x: number; z: number; yawDeg: number }): Promise<void> {
  await page.evaluate(() => window.__flat!.setClock('manual'));
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await page.evaluate((p) => window.__flat!.setWalkPose(p), pose);
}

const stepWalk = (page: import('@playwright/test').Page, ms: number) => page.evaluate((n) => window.__flat!.stepWalk(n), ms);
const cameraXZ = async (page: import('@playwright/test').Page): Promise<[number, number]> => {
  const [x, , z] = (await flat(page, (f) => f.stats())).camera;
  return [x, z];
};

function inside(polygon: [number, number][], [x, y]: [number, number]): boolean {
  let result = false;
  polygon.forEach(([x1, y1], i) => {
    const [x2, y2] = polygon[(i + 1) % polygon.length]!;
    if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) result = !result;
  });
  return result;
}

test('walking into a wall stops at the wall and stays inside the room', async ({ page }) => {
  // Séjour, facing the south wall (no openings): forward = (-sin yaw, -cos yaw), so yaw 180 looks along +z.
  const south = charmeFlat.walls.find((w) => w.id === 'w-south')!;
  const sejour = charmeFlat.rooms.find((r) => r.id === 'sejour')!;
  await startWalk(page, { x: 2, z: 7.3, yawDeg: 180 });

  await page.keyboard.down('ArrowUp');
  await stepWalk(page, 3000); // 4.2 m of walking: far more than the 0.7 m to the wall
  await page.keyboard.up('ArrowUp');
  await stepWalk(page, 500);

  const [x, z] = await cameraXZ(page);
  const wallZ = south.start[1];
  expect(inside(sejour.polygon, [x, z])).toBe(true);
  // Moved towards the wall (not stuck at the start) ...
  expect(z).toBeGreaterThan(7.6);
  // ... but never closer than 0.2 m to the wall's near face.
  expect(wallZ - south.thickness / 2 - z).toBeGreaterThanOrEqual(0.2);
});

test('walk keys are ignored while a form control has focus', async ({ page }) => {
  await startWalk(page, { x: 2, z: 7.3, yawDeg: 180 });
  const before = (await flat(page, (f) => f.stats())).camera;
  await page.getByLabel('Flat', { exact: true }).focus();
  await page.keyboard.down('ArrowUp');
  await stepWalk(page, 700);
  await page.keyboard.up('ArrowUp');
  expect((await flat(page, (f) => f.stats())).camera).toEqual(before);
  // Control: with focus back on the page the same key does move the camera.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.down('ArrowUp');
  await stepWalk(page, 200);
  await page.keyboard.up('ArrowUp');
  expect((await cameraXZ(page))[1]).toBeGreaterThan(before[2] + 0.1);
});

test('dropping a file on the page loads it', async ({ page }) => {
  test.slow(); // swapping the scene recompiles the lamp/shadow shaders, which is slow on software GL
  await page.evaluate((json) => {
    const dt = new DataTransfer();
    dt.items.add(new File([json], 'dropped.flat.json', { type: 'application/json' }));
    document
      .querySelector('.app')!
      .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, JSON.stringify(sampleFlat));
  // The drop is read asynchronously: wait for the new scene to be committed, then for a frame drawn from it
  // (`whenRendered` only waits for a frame that reflects the stores, so call it after the commit).
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(sampleFlat.name, { timeout: 20_000 });
  await rendered(page);
  expect((await flat(page, (f) => f.stats())).sceneName).toBe(sampleFlat.name);
});

test('a file over the size limit is rejected before it is read', async ({ page }) => {
  const title = await page.getByRole('heading', { level: 1 }).textContent();
  await page.getByTestId('file-input').setInputFiles({
    name: 'huge.flat.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 32),
  });
  await expect(page.getByTestId('error-panel')).toContainText('larger than 5 MB');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title ?? '');
});

test('reloading scenes repeatedly does not leak geometries or shader programs', async ({ page }) => {
  test.slow(); // six scene loads, each recompiling shaders: heavy on software GL
  const samples: { geometries: number; programs: number }[] = [];
  for (let i = 0; i < 6; i++) {
    expect(await loadScene(page, i % 2 === 0 ? charmeFlat : sampleFlat)).toBe(true);
    const { geometries, programs } = await flat(page, (f) => f.stats());
    samples.push({ geometries, programs });
  }
  // Charme loads are #0, #2 and #4: after the warm-up the counts are steady.
  expect(samples[4]!.geometries).toBe(samples[2]!.geometries);
  expect(samples[5]!.geometries).toBe(samples[3]!.geometries);
  expect(samples[4]!.programs).toBeLessThanOrEqual(samples[2]!.programs);
  expect(samples[5]!.programs).toBeLessThanOrEqual(samples[3]!.programs);
  expect(Math.max(...samples.map((s) => s.geometries))).toBeLessThan(30);
});

test.describe('walk controls overlay', () => {
  test('is visible in walk mode with the expected text, hidden in orbit and top', async ({ page }) => {
    const overlay = page.getByTestId('walk-overlay');
    await expect(overlay).toHaveCount(0);
    await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('arrow keys (left stick)');
    await expect(overlay.getByTestId('walk-help-look')).toContainText(/WASD|ZQSD/);
    await expect(overlay).toContainText('drag the view');
    await expect(overlay).toContainText('Shift');
    await expect(overlay).toContainText('Esc');
    for (const name of ['Move forward', 'Move backward', 'Move left', 'Move right', 'Turn left', 'Turn right']) {
      await expect(overlay.getByRole('button', { name })).toBeVisible();
    }
    // The sidebar hint stays.
    await expect(page.locator('.hint', { hasText: 'AZERTY' })).toContainText('arrows to move');
    await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
    await expect(overlay).toHaveCount(0);
    await page.evaluate(() => window.__flat!.setView({ mode: 'orbit' }));
    await expect(overlay).toHaveCount(0);
  });

  test('can be collapsed and the choice is remembered', async ({ page }) => {
    await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
    const overlay = page.getByTestId('walk-overlay');
    await overlay.getByRole('button', { name: 'Hide' }).click();
    await expect(overlay).not.toContainText('ZQSD');
    await page.reload();
    await page.evaluate(() => window.__flat!.ready);
    await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
    await expect(overlay).not.toContainText('ZQSD');
    await overlay.getByRole('button', { name: 'Show controls' }).click();
    await expect(overlay).toContainText('ZQSD');
  });

  test('holding the on-screen up button moves the camera and releasing stops it', async ({ page }) => {
    await startWalk(page, { x: 2, z: 5, yawDeg: 180 }); // looks along +z in the sejour
    const before = await cameraXZ(page);
    const button = page.getByRole('button', { name: 'Move forward' });
    const box = (await button.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await stepWalk(page, 1500); // 1.5 s at 1.4 m/s = 2.1 m, whatever the real frame rate
    await page.mouse.up();
    const after = await cameraXZ(page);
    const walked = Math.hypot(after[0] - before[0], after[1] - before[1]);
    expect(walked).toBeGreaterThan(1.9);
    expect(walked).toBeLessThan(2.3);
    // Released: more frames, no more movement.
    await stepWalk(page, 500);
    expect(await cameraXZ(page)).toEqual(after);
  });

  test('holding ArrowUp into the entry door keeps the camera inside the flat', async ({ page }) => {
    // Entree, facing the entry door on w-landing (x = 7.78, y = 6.115): yaw 180 looks along +z.
    await startWalk(page, { x: 7.78, z: 5.0, yawDeg: 180 });
    await page.keyboard.down('ArrowUp');
    await stepWalk(page, 3000); // 4.2 m of walking: far more than the ~1 m to the door
    await page.keyboard.up('ArrowUp');
    await stepWalk(page, 500);
    const [x, z] = await cameraXZ(page);
    expect(charmeFlat.rooms.some((r) => inPolygon([x, z], r.polygon))).toBe(true);
    expect(z).toBeGreaterThan(5.5); // it did walk towards the door ...
    expect(z).toBeLessThan(6.03); // ... and stopped before it
  });
});
