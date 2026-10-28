/**
 * Camera POV and controls: the person ghost (orbit/top), the stick-like keys (arrows move, physical W/A/S/D look,
 * i.e. ZQSD on AZERTY) in walk, orbit and top, and the keyboard help. Screenshots go to the test output folder.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { flat, openApp, rendered, savePng } from './helpers';


test.beforeEach(async ({ page }) => {
  await openApp(page);
});

const stats = (page: Page) => flat(page, (f) => f.stats());
const ghost = (page: Page) => flat(page, (f) => f.personGhost());
const step = (page: Page, ms: number) => page.evaluate((n) => window.__flat!.stepWalk(n), ms);
/** Holds a key for `ms`, releases it and lets the look ramp come to rest (0.4 s without keys). */
const hold = async (page: Page, code: string, ms: number) => {
  await page.keyboard.down(code);
  await step(page, ms);
  await page.keyboard.up(code);
  await step(page, 400);
};
const manualClock = (page: Page) => page.evaluate(() => window.__flat!.setClock('manual'));

test('orbit shows a translucent ghost at the person height (166 cm), unlit and shadowless', async ({ page }) => {
  // The HD library figure replaces the parametric mannequin once it has loaded.
  await expect.poll(async () => (await ghost(page))?.source, { timeout: 15_000 }).toBe('glb');
  await rendered(page);
  const g = (await ghost(page))!;
  expect(g).not.toBeNull();
  expect(g.heightM).toBeGreaterThan(1.65);
  expect(g.heightM).toBeLessThan(1.67);
  expect(g.opacity).toBeLessThan(0.7);
  expect(g.castShadow).toBe(false);
  expect(g.receiveShadow).toBe(false);
  // The person height setting scales it.
  await page.getByTestId('person-height').fill('180');
  await page.getByTestId('person-height').blur();
  await rendered(page);
  expect((await ghost(page))!.heightM).toBeGreaterThan(1.79);
  expect((await ghost(page))!.heightM).toBeLessThan(1.81);
  await page.getByTestId('person-height').fill('166');
  await page.getByTestId('person-height').blur();
  await rendered(page);
  await savePng(page, test.info().outputPath('orbit-ghost.png'));
  const g0 = (await ghost(page))!;
  await page.evaluate(
    (p) => window.__flat!.setCamera({ mode: 'orbit', target: [p.x, 0.8, p.z], azimuthDeg: 135, elevationDeg: 30, distance: 6, fovDeg: 50 }),
    g0,
  );
  await savePng(page, test.info().outputPath('orbit-ghost-close.png'));
  // Top view shows it too; walk mode does not.
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  expect(await ghost(page)).not.toBeNull();
  await savePng(page, test.info().outputPath('top-ghost.png'));
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  expect(await ghost(page)).toBeNull();
});

test('the parametric mannequin stays when the HD figure is not available', async ({ page }) => {
  await page.route('**/models-hd/person_standing.glb', (route) => route.abort());
  await page.reload();
  await page.evaluate(() => window.__flat!.ready);
  const g = (await ghost(page))!;
  expect(g.source).toBe('parametric');
  expect(g.heightM).toBeGreaterThan(1.65);
  expect(g.heightM).toBeLessThan(1.67);
  await savePng(page, test.info().outputPath('orbit-ghost-parametric.png'));
});

test('"Show person" toggles the ghost', async ({ page }) => {
  await page.getByTestId('show-person').uncheck();
  await rendered(page);
  expect(await ghost(page)).toBeNull();
  await page.getByTestId('show-person').check();
  await rendered(page);
  expect(await ghost(page)).not.toBeNull();
});

