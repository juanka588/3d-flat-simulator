import { expect, test } from '@playwright/test';
import { charmeFlat, flat, loadScene, openApp, polygonArea, rendered, sampleFlat } from './helpers';

const MAX_DRAW_CALLS = 40;
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

  const room = charmeFlat.rooms.find((r) => r.id === 'ch1')!;
  const centroid = room.polygon.reduce<[number, number]>((c, p) => [c[0] + p[0] / 4, c[1] + p[1] / 4], [0, 0]);
  const roomPoint = await page.evaluate(([x, z]) => window.__flat!.project([x!, 0, z!]), centroid);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, roomPoint)).toBe('CANVAS');
  await page.mouse.click(roomPoint.x, roomPoint.y);
  await expect(properties.getByRole('heading')).toHaveText(room.name);
  await expect(properties).toContainText(`${polygonArea(room.polygon).toFixed(2)} m²`);

  // Clicking empty space deselects.
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

function inside(polygon: [number, number][], [x, y]: [number, number]): boolean {
  let result = false;
  polygon.forEach(([x1, y1], i) => {
    const [x2, y2] = polygon[(i + 1) % polygon.length]!;
    if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) result = !result;
  });
  return result;
}

test('walking into a wall stops at the wall and stays inside the room', async ({ page }) => {
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  // Séjour, facing the south wall (no openings): forward = (-sin yaw, -cos yaw), so yaw 180 looks along +z.
  const south = charmeFlat.walls.find((w) => w.id === 'w-south')!;
  const sejour = charmeFlat.rooms.find((r) => r.id === 'sejour')!;
  await page.evaluate(() => window.__flat!.setWalkPose({ x: 2, z: 7.3, yawDeg: 180 }));

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyW');
  await rendered(page);

  const [x, , z] = (await flat(page, (f) => f.stats())).camera;
  const wallZ = south.start[1];
  expect(inside(sejour.polygon, [x, z])).toBe(true);
  // Moved towards the wall (not stuck at the start) ...
  expect(z).toBeGreaterThan(7.6);
  // ... but never closer than 0.2 m to the wall's near face.
  expect(wallZ - south.thickness / 2 - z).toBeGreaterThanOrEqual(0.2);
});

test('walk keys are ignored while a form control has focus', async ({ page }) => {
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await page.evaluate(() => window.__flat!.setWalkPose({ x: 2, z: 7.3, yawDeg: 180 }));
  const before = (await flat(page, (f) => f.stats())).camera;
  await page.getByLabel('Flat', { exact: true }).focus();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyW');
  await rendered(page);
  expect((await flat(page, (f) => f.stats())).camera).toEqual(before);
});

test('dropping a file on the page loads it', async ({ page }) => {
  await page.evaluate((json) => {
    const dt = new DataTransfer();
    dt.items.add(new File([json], 'dropped.flat.json', { type: 'application/json' }));
    document
      .querySelector('.app')!
      .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, JSON.stringify(sampleFlat));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(sampleFlat.name);
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
