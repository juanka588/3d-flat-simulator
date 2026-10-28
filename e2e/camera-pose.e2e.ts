/**
 * M4.8: `__flat.setCamera` / `setViewport`, deterministic captures, user interaction handing the camera
 * back, and the server view channel ("Follow assistant view"). Desktop chromium only.
 *
 * Heading convention under test (see apps/web/src/viewer/camera-pose.ts): `WalkPose.headingDeg` is
 * clockwise from plan-up; `stats().yawDeg` is the three.js yaw (counter-clockwise positive), so
 * `yawDeg = -headingDeg`, and `stats().headingDeg` reports the clockwise value.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { CameraPose } from '../packages/scene/src/index';
import { charmeFlat, flat, loadScene, openApp, sampleFlat } from './helpers';

const RAD = Math.PI / 180;
const ORBIT: CameraPose = { mode: 'orbit', target: [3, 1, 5], azimuthDeg: 30, elevationDeg: 40, distance: 12, fovDeg: 45 };
const WALK: CameraPose = { mode: 'walk', position: [2, 5], eyeHeight: 1.55, headingDeg: 37, pitchDeg: 10, fovDeg: 60 };
const TOP: CameraPose = { mode: 'top', center: [3, 5], halfHeight: 6, rotationDeg: 20 };

const stats = (page: Page) => page.evaluate(() => window.__flat!.stats());
const setCamera = (page: Page, pose: CameraPose) => page.evaluate((p) => window.__flat!.setCamera(p), pose);
const capture = (page: Page) => page.evaluate(() => window.__flat!.capture());

/** Angle difference in (-180, 180]. */
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