test('dragging the ghost sets the walk start, clamped inside the flat; Walk starts there', async ({ page }) => {
  await manualClock(page);
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  await page.evaluate(() => window.__flat!.settleCamera());
  const before = (await ghost(page))!;
  // Towards the middle of the flat (where the default start looks).
  const fx = -Math.sin((before.yawDeg * Math.PI) / 180);
  const fz = -Math.cos((before.yawDeg * Math.PI) / 180);
  const target: [number, number] = [before.x + fx * 0.8, before.z + fz * 0.8];
  const from = await page.evaluate(([x, z]) => window.__flat!.project([x, 0.3, z]), [before.x, before.z] as [number, number]);
  const to = await page.evaluate(([x, z]) => window.__flat!.project([x, 0.3, z]), target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await rendered(page);
  const after = (await ghost(page))!;
  expect(Math.hypot(after.x - target[0], after.z - target[1])).toBeLessThan(0.35);
  expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(0.4);
  // The drag is not a selection or a click-through: nothing got selected.
  // Dragging far outside the flat leaves it inside.
  const out = await page.evaluate(() => window.__flat!.project([-30, 0.3, -30]));
  await page.mouse.move(to.x, to.y);
  await page.mouse.down();
  await page.mouse.move(out.x, out.y, { steps: 6 });
  await page.mouse.up();
  await rendered(page);
  const clamped = (await ghost(page))!;
  const scene = await flat(page, (f) => f.getScene());
  const xs = scene.rooms.flatMap((r) => r.polygon.map((p) => p[0]));
  const zs = scene.rooms.flatMap((r) => r.polygon.map((p) => p[1]));
  expect(clamped.x).toBeGreaterThanOrEqual(Math.min(...xs));
  expect(clamped.x).toBeLessThanOrEqual(Math.max(...xs));
  expect(clamped.z).toBeGreaterThanOrEqual(Math.min(...zs));
  expect(clamped.z).toBeLessThanOrEqual(Math.max(...zs));
  // Walk starts at the ghost.
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await rendered(page);
  const s = await stats(page);
  expect(s.mode).toBe('walk');
  expect(Math.hypot(s.camera[0] - clamped.x, s.camera[2] - clamped.z)).toBeLessThan(0.01);
  expect(s.camera[1]).toBeCloseTo(1.55, 2); // eye height = 166 cm - 11 cm
  // Back in orbit the ghost stands where the walk ended.
  await page.getByRole('button', { name: 'Orbit', exact: true }).click();
  await rendered(page);
  const back = (await ghost(page))!;
  expect(Math.hypot(back.x - clamped.x, back.z - clamped.z)).toBeLessThan(0.01);
});

test('walk: ArrowUp moves forward, KeyA yaws left, KeyW/KeyS pitch (clamped at 80 degrees)', async ({ page }) => {
  await manualClock(page);
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await savePng(page, test.info().outputPath('walk-start.png'));
  const start = await stats(page);
  await hold(page, 'ArrowUp', 600);
  const moved = await stats(page);
  const dist = Math.hypot(moved.camera[0] - start.camera[0], moved.camera[2] - start.camera[2]);
  expect(dist).toBeGreaterThan(0.6);
  expect(dist).toBeLessThan(1.0);
  // Moving along the view direction: the displacement is parallel to the heading.
  const yaw = (start.yawDeg * Math.PI) / 180;
  const dot = ((moved.camera[0] - start.camera[0]) * -Math.sin(yaw) + (moved.camera[2] - start.camera[2]) * -Math.cos(yaw)) / dist;
  expect(dot).toBeGreaterThan(0.99);
  // The look keys do not move the walker.
  const still = await stats(page);
  await hold(page, 'KeyA', 500);
  const turned = await stats(page);
  expect(turned.camera).toEqual(still.camera);
  // KeyA yaws left (three.js yaw grows to the left): 0.5 s held (34 degrees) plus the ease-out (11 degrees).
  const dYaw = ((turned.yawDeg - still.yawDeg + 540) % 360) - 180;
  expect(dYaw).toBeGreaterThan(40);
  expect(dYaw).toBeLessThan(50);
  await hold(page, 'KeyD', 500);
  const back = await stats(page);
  expect(Math.abs(((back.yawDeg - still.yawDeg + 540) % 360) - 180)).toBeLessThan(2);
  // Pitch up with KeyW, clamped to 80 degrees; KeyS comes back down.
  await hold(page, 'KeyW', 2500);
  expect((await stats(page)).pitchDeg).toBeCloseTo(80, 0);
  await hold(page, 'KeyS', 5000);
  expect((await stats(page)).pitchDeg).toBeCloseTo(-80, 0);
  // Left/right arrows strafe.
  await hold(page, 'KeyW', 5000);
  const pre = await stats(page);
  await hold(page, 'ArrowRight', 300);
  const post = await stats(page);
  expect(Math.hypot(post.camera[0] - pre.camera[0], post.camera[2] - pre.camera[2])).toBeGreaterThan(0.2);
  expect(post.yawDeg).toBeCloseTo(pre.yawDeg, 3);
});

test('orbit: W/A/S/D orbit the camera round its target, arrows pan the target', async ({ page }) => {
  await manualClock(page);
  await page.evaluate(() => window.__flat!.settleCamera());
  const a = await stats(page);
  await hold(page, 'KeyD', 600);
  const b = await stats(page);
  expect(Math.hypot(b.camera[0] - a.camera[0], b.camera[2] - a.camera[2])).toBeGreaterThan(0.3);
  expect(b.camera[1]).toBeCloseTo(a.camera[1], 2); // yaw only: the height is unchanged
  await hold(page, 'KeyW', 500);
  const c = await stats(page);
  expect(c.camera[1]).toBeLessThan(b.camera[1] - 0.05); // look up: the camera sinks
  await hold(page, 'KeyS', 1500);
  expect((await stats(page)).camera[1]).toBeGreaterThan(c.camera[1]);
  // Arrows pan: the camera translates without turning (same height, same heading).
  const d = await stats(page);
  await hold(page, 'ArrowUp', 500);
  const e = await stats(page);
  expect(Math.hypot(e.camera[0] - d.camera[0], e.camera[2] - d.camera[2])).toBeGreaterThan(0.3);
  expect(e.camera[1]).toBeCloseTo(d.camera[1], 2);
  expect(e.yawDeg).toBeCloseTo(d.yawDeg, 1);
  await savePng(page, test.info().outputPath('orbit-panned.png'));
});

test('a selected item keeps the arrows (nudge); without selection the arrows move the camera', async ({ page }) => {
  await manualClock(page);
  expect(await page.evaluate(() => window.__flat!.select('tv-sejour'))).toBe(true);
  await rendered(page);
  await page.evaluate(() => window.__flat!.settleCamera());
  const itemX = () => flat(page, (f) => f.getScene().items.find((i) => i.id === 'tv-sejour')!.position[0]);
  const x0 = await itemX();
  const cam0 = (await stats(page)).camera;
  await page.locator('canvas').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(itemX).toBeCloseTo(x0 + 0.01, 4);
  await hold(page, 'ArrowUp', 400);
  expect((await stats(page)).camera).toEqual(cam0);
  // The look keys still orbit with an item selected.
  await hold(page, 'KeyD', 400);
  expect((await stats(page)).camera).not.toEqual(cam0);
  // No selection: the arrows pan.
  await page.evaluate(() => window.__flat!.select(null));
  await rendered(page);
  const cam1 = (await stats(page)).camera;
  const x1 = await itemX();
  await hold(page, 'ArrowUp', 400);
  expect((await stats(page)).camera).not.toEqual(cam1);
  expect(await itemX()).toBe(x1);
});

test('typing in an input does not move the camera, in orbit and in walk', async ({ page }) => {
  await manualClock(page);
  await page.evaluate(() => window.__flat!.settleCamera());
  const field = page.getByTestId('person-height');
  await field.focus();
  const orbit = await stats(page);
  for (const code of ['ArrowLeft', 'ArrowUp', 'KeyD', 'KeyW']) await hold(page, code, 400);
  expect((await stats(page)).camera).toEqual(orbit.camera);
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await field.focus();
  const walk = await stats(page);
  for (const code of ['ArrowUp', 'KeyA', 'KeyW']) await hold(page, code, 400);
  const after = await stats(page);
  // (ArrowUp in the number field changes its value, hence the eye height: compare the plan position.)
  expect([after.camera[0], after.camera[2]]).toEqual([walk.camera[0], walk.camera[2]]);
  expect(after.yawDeg).toBe(walk.yawDeg);
  expect(after.pitchDeg).toBe(walk.pitchDeg);
});

test('the help shows ZQSD on an AZERTY layout and both labels when the layout is unknown', async ({ page, browser }) => {
  test.slow();
  // Unknown layout (no keyboard layout map in the browser): both labels.
  await page.addInitScript(() => Object.defineProperty(navigator, 'keyboard', { value: undefined, configurable: true }));
  await openApp(page);
  await expect(page.getByTestId('cam-help')).toBeVisible();
  const expectedBoth = /ZQSD \/ WASD/;
  await expect(page.getByTestId('cam-help-look')).toHaveText(expectedBoth);
  await page.screenshot({ path: test.info().outputPath('help-overlay.png') });
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await expect(page.getByTestId('walk-help-look')).toHaveText(expectedBoth);
  await page.screenshot({ path: test.info().outputPath('help-overlay-walk.png') });
  // A French keyboard.
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1280, height: 800 } });
  const fr = await context.newPage();
  await fr.addInitScript(() => {
    Object.defineProperty(navigator, 'keyboard', { value: { getLayoutMap: async () => new Map([['KeyW', 'z'], ['KeyA', 'q']]) }, configurable: true });
  });
  await openApp(fr);
  await expect(fr.getByTestId('cam-help-look')).toHaveText('ZQSD');
  await fr.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await expect(fr.getByTestId('walk-help-look')).toHaveText('ZQSD');
  await fr.screenshot({ path: test.info().outputPath('help-overlay-azerty.png') });
  await context.close();
});
