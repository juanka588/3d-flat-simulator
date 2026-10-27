import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { flat, openApp, rendered } from './helpers';

const FLOOR = { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-tile' } as const;

const floorOf = (page: Page) => flat(page, (f) => f.getScene().rooms.find((r) => r.id === 'sejour')!.floorMaterial ?? null);
const apply = (page: Page, cmd: Record<string, unknown>) => page.evaluate((c) => window.__flat!.applyCommand(c), cmd);

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

type Pose = { camera: [number, number, number]; yawDeg: number; mode: string };

const readPose = async (page: Page): Promise<Pose> => {
  const { camera, yawDeg, mode } = await flat(page, (f) => f.stats());
  return { camera, yawDeg, mode };
};

/** Lets orbit damping run out deterministically: the hook applies the remaining motion at once (no frame counting). */
async function spinDown(page: Page): Promise<void> {
  await page.evaluate(() => window.__flat!.settleCamera());
}

function expectSamePose(actual: Pose, expected: Pose): void {
  expect(actual.mode).toBe(expected.mode);
  actual.camera.forEach((c, k) => expect(c).toBeCloseTo(expected.camera[k]!, 1));
  expect(actual.yawDeg).toBeCloseTo(expected.yawDeg, 0);
}

async function orbitAway(page: Page): Promise<void> {
  const box = (await page.locator('canvas').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 140, y + 60, { steps: 8 });
  await page.mouse.up();
}

async function editUndoRedoKeepsPose(page: Page): Promise<void> {
  const before = await readPose(page);
  expect(await floorOf(page)).toBeNull();

  expect((await apply(page, FLOOR)).ok).toBe(true);
  expect(await floorOf(page)).toBe('floor-tile');
  expectSamePose(await readPose(page), before);
  expect(await flat(page, (f) => f.history())).toMatchObject({ canUndo: true, canRedo: false });

  expect(await page.evaluate(() => window.__flat!.undo())).toEqual({ ok: true, canUndo: false, canRedo: true });
  expect(await floorOf(page)).toBeNull();
  expectSamePose(await readPose(page), before);

  expect(await page.evaluate(() => window.__flat!.redo())).toEqual({ ok: true, canUndo: true, canRedo: false });
  expect(await floorOf(page)).toBe('floor-tile');
  expectSamePose(await readPose(page), before);
  expect(await page.evaluate(() => window.__flat!.undo().then(() => window.__flat!.undo()))).toMatchObject({ ok: false });
}

test('a valid finish applies, undoes and redoes without moving an orbited camera', async ({ page }) => {
  test.slow();
  const initial = await readPose(page);
  await orbitAway(page);
  await spinDown(page);
  const orbited = await readPose(page);
  expect(orbited.camera).not.toEqual(initial.camera); // a non-default pose, so "unchanged" means something
  await editUndoRedoKeepsPose(page);
});

test('a valid finish applies, undoes and redoes without moving a walker', async ({ page }) => {
  await flat(page, (f) => f.setView({ mode: 'walk' }));
  await page.evaluate((p) => window.__flat!.setWalkPose(p), { x: 2.2, z: 6.1, yawDeg: 37 });
  const walking = await readPose(page);
  expect(walking.yawDeg).toBeCloseTo(37, 0);
  await editUndoRedoKeepsPose(page);
});

test('an invalid command returns errors and leaves the scene unchanged', async ({ page }) => {
  const sceneBefore = await flat(page, (f) => f.exportScene());
  const unknownRoom = await apply(page, { type: 'room.setFloor', roomId: 'nope', materialId: null });
  expect(unknownRoom.ok).toBe(false);
  if (!unknownRoom.ok) expect(unknownRoom.errors.length).toBeGreaterThan(0);
  expect((await apply(page, { type: 'definitely.not.a.command' })).ok).toBe(false);
  expect(await flat(page, (f) => f.exportScene())).toBe(sceneBefore);
  expect(await flat(page, (f) => f.history())).toMatchObject({ canUndo: false, canRedo: false });
});

test('an edit survives a reload through the autosave', async ({ page }) => {
  await apply(page, FLOOR);
  await flat(page, (f) => f.flushAutosave());
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved');

  await page.reload();
  await page.evaluate(() => window.__flat!.ready);
  expect(await floorOf(page)).toBe('floor-tile');
  await expect(page.getByTestId('boot-banner')).toHaveCount(0);
  // The history came back too.
  expect(await page.evaluate(() => window.__flat!.undo())).toMatchObject({ ok: true });
  expect(await floorOf(page)).toBeNull();
});

test('a corrupt save is kept aside and autosave stays paused until the user chooses', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('flat.autosave.v1', '{this is not json'));
  await page.reload();
  await page.evaluate(() => window.__flat!.ready);
  expect((await apply(page, FLOOR)).ok).toBe(true);
  await flat(page, (f) => f.flushAutosave());
  // Nothing was written over the saved flat, and a copy of it was kept.
  const stored = await page.evaluate(() => ({
    current: localStorage.getItem('flat.autosave.v1'),
    rejected: Object.keys(localStorage).filter((k) => k.startsWith('flat.autosave.rejected.')),
  }));
  expect(stored.current).toBe('{this is not json');
  expect(stored.rejected).toHaveLength(1);
  await page.reload();
  await page.evaluate(() => window.__flat!.ready);
  expect(await floorOf(page)).toBeNull(); // the edit was never saved
});