test.describe('camera pose', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('orbit pose: camera position, fov and mode match', async ({ page }) => {
    await setCamera(page, ORBIT);
    const s = await stats(page);
    const el = ORBIT.mode === 'orbit' ? ORBIT.elevationDeg * RAD : 0;
    const az = 30 * RAD;
    const flatDist = Math.cos(el) * 12;
    expect(s.mode).toBe('orbit');
    expect(s.camera[0]).toBeCloseTo(3 + flatDist * Math.sin(az), 2);
    expect(s.camera[1]).toBeCloseTo(1 + Math.sin(el) * 12, 2);
    expect(s.camera[2]).toBeCloseTo(5 - flatDist * Math.cos(az), 2);
    expect(s.fov).toBeCloseTo(45, 2);
    expect(s.pose).toMatchObject({ mode: 'orbit', distance: 12 });
    // The camera looks at the target: it projects to the middle of the canvas.
    const c = await page.evaluate(() => window.__flat!.project([3, 1, 5]));
    const box = (await page.locator('canvas').boundingBox())!;
    expect(c.x).toBeCloseTo(box.x + box.width / 2, 0);
    expect(c.y).toBeCloseTo(box.y + box.height / 2, 0);
  });

  test('orbit pose beyond the user zoom limits is followed exactly, and nothing drifts afterwards', async ({ page }) => {
    const far: CameraPose = { ...ORBIT, distance: 150 } as CameraPose;
    await setCamera(page, far);
    const a = await stats(page);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__flat!.settleCamera());
    const b = await stats(page);
    expect(Math.hypot(a.camera[0] - 3, a.camera[1] - 1, a.camera[2] - 5)).toBeCloseTo(150, 1);
    b.camera.forEach((v, i) => expect(v).toBeCloseTo(a.camera[i]!, 6));
  });

  test('walk pose: position, eye height, heading (clockwise) and fov match; yawDeg is its negative', async ({ page }) => {
    await setCamera(page, WALK);
    const s = await stats(page);
    expect(s.mode).toBe('walk');
    expect(s.camera[0]).toBeCloseTo(2, 2);
    expect(s.camera[1]).toBeCloseTo(1.55, 2);
    expect(s.camera[2]).toBeCloseTo(5, 2);
    expect(s.fov).toBeCloseTo(60, 2);
    expect(s.headingDeg).toBeCloseTo(37, 2);
    expect(s.yawDeg).toBeCloseTo(-37, 2);
    // Heading 90 looks towards +x: a point 1 m east of the eye is straight ahead (centre column).
    await setCamera(page, { ...WALK, headingDeg: 90, pitchDeg: 0 } as CameraPose);
    const ahead = await page.evaluate(() => window.__flat!.project([3, 1.55, 5]));
    const box = (await page.locator('canvas').boundingBox())!;
    expect(ahead.x).toBeCloseTo(box.x + box.width / 2, 0);
    expect(wrap((await stats(page)).yawDeg + 90)).toBeCloseTo(0, 2);
  });

  test('top pose: centre, zoom (half height) and rotation match', async ({ page }) => {
    await setCamera(page, TOP);
    const s = await stats(page);
    expect(s.mode).toBe('top');
    expect(s.camera[0]).toBeCloseTo(3, 2);
    expect(s.camera[2]).toBeCloseTo(5, 2);
    expect(s.fov).toBe(0);
    expect(s.yawDeg).toBeCloseTo(20, 2);
    const box = (await page.locator('canvas').boundingBox())!;
    const c = await page.evaluate(() => window.__flat!.project([3, 0, 5]));
    expect(c.x).toBeCloseTo(box.x + box.width / 2, 0);
    expect(c.y).toBeCloseTo(box.y + box.height / 2, 0);
    // halfHeight metres from the centre, along the screen-up direction (plan rotated 20 deg clockwise),
    // is the top edge of the canvas.
    const r = 20 * RAD;
    const up = await page.evaluate(([x, z]) => window.__flat!.project([x!, 0, z!]), [3 - 6 * Math.sin(r), 5 - 6 * Math.cos(r)]);
    expect(up.x).toBeCloseTo(box.x + box.width / 2, 0);
    expect(up.y).toBeCloseTo(box.y, 0);
  });

  test('a pose selects its mode, from any mode', async ({ page }) => {
    for (const pose of [TOP, WALK, ORBIT, WALK, TOP]) {
      await setCamera(page, pose);
      const s = await stats(page);
      expect(s.mode).toBe(pose.mode);
      expect(s.pose).toMatchObject({ mode: pose.mode });
    }
  });

  test('settleCamera after setCamera does not move the camera', async ({ page }) => {
    for (const pose of [ORBIT, TOP]) {
      await setCamera(page, pose);
      const before = await stats(page);
      await page.evaluate(() => window.__flat!.settleCamera());
      const after = await stats(page);
      // (three's controls re-derive the position every frame: float noise of ~1e-15, nothing visible)
      after.camera.forEach((v, i) => expect(v).toBeCloseTo(before.camera[i]!, 6));
      expect(after.yawDeg).toBeCloseTo(before.yawDeg, 6);
      expect(after.pose).not.toBeNull();
    }
  });

  test('loadScene then setCamera leaves the camera at the pose (and a later load keeps following it)', async ({ page }) => {
    expect(await loadScene(page, charmeFlat)).toBe(true);
    await setCamera(page, ORBIT);
    const a = await stats(page);
    expect(a.fov).toBeCloseTo(45, 2);
    expect(a.pose).not.toBeNull();
    expect(await loadScene(page, sampleFlat)).toBe(true);
    const b = await stats(page);
    expect(b.camera[0]).toBeCloseTo(a.camera[0], 2);
    expect(b.camera[1]).toBeCloseTo(a.camera[1], 2);
    expect(b.camera[2]).toBeCloseTo(a.camera[2], 2);
  });

  test('repeated captures with the same scene, pose, lighting and viewport are identical', async ({ page }) => {
    await page.evaluate(() => window.__flat!.setViewport({ width: 640, height: 480, dpr: 1 }));
    await page.evaluate(() => window.__flat!.setLighting({ date: '2026-12-21', time: '16:30' }));
    for (const pose of [ORBIT, WALK, TOP]) {
      await setCamera(page, pose);
      const first = await capture(page);
      await page.waitForTimeout(300);
      expect(await capture(page)).toBe(first);
      await page.evaluate(() => window.__flat!.settleCamera());
      expect(await capture(page)).toBe(first);
      await setCamera(page, pose); // a fresh application of the same pose
      expect(await capture(page)).toBe(first);
    }
  });

  test('setViewport gives a capture of exactly the requested size, independent of the window', async ({ page }) => {
    await setCamera(page, ORBIT);
    await page.evaluate(() => window.__flat!.setViewport({ width: 800, height: 600, dpr: 1 }));
    const png = await capture(page);
    const buf = Buffer.from(png.split(',')[1]!, 'base64');
    expect(buf.readUInt32BE(16)).toBe(800); // IHDR width
    expect(buf.readUInt32BE(20)).toBe(600);
    expect((await stats(page)).canvasSize).toEqual([800, 600]);
    // Same pose, still followed after the resize.
    expect((await stats(page)).pose).not.toBeNull();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.evaluate(() => window.__flat!.whenRendered());
    expect((await stats(page)).canvasSize).toEqual([800, 600]);
    // A different viewport and a pixel ratio.
    await page.evaluate(() => window.__flat!.setViewport({ width: 320, height: 200, dpr: 2 }));
    const s = await stats(page);
    expect(s.canvasSize).toEqual([640, 400]);
    expect(s.dpr).toBe(2);
  });

  test('a top pose keeps its half height when the viewport changes', async ({ page }) => {
    await setCamera(page, TOP);
    await page.evaluate(() => window.__flat!.setViewport({ width: 500, height: 900, dpr: 1 }));
    const box = (await page.locator('canvas').boundingBox())!;
    expect(box.height).toBeCloseTo(900, 0);
    const r = 20 * RAD;
    const up = await page.evaluate(([x, z]) => window.__flat!.project([x!, 0, z!]), [3 - 6 * Math.sin(r), 5 - 6 * Math.cos(r)]);
    expect(up.y).toBeCloseTo(box.y, 0);
  });

  test('an invalid viewport or pose is rejected', async ({ page }) => {
    await expect(page.evaluate(() => window.__flat!.setViewport({ width: 0, height: 600, dpr: 1 }))).rejects.toThrow(/invalid viewport/);
    await expect(page.evaluate(() => window.__flat!.setCamera({ mode: 'orbit' } as never))).rejects.toThrow();
  });

  test('user interaction hands the camera back: orbit drag, wheel and walk keys clear the pose', async ({ page }) => {
    await setCamera(page, ORBIT);
    const box = (await page.locator('canvas').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 20, { steps: 5 });
    await page.mouse.up();
    await page.evaluate(() => window.__flat!.settleCamera());
    const s = await stats(page);
    expect(s.pose).toBeNull();
    expect(s.mode).toBe('orbit');
    expect(Math.hypot(s.camera[0] - 3, s.camera[2] - 5)).toBeGreaterThan(0); // moved off the pose, user-driven now

    await setCamera(page, TOP);
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -120);
    await page.evaluate(() => window.__flat!.whenRendered());
    expect((await stats(page)).pose).toBeNull();

    await setCamera(page, WALK);
    await page.evaluate(() => window.__flat!.setClock('manual'));
    await page.keyboard.down('ArrowUp');
    await page.evaluate(() => window.__flat!.stepWalk(500));
    await page.keyboard.up('ArrowUp');
    const walked = await stats(page);
    expect(walked.pose).toBeNull();
    expect(walked.mode).toBe('walk');
    expect(Math.hypot(walked.camera[0] - 2, walked.camera[2] - 5)).toBeGreaterThan(0.2);
  });

  test('choosing a mode in the toolbar drops the pose', async ({ page }) => {
    await setCamera(page, TOP);
    await page.getByRole('button', { name: 'Orbit' }).click();
    await page.evaluate(() => window.__flat!.whenRendered());
    const s = await stats(page);
    expect(s.pose).toBeNull();
    expect(s.mode).toBe('orbit');
  });

  test('?test&w=&h=&dpr= sets the first-paint viewport', async ({ page }) => {
    await page.goto('/?test&w=700&h=500&dpr=1');
    await page.evaluate(() => window.__flat!.ready);
    expect((await stats(page)).canvasSize).toEqual([700, 500]);
    await page.goto('/?test&w=300&h=200&dpr=2');
    await page.evaluate(() => window.__flat!.ready);
    expect((await stats(page)).canvasSize).toEqual([600, 400]);
  });

  test('without a forced viewport the canvas fills the stage and follows the window', async ({ page }) => {
    const stage = await page.locator('main.stage').boundingBox();
    const canvas = await page.locator('canvas').boundingBox();
    expect(canvas!.width).toBeCloseTo(stage!.width, 0);
    expect(canvas!.height).toBeCloseTo(stage!.height, 0);
    await page.setViewportSize({ width: 1000, height: 640 });
    await page.evaluate(() => window.__flat!.whenRendered());
    const after = await page.locator('canvas').boundingBox();
    expect(after!.width).toBeCloseTo(1000 - 300, 0);
  });

  test('steady frames with a followed pose stay within the draw-call budget', async ({ page }) => {
    await setCamera(page, ORBIT);
    await page.evaluate(() => window.__flat!.clearFrameCalls());
    await page.evaluate(() => window.__flat!.setLighting({ time: '13:00' }));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__flat!.clearFrameCalls());
    await page.evaluate(() => window.__flat!.whenRendered());
    const calls = await page.evaluate(() => window.__flat!.frameCalls());
    expect(calls.length).toBeGreaterThan(0);
    expect(Math.max(...calls)).toBeLessThanOrEqual(70);
  });
});

