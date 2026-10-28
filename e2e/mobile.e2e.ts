/**
 * Phone behaviour: drawer menu, full-screen canvas, bottom sheet, touch gestures and walk controls.
 * Runs only on the mobile projects (iPhone 13 and Pixel 7 emulation, see playwright.config.ts).
 *
 * Touches: gestures go through real touch input (CDP `Input.dispatchTouchEvent`) on Chromium, so the
 * browser's own touch handling (`touch-action`, pointer events, click synthesis) is part of what is
 * tested. In WebKit (optional "mobile-safari" project) they fall back to synthetic touch pointer events.
 *
 * Screenshots: set E2E_SHOTS=/tmp to also save them (mobile-<project>-*.png).
 */
import { expect, test } from '@playwright/test';
import type { CDPSession, Locator, Page, TestInfo } from '@playwright/test';
import { charmeFlat, flat, openApp, rendered } from './helpers';

const SHOTS = process.env.E2E_SHOTS;

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/mobile-${info.project.name.replace('mobile-', '')}-${name}.png` });
}

interface Point {
  x: number;
  y: number;
  id?: number;
}

/** Multi-touch input: real touch events on Chromium, synthetic touch pointer events elsewhere. */
class Touch {
  private cdp: CDPSession | null = null;
  constructor(private readonly page: Page) {}

  static async create(page: Page): Promise<Touch> {
    const t = new Touch(page);
    if (page.context().browser()?.browserType().name() === 'chromium') t.cdp = await page.context().newCDPSession(page);
    return t;
  }

  private async send(type: 'touchStart' | 'touchMove' | 'touchEnd', points: Point[]): Promise<void> {
    const touchPoints = points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i }));
    if (this.cdp) {
      await this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
      return;
    }
    await this.page.evaluate(
      ({ kind, pts }) => {
        for (const p of pts) {
          const target = document.elementFromPoint(p.x, p.y) ?? document.body;
          const name = kind === 'touchStart' ? 'pointerdown' : kind === 'touchMove' ? 'pointermove' : 'pointerup';
          target.dispatchEvent(
            new PointerEvent(name, { pointerId: p.id + 1, pointerType: 'touch', isPrimary: p.id === 0, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, buttons: 1 }),
          );
        }
      },
      { kind: type, pts: touchPoints },
    );
  }

  down(points: Point[]) {
    return this.send('touchStart', points);
  }
  move(points: Point[]) {
    return this.send('touchMove', points);
  }
  async up(points: Point[] = []) {
    // CDP lifts the fingers that are not listed; the synthetic fallback needs them named.
    await this.send('touchEnd', this.cdp ? [] : points);
  }

  /** Moves the fingers in `steps` equal steps from one set of positions to another, then lifts them. */
  async drag(from: Point[], to: Point[], steps = 8): Promise<void> {
    await this.down(from);
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      await this.move(from.map((p, j) => ({ x: p.x + (to[j]!.x - p.x) * k, y: p.y + (to[j]!.y - p.y) * k, id: p.id })));
    }
    await this.up(to);
  }
}

async function centre(locator: Locator): Promise<Point> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const menuButton = (page: Page) => page.getByRole('button', { name: 'Menu' });
const sidebar = (page: Page) => page.locator('#sidebar');

/** Walk mode with the manual clock, so movement is exactly what `stepWalk` integrates. */
async function startWalk(page: Page, pose: { x: number; z: number; yawDeg: number }): Promise<void> {
  await page.evaluate(() => window.__flat!.setClock('manual'));
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await page.evaluate((p) => window.__flat!.setWalkPose(p), pose);
}

const stats = (page: Page) => flat(page, (f) => f.stats());
/** An angle difference wrapped to [-180, 180). */
const wrap = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
const dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]!));

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('the drawer starts closed and the canvas fills the viewport', async ({ page }, info) => {
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar(page)).toBeHidden();
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const box = (await page.locator('canvas').boundingBox())!;
  expect(Math.abs(box.x)).toBeLessThan(1);
  expect(Math.abs(box.y)).toBeLessThan(1);
  expect(Math.abs(box.width - vp.w)).toBeLessThan(1);
  expect(Math.abs(box.height - vp.h)).toBeLessThan(1);
  await shot(page, info, 'closed');
});

test('the menu button opens and closes the drawer; Esc and a backdrop tap close it', async ({ page }, info) => {
  const menu = menuButton(page);
  await menu.tap();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar(page)).toBeVisible();
  await expect(sidebar(page)).toHaveAttribute('role', 'dialog');
  await expect(sidebar(page)).toBeFocused(); // focus moved into the drawer
  await expect(page.getByRole('button', { name: 'Orbit', exact: true })).toBeVisible();
  // The canvas is still full-screen underneath (the drawer is an overlay, nothing is resized).
  const vp = await page.evaluate(() => window.innerWidth);
  expect((await page.locator('canvas').boundingBox())!.width).toBeCloseTo(vp, 0);
  await shot(page, info, 'drawer');

  await menu.tap();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar(page)).toBeHidden();

  await menu.tap();
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sidebar(page)).toBeHidden();
  await expect(menu).toBeFocused(); // focus returns to the button that opened it

  await menu.tap();
  await expect(sidebar(page)).toBeVisible();
  await expect.poll(async () => (await sidebar(page).boundingBox())!.x).toBe(0); // slide-in finished
  const drawer = (await sidebar(page).boundingBox())!;
  await page.touchscreen.tap(drawer.x + drawer.width + 20, 300); // on the backdrop, right of the drawer
  await expect(sidebar(page)).toBeHidden();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
});

test('choosing a camera mode closes the drawer', async ({ page }) => {
  await menuButton(page).tap();
  await page.getByRole('button', { name: 'Top', exact: true }).tap();
  await expect(sidebar(page)).toBeHidden();
  await rendered(page);
  expect((await stats(page)).mode).toBe('top');
});

test('inputs are at least 16 px and controls at least 44 px, so iOS does not zoom and thumbs can hit them', async ({ page }) => {
  await menuButton(page).tap();
  const small = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('#sidebar input:not([type=checkbox]):not([type=range]):not([hidden]), #sidebar select')) {
      if (parseFloat(getComputedStyle(el).fontSize) < 16) bad.push(`${el.tagName}.${el.getAttribute('type')} ${getComputedStyle(el).fontSize}`);
    }
    return bad;
  });
  expect(small).toEqual([]);
  expect(await page.getByLabel('Date').evaluate((el) => (el as HTMLInputElement).type)).toBe('date');
  expect(await page.getByLabel('Exact time').evaluate((el) => (el as HTMLInputElement).type)).toBe('time');
  for (const l of [menuButton(page), page.getByRole('button', { name: 'Orbit', exact: true }), page.getByRole('button', { name: 'Walk', exact: true }), page.getByRole('button', { name: 'Now' })]) {
    const box = (await l.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(43.5);
    expect(box.width).toBeGreaterThanOrEqual(43.5);
  }
});

test('the page cannot scroll or zoom sideways; the canvas owns the touch gestures', async ({ page }) => {
  const overflow = () => page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth && document.scrollingElement!.scrollHeight <= window.innerHeight + 1);
  expect(await overflow()).toBe(true);
  await menuButton(page).tap();
  expect(await overflow()).toBe(true);
  await page.keyboard.press('Escape');
  await startWalk(page, { x: 2, z: 5, yawDeg: 180 });
  expect(await overflow()).toBe(true);
  expect(await page.locator('canvas').evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  expect(await page.locator('meta[name=viewport]').getAttribute('content')).toBe('width=device-width, initial-scale=1, viewport-fit=cover');
});

test('tapping a wall selects it and opens a compact bottom sheet that expands on demand', async ({ page }, info) => {
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  const sheet = page.getByTestId('properties');
  await expect(sheet).toHaveCount(0); // nothing selected: nothing in the way
  const south = charmeFlat.walls.find((w) => w.id === 'w-south')!;
  const mid = { x: (south.start[0] + south.end[0]) / 2, z: (south.start[1] + south.end[1]) / 2 };
  const at = await page.evaluate((m) => window.__flat!.project([m.x, 2.5, m.z]), mid);
  await page.touchscreen.tap(at.x, at.y);
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Wall w-south');
  const vp = page.viewportSize()!;
  const compact = (await sheet.boundingBox())!;
  expect(compact.y + compact.height).toBeGreaterThan(vp.height - 2); // docked to the bottom edge
  expect(compact.height).toBeLessThan(vp.height * 0.46); // compact: summary and the Finish button only
  await expect(page.getByTestId('sheet-summary')).toBeVisible();
  await expect(sheet.getByText('Net area')).toBeHidden();
  await shot(page, info, 'sheet');

  // The handle expands the sheet to about 60-70% of the viewport (tall content scrolls inside it).
  const handle = sheet.locator('.sheet-handle');
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await handle.tap();
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  await expect(sheet.getByText('Net area')).toBeVisible();
  const expanded = (await sheet.boundingBox())!;
  expect(expanded.height).toBeGreaterThan(compact.height);
  expect(expanded.height).toBeLessThanOrEqual(vp.height * 0.7);
  await handle.tap();
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  expect((await sheet.boundingBox())!.height).toBeLessThan(vp.height * 0.46);

  // A selection does not cover the walk controls: the sheet is not shown in walk mode.
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await expect(sheet).toHaveCount(0);
});

test('walk mode: the touch buttons are big, thumb-placed, and move and turn the camera', async ({ page }, info) => {
  await startWalk(page, { x: 2, z: 5, yawDeg: 180 }); // séjour, looking along +z
  const overlay = page.getByTestId('walk-overlay');
  await expect(overlay).toBeVisible();
  const vp = page.viewportSize()!;
  const forward = page.getByRole('button', { name: 'Move forward' });
  for (const name of ['Move forward', 'Move backward', 'Move left', 'Move right', 'Turn left', 'Turn right']) {
    const box = (await page.getByRole('button', { name }).boundingBox())!;
    expect(box.width, name).toBeGreaterThanOrEqual(44);
    expect(box.height, name).toBeGreaterThanOrEqual(44);
    expect(box.y + box.height, name).toBeLessThanOrEqual(vp.height);
  }
  // Move pad bottom-left, turn buttons bottom-right.
  expect((await centre(forward)).x).toBeLessThan(vp.width / 2);
  expect((await centre(page.getByRole('button', { name: 'Turn right' }))).x).toBeGreaterThan(vp.width / 2);
  // The middle of the screen is free for drag-to-look.
  const middle = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, { x: vp.width / 2, y: vp.height / 2 });
  expect(middle).toBe('CANVAS');

  const touch = await Touch.create(page);
  const before = (await stats(page)).camera;
  const f = await centre(forward);
  await touch.down([{ ...f, id: 0 }]);
  await page.evaluate(() => window.__flat!.stepWalk(1500)); // 1.5 s at 1.4 m/s
  await touch.up([{ ...f, id: 0 }]);
  const after = (await stats(page)).camera;
  expect(after[2] - before[2]).toBeGreaterThan(1.9); // looking along +z: walked ~2.1 m forward
  expect(after[2] - before[2]).toBeLessThan(2.3);
  expect(after[1]).toBeCloseTo(before[1], 5);
  await page.evaluate(() => window.__flat!.stepWalk(300));
  expect((await stats(page)).camera).toEqual(after); // released: stops

  const yaw0 = (await stats(page)).yawDeg;
  const t = await centre(page.getByRole('button', { name: 'Turn left' }));
  await touch.down([{ ...t, id: 0 }]);
  await page.evaluate(() => window.__flat!.stepWalk(1000)); // 1.6 rad/s
  await touch.up([{ ...t, id: 0 }]);
  const turned = wrap((await stats(page)).yawDeg - yaw0);
  expect(turned).toBeGreaterThan(80);
  expect(turned).toBeLessThan(100);
  await page.evaluate(() => window.__flat!.setWalkPose({ x: 2.45, z: 5.3, yawDeg: 0 })); // a good view for the screenshot
  await rendered(page);
  await shot(page, info, 'walk');
});

test('walk mode: dragging a finger on the view looks around (no pointer lock needed)', async ({ page }) => {
  await startWalk(page, { x: 2, z: 5, yawDeg: 180 });
  const touch = await Touch.create(page);
  const vp = page.viewportSize()!;
  const y = vp.height * 0.4;
  const yaw0 = (await stats(page)).yawDeg;
  await touch.drag([{ x: vp.width * 0.3, y }], [{ x: vp.width * 0.7, y }]);
  await rendered(page);
  const dragRight = wrap((await stats(page)).yawDeg - yaw0);
  // 0.4 * 390 = 156 px at 0.005 rad/px = 0.78 rad: dragging right turns the view right (yaw decreases).
  expect(dragRight).toBeLessThan(-30);
  expect(dragRight).toBeGreaterThan(-60);
  const yaw1 = (await stats(page)).yawDeg;
  await touch.drag([{ x: vp.width * 0.7, y }], [{ x: vp.width * 0.5, y }]);
  await rendered(page);
  expect(wrap((await stats(page)).yawDeg - yaw1)).toBeGreaterThan(10);
});

test('walk mode: holding forward with one thumb while dragging with the other works', async ({ page }) => {
  await startWalk(page, { x: 2, z: 5, yawDeg: 180 });
  const touch = await Touch.create(page);
  const vp = page.viewportSize()!;
  const f = await centre(page.getByRole('button', { name: 'Move forward' }));
  const before = await stats(page);
  await touch.down([{ ...f, id: 0 }]);
  await touch.down([
    { ...f, id: 0 },
    { x: vp.width * 0.4, y: vp.height * 0.4, id: 1 },
  ]);
  await touch.move([
    { ...f, id: 0 },
    { x: vp.width * 0.6, y: vp.height * 0.4, id: 1 },
  ]);
  await page.evaluate(() => window.__flat!.stepWalk(500));
  await touch.up([
    { ...f, id: 0 },
    { x: vp.width * 0.6, y: vp.height * 0.4, id: 1 },
  ]);
  const after = await stats(page);
  expect(dist(after.camera, before.camera)).toBeGreaterThan(0.5);
  expect(Math.abs(wrap(after.yawDeg - before.yawDeg))).toBeGreaterThan(5);
});

test('the walk camera uses a wide-enough fov for the portrait screen and the 166 cm eye height', async ({ page }) => {
  await startWalk(page, { x: 2, z: 5, yawDeg: 180 });
  const s = await stats(page);
  const box = (await page.locator('canvas').boundingBox())!;
  const aspect = box.width / box.height;
  expect(aspect).toBeLessThan(1);
  const expected = Math.min(100, Math.max(50, ((2 * Math.atan(Math.tan((37.5 * Math.PI) / 180) / aspect)) * 180) / Math.PI));
  expect(s.fov).toBeCloseTo(expected, 3);
  expect(s.fov).toBeGreaterThan(50);
  expect(s.camera[1]).toBeCloseTo(1.55, 3);
});

test('the render budget is lowered on phones', async ({ page }) => {
  expect((await stats(page)).dpr).toBeLessThanOrEqual(1.5);
});

test('orbit: one finger rotates, two fingers pinch-zoom', async ({ page, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'needs real multi-touch input');
  const touch = await Touch.create(page);
  const vp = page.viewportSize()!;
  const cx = vp.width / 2;
  const cy = vp.height / 2;
  const flatCentre = [4.3, 1.2, 4.1];

  const start = (await stats(page)).camera;
  await touch.drag([{ x: cx - 60, y: cy }], [{ x: cx + 60, y: cy }]);
  await rendered(page);
  const rotated = (await stats(page)).camera;
  expect(dist(rotated, start)).toBeGreaterThan(1); // orbited around the flat ...
  expect(Math.abs(dist(rotated, flatCentre) - dist(start, flatCentre))).toBeLessThan(dist(start, flatCentre) * 0.35); // ... at about the same distance

  const before = dist((await stats(page)).camera, flatCentre);
  await touch.drag(
    [{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }],
    [{ x: cx - 110, y: cy }, { x: cx + 110, y: cy }],
  );
  await rendered(page);
  expect(dist((await stats(page)).camera, flatCentre)).toBeLessThan(before * 0.85);
  await shot(page, info, 'orbit');
});

test('top view: one finger pans, two fingers pinch-zoom', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'needs real multi-touch input');
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  const touch = await Touch.create(page);
  const vp = page.viewportSize()!;
  const cx = vp.width / 2;
  const cy = vp.height / 2;
  const start = (await stats(page)).camera;
  await touch.drag([{ x: cx, y: cy }], [{ x: cx + 80, y: cy + 60 }]);
  await rendered(page);
  const panned = (await stats(page)).camera;
  expect(Math.hypot(panned[0] - start[0], panned[2] - start[2])).toBeGreaterThan(0.3);
  expect(panned[1]).toBeCloseTo(start[1], 3); // still looking straight down

  const before = (await stats(page)).camera;
  await touch.drag(
    [{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }],
    [{ x: cx - 100, y: cy }, { x: cx + 100, y: cy }],
  );
  await rendered(page);
  // Zoom changes the ortho scale, not the camera position along the view axis; the pan stays sane.
  expect(Math.hypot((await stats(page)).camera[0] - before[0], (await stats(page)).camera[2] - before[2])).toBeLessThan(3);
});