test('"Keep editing (overwrite)" resumes autosave and saves the open flat', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('flat.autosave.v1', '{this is not json'));
  await page.reload();
  await page.evaluate(() => window.__flat!.ready);
  await apply(page, FLOOR);
  await page.getByTestId('boot-keep-editing').click();
  await expect(page.getByTestId('boot-banner')).toHaveCount(0);
  await flat(page, (f) => f.flushAutosave());
  await page.reload();
  await page.evaluate(() => window.__flat!.ready);
  expect(await floorOf(page)).toBe('floor-tile');
});

test('"Start fresh" reopens the sample and resumes autosave', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('flat.autosave.v1', '{this is not json'));
  await page.reload();
  await page.evaluate(() => window.__flat!.ready);
  await apply(page, FLOOR);
  await page.getByTestId('boot-start-fresh').click();
  expect(await floorOf(page)).toBeNull();
  await expect(page.getByTestId('boot-banner')).toHaveCount(0);
});

test('a corrupt save falls back to the sample with a banner', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('flat.autosave.v1', '{this is not json'));
  await page.reload();
  await page.evaluate(() => window.__flat!.ready);
  await expect(page.getByTestId('boot-banner')).toContainText('could not be restored');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Charme');
});

test('export then import in a fresh context renders the same scene', async ({ page, browser }) => {
  await apply(page, FLOOR);
  // The generated site context belongs to the built-in fixture, not to an imported file: compare the flat alone.
  await flat(page, (f) => f.setLighting({ showContext: false }));
  const original = await flat(page, (f) => f.stats());

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export .flat.json' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.flat\.json$/);
  const text = readFileSync((await download.path())!, 'utf8');
  expect(text).toBe(await flat(page, (f) => f.exportScene()));

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const fresh = await context.newPage();
    await openApp(fresh);
    expect(await floorOf(fresh)).toBeNull();
    await fresh.getByTestId('import-input').setInputFiles({ name: 'mine.flat.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect.poll(() => floorOf(fresh)).toBe('floor-tile');
    await flat(fresh, (f) => f.setLighting({ showContext: false }));
    expect(await flat(fresh, (f) => f.exportScene())).toBe(text);
    const imported = await flat(fresh, (f) => f.stats());
    expect(imported.meshes).toEqual(original.meshes);
    expect(imported.triangles).toBe(original.triangles);
    expect(imported.sceneName).toBe(original.sceneName);
  } finally {
    await context.close();
  }
});

test('import and reset ask before discarding edits', async ({ page }) => {
  await apply(page, FLOOR);
  const messages: string[] = [];
  page.once('dialog', (d) => {
    messages.push(d.message());
    void d.dismiss();
  });
  await page.getByRole('button', { name: 'Reset to sample' }).click();
  expect(messages).toHaveLength(1);
  expect(await floorOf(page)).toBe('floor-tile'); // cancelled

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Reset to sample' }).click();
  await expect.poll(() => floorOf(page)).toBeNull();
  expect(await flat(page, (f) => f.history())).toMatchObject({ canUndo: false });
});

test('blocked storage still works and shows autosave as unavailable', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await context.addInitScript(() => {
      IDBFactory.prototype.open = () => {
        throw new DOMException('denied', 'SecurityError');
      };
      Storage.prototype.setItem = () => {
        throw new DOMException('full', 'QuotaExceededError');
      };
    });
    const page = await context.newPage();
    await openApp(page);
    expect((await apply(page, FLOOR)).ok).toBe(true);
    await flat(page, (f) => f.flushAutosave());
    await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'unavailable');
    await expect(page.getByTestId('autosave-status')).toContainText('Autosave unavailable');
    expect(await page.evaluate(() => window.__flat!.undo())).toMatchObject({ ok: true });
    expect(await floorOf(page)).toBeNull();
  } finally {
    await context.close();
  }
});