// ------------------------------------------------------------------------------ view channel

const WEB_ORIGIN = 'http://127.0.0.1:5173';
const SERVER_CWD = join(process.cwd(), 'apps', 'server');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

interface RunningServer {
  url: string;
  stop: () => Promise<void>;
}

async function startServer(): Promise<RunningServer> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'flat-view-'));
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: SERVER_CWD,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ALLOWED_ORIGINS: WEB_ORIGIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout!.on('data', (d: Buffer) => (log += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (log += d.toString()));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(killer);
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test.describe('view channel', () => {
  test.setTimeout(90_000);
  let srv: RunningServer;
  test.beforeEach(async () => {
    srv = await startServer();
  });
  test.afterEach(async () => {
    await srv.stop();
  });

  async function postView(body: unknown): Promise<{ status: number; delivered?: number }> {
    const res = await fetch(`${srv.url}/api/view`, { method: 'POST', headers: { 'content-type': 'application/json', origin: WEB_ORIGIN }, body: JSON.stringify(body) });
    const json = (await res.json()) as { delivered?: number };
    return { status: res.status, ...(json.delivered !== undefined ? { delivered: json.delivered } : {}) };
  }

  async function openSynced(page: Page): Promise<void> {
    await page.goto(`/?server=${encodeURIComponent(srv.url)}`);
    await page.evaluate(() => window.__flat!.ready);
    await expect.poll(async () => (await flat(page, (f) => f.connection())).status, { timeout: 15_000 }).toBe('connected');
  }

  test('POST /api/view is applied only while "Follow assistant view" is on, and never touches the scene', async ({ page }) => {
    await openSynced(page);
    const toggle = page.getByTestId('follow-assistant');
    await expect(toggle).not.toBeChecked(); // default off
    const rev = (await flat(page, (f) => f.connection())).rev;
    const sceneBefore = await flat(page, (f) => f.exportScene());

    // Off: delivered to the tab, ignored by it.
    expect((await postView({ pose: TOP, lighting: { time: '20:00' } })).delivered).toBe(1);
    await page.waitForTimeout(400);
    expect((await stats(page)).pose).toBeNull();
    expect(await flat(page, (f) => (f.sunInfo() as { time?: string }).time)).not.toBe('20:00');

    // On (persisted).
    await toggle.check();
    expect((await postView({ pose: WALK, lighting: { time: '20:00', exposureEV: 1.5 } })).status).toBe(200);
    await expect.poll(async () => (await stats(page)).pose?.mode).toBe('walk');
    await page.evaluate(() => window.__flat!.whenRendered());
    const s = await stats(page);
    expect(s.mode).toBe('walk');
    expect(s.headingDeg).toBeCloseTo(37, 2);
    expect(await flat(page, (f) => (f.sunInfo() as { time?: string }).time)).toBe('20:00');
    // A partial lighting message leaves the other keys alone (sun still enabled, default context).
    await postView({ lighting: { time: '09:30' } });
    await expect.poll(() => flat(page, (f) => (f.sunInfo() as { time?: string }).time)).toBe('09:30');
    expect((await stats(page)).exposure).toBeGreaterThan(0);
    // The scene is untouched: same revision, same text.
    expect((await flat(page, (f) => f.connection())).rev).toBe(rev);
    expect(await flat(page, (f) => f.exportScene())).toBe(sceneBefore);

    await page.reload();
    await page.evaluate(() => window.__flat!.ready);
    await expect(page.getByTestId('follow-assistant')).toBeChecked();
  });

  test('stale seq and foreign epochs are ignored (via the receiveView seam)', async ({ page }) => {
    await openSynced(page);
    await page.getByTestId('follow-assistant').check();
    const { epoch } = await flat(page, (f) => f.connection());
    expect(epoch).not.toBeNull();
    const msg = (seq: number, pose: CameraPose, extra: object = {}) => ({ type: 'view', seq, pose, ...extra });
    const send = (m: object) => page.evaluate((x) => window.__flat!.receiveView(x), m);

    expect(await send(msg(10, TOP, { epoch: 'some-other-epoch' }))).toBe('foreign-epoch');
    expect((await stats(page)).pose).toBeNull();
    expect(await send(msg(10, ORBIT, { epoch }))).toBe('applied');
    expect((await stats(page)).pose?.mode).toBe('orbit');
    expect(await send(msg(9, TOP))).toBe('stale');
    expect(await send(msg(10, TOP))).toBe('stale');
    expect((await stats(page)).pose?.mode).toBe('orbit');
    expect(await send(msg(11, TOP))).toBe('applied');
    expect((await stats(page)).pose?.mode).toBe('top');
    expect(await send({ type: 'view', seq: 12, pose: { mode: 'nope' } })).toBe('invalid');
  });

  test('Pages mode (no server) has no toggle, no view relay and makes no requests to a server', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    page.on('websocket', (w) => requests.push(w.url()));
    await openApp(page);
    await expect(page.getByTestId('follow-assistant')).toHaveCount(0);
    expect(await page.evaluate(() => window.__flat!.receiveView({ type: 'view', seq: 1, pose: { mode: 'top', center: [0, 0], halfHeight: 5, rotationDeg: 0 } }))).toBe('no-server');
    // Only the app's own origin (Vite's HMR socket aside): no probe, no scene server, no WebSocket of ours.
    const foreign = requests.filter((u) => !u.startsWith(WEB_ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('ws://127.0.0.1:5173/?token='));
    expect(foreign).toEqual([]);
    expect(requests.filter((u) => u.includes('/ws') || u.includes('/api/'))).toEqual([]);
  });
});
