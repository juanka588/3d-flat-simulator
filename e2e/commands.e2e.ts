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

test('a valid finish applies, undoes and redoes without moving the camera', async ({ page }) => {
  const before = await flat(page, (f) => f.stats());
  expect(await floorOf(page)).toBeNull();

  const result = await apply(page, FLOOR);
  expect(result.ok).toBe(true);
  expect(await floorOf(page)).toBe('floor-tile');
  expect((await flat(page, (f) => f.stats())).camera).toEqual(before.camera);
  expect(await flat(page, (f) => f.history())).toMatchObject({ canUndo: true, canRedo: false });

  expect(await page.evaluate(() => window.__flat!.undo())).toEqual({ ok: true, canUndo: false, canRedo: true });
  expect(await floorOf(page)).toBeNull();
  expect((await flat(page, (f) => f.stats())).camera).toEqual(before.camera);

  expect(await page.evaluate(() => window.__flat!.redo())).toEqual({ ok: true, canUndo: true, canRedo: false });
  expect(await floorOf(page)).toBe('floor-tile');
  expect(await page.evaluate(() => window.__flat!.undo().then(() => window.__flat!.undo()))).toMatchObject({ ok: false });
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
  expect(await flat(page, (f) => f.history().labels)).toEqual(['Edit site']);

  await input.blur();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => flat(page, (f) => f.getScene().site.northAngle)).toBe(Number(originalAngle));
  await rendered(page);
  expect(await sunDirection()).toEqual(original);
  await expect(input).toHaveValue(originalAngle); // the form follows the undo
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