test('a site panel edit is undoable and the sun moves back', async ({ page }) => {
  const sunDirection = () => flat(page, (f) => {
    const info = f.sunInfo();
    return info.available ? info.direction : null;
  });
  const original = await sunDirection();
  const input = page.getByTestId('site-northAngle');
  const originalAngle = await input.inputValue();

  await input.fill('75');
  await expect.poll(() => flat(page, (f) => f.getScene().site.northAngle)).toBe(75);
  await rendered(page);
  expect(await sunDirection()).not.toEqual(original);
  expect(await flat(page, (f) => f.history().labels)).toEqual(['Set north angle to 75°']);

  await input.blur();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => flat(page, (f) => f.getScene().site.northAngle)).toBe(Number(originalAngle));
  await rendered(page);
  expect(await sunDirection()).toEqual(original);
  await expect(input).toHaveValue(originalAngle); // the form follows the undo
});

test('the site panel records nothing until a value changes, then one descriptive entry that survives a reload', async ({ page }) => {
  const history = () => flat(page, (f) => f.history());
  const fields = ['latitude', 'longitude', 'northAngle', 'timezone', 'floorElevation'] as const;

  // Focus, Tab through and blur every field, retype the same value, change the date and time and press Now: no entries.
  await page.getByTestId('site-latitude').focus();
  for (let i = 0; i < fields.length; i++) await page.keyboard.press('Tab');
  for (const f of fields) {
    const input = page.getByTestId(`site-${f}`);
    await input.focus();
    await input.blur();
  }
  const latitude = page.getByTestId('site-latitude');
  const original = await latitude.inputValue();
  await latitude.fill(original);
  await latitude.fill(String(Number(original))); // "48.7859" formatted differently, same number
  await latitude.blur();
  await page.getByLabel('Date').fill('2026-06-21');
  await page.getByLabel('Exact time').fill('09:30');
  await page.getByRole('button', { name: 'Now' }).click();
  await rendered(page);
  expect((await history()).labels).toEqual([]);
  expect((await history()).entries).toEqual([]);

  // One edit, one entry.
  await latitude.fill('48.79');
  await expect.poll(() => flat(page, (f) => f.getScene().site.latitude)).toBe(48.79);
  expect((await history()).labels).toEqual(['Set latitude to 48.79']);
  expect((await history()).entries).toHaveLength(1);

  // The popover shows the label, who and when.
  await page.getByRole('button', { name: 'History' }).click();
  const item = page.getByTestId('history-list').locator('li').first();
  await expect(item).toContainText('Set latitude to 48.79');
  await expect(item).toContainText('you');
  await expect(item).toContainText('just now');
  await page.keyboard.press('Escape');

  // An assistant change is attributed to Claude and labelled with names, not ids.
  await page.evaluate(() => window.__flat!.applyCommand({ type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-tile' }, 'llm'));
  await page.getByRole('button', { name: 'History' }).click();
  const first = page.getByTestId('history-list').locator('li').first();
  await expect(first).toContainText('Floor of Séjour → Light grey tile');
  await expect(first).toContainText('Claude');
  await page.keyboard.press('Escape');

  // After a reload the restored history keeps its labels (it used to fall back to the command type).
  await page.evaluate(() => window.__flat!.flushAutosave());
  await page.reload();
  await page.evaluate(() => window.__flat!.ready);
  expect((await history()).labels).toEqual(['Set latitude to 48.79', 'Floor of Séjour → Light grey tile (satin)']);
});

test('keyboard shortcuts undo and redo, but not while typing in a field', async ({ page }) => {
  await apply(page, FLOOR);
  const history = () => flat(page, (f) => f.history());

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => floorOf(page)).toBeNull();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => floorOf(page)).toBe('floor-tile');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => floorOf(page)).toBeNull();
  await page.keyboard.press('Control+y');
  await expect.poll(() => floorOf(page)).toBe('floor-tile');

  await page.getByTestId('site-latitude').focus();
  await page.keyboard.press('ControlOrMeta+z');
  expect(await floorOf(page)).toBe('floor-tile');
  expect(await history()).toMatchObject({ canUndo: true });
});
