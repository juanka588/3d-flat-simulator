/**
 * The production build exactly as GitHub Pages serves it: `BASE_PATH=/3d-flat-simulator/ vite build`
 * served by `vite preview` under that base path (see playwright.config.ts, project "static").
 *
 * Checks that the material catalog, the thumbnails and the texture maps resolve under the base path
 * (no 404, no request escaping the base), that the catalog is fetched exactly once, that autosave
 * restores a reload, and that the `?test` hook exists only when asked for.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { charmeFlat, seedPaintOnly, itemTextureSlugs, mapsBySet, usedTextureSlugs } from './helpers';

const BASE = '/3d-flat-simulator/';
const SAGE_ID = 'paint-a3ae93-matt';
/** A library texture the shipped Charme does not use, so applying it from the UI is a fresh download. */
const PARQUET = 'parquet-herringbone-glossy';

interface Traffic {
  requests: string[];
  bad: string[];
}

function watch(page: Page): Traffic {
  const t: Traffic = { requests: [], bad: [] };
  page.on('request', (r) => t.requests.push(new URL(r.url()).pathname));
  page.on('response', (r) => {
    if (r.status() >= 400) t.bad.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  return t;
}

/** Opens the hooked app on the paint-only Charme (the shipped flat uses library textures by default). */
async function openHooked(page: Page): Promise<void> {
  await seedPaintOnly(page);
  await page.goto('?test');
  await page.evaluate(() => window.__flat!.ready);
  await expect(page.locator('canvas')).toBeVisible();
}

test('the hook is absent without ?test, and the default load fetches exactly the flat\'s texture sets under the base path', async ({ page }) => {
  const traffic = watch(page);
  await page.goto('');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => typeof window.__flat)).toBe('undefined');
  // The hook is absent here, so wait for the network to go quiet and two animation frames instead of a timer:
  // every library request caused by the first render would have been issued by then.
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const lib = traffic.requests.filter((p) => p.includes('/materials/'));
  // The flat's own sets (floors) plus the sets its fittings' finishes use (M5R), each set's three maps exactly once.
  const sets = mapsBySet(lib);
  const own = usedTextureSlugs(charmeFlat);
  const items = itemTextureSlugs();
  for (const slug of own) expect(sets[slug], slug).toEqual(['color', 'normal', 'roughness']);
  for (const [slug, maps] of Object.entries(sets)) {
    expect(own.includes(slug) || items.has(slug), `${slug} is used by the flat or an item finish`).toBe(true);
    expect(maps, slug).toEqual(['color', 'normal', 'roughness']);
  }
  expect(lib.filter((p) => !p.endsWith('.webp'))).toEqual([`${BASE}materials/catalog.json`]);
  expect(lib.every((p) => p.startsWith(`${BASE}materials/`))).toBe(true);
  expect(traffic.requests.every((p) => p.startsWith(BASE))).toBe(true);
  expect(traffic.bad).toEqual([]);
});

test('the paint-only flat fetches nothing from the library', async ({ page }) => {
  const traffic = watch(page);
  await seedPaintOnly(page);
  await page.goto('');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  expect(traffic.requests.filter((p) => p.includes('/materials/'))).toEqual([]);
  expect(traffic.bad).toEqual([]);
});

test('?test enables the hook', async ({ page }) => {
  await openHooked(page);
  expect(await page.evaluate(() => typeof window.__flat!.applyCommand)).toBe('function');
  expect((await page.evaluate(() => window.__flat!.stats())).textureSets).toEqual({ loaded: 0, pending: 0, slugs: [], idle: 0 });
});

test('a library texture applied from the Finish UI loads its maps under the base path, once', async ({ page }) => {
  const traffic = watch(page);
  await openHooked(page);
  await page.evaluate(() => window.__flat!.select('sejour'));
  await page.evaluate(() => window.__flat!.whenRendered());
  const finish = page.getByTestId('properties').getByRole('region', { name: 'Finish' });
  await finish.getByRole('tab', { name: 'Textures' }).click();
  const card = finish.getByRole('button', { name: 'Herringbone parquet (glossy oak)' });
  await expect(card).toBeVisible();
  await expect(card.locator('img')).toHaveJSProperty('complete', true);
  await card.click();
  await page.evaluate(() => window.__flat!.whenRendered());

  const stats = await page.evaluate(() => window.__flat!.stats().textureSets);
  expect(stats).toEqual({ loaded: 1, pending: 0, slugs: [PARQUET], idle: 0 });
  expect((await page.evaluate(() => window.__flat!.getScene())).rooms.find((r) => r.id === 'sejour')!.floorMaterial).toBe(`lib-${PARQUET}`);

  const lib = traffic.requests.filter((p) => p.includes('/materials/'));
  expect(lib.every((p) => p.startsWith(`${BASE}materials/`))).toBe(true);
  expect(lib.filter((p) => p.endsWith('/catalog.json'))).toEqual([`${BASE}materials/catalog.json`]);
  expect(lib.filter((p) => p.endsWith('.webp') && !p.endsWith('/thumb.webp')).sort()).toEqual(['color', 'normal', 'roughness'].map((m) => `${BASE}materials/${PARQUET}/${m}.webp`));
  expect(lib.some((p) => p === `${BASE}materials/${PARQUET}/thumb.webp`)).toBe(true);
  expect(traffic.requests.filter((p) => !p.startsWith(BASE))).toEqual([]);
  expect(traffic.bad).toEqual([]);
});

test('autosave restores a paint and a texture after a reload; undo still works from the saved history', async ({ page }) => {
  const traffic = watch(page);
  await openHooked(page);
  const paint = await page.evaluate(
    (id) => window.__flat!.applyCommand({ type: 'batch', label: 'sage', commands: [{ type: 'material.define', material: { id, name: 'Sage', kind: 'paint', color: '#a3ae93', roughness: 0.9 } }, { type: 'room.setWallFinish', roomId: 'sejour', materialId: id }] }),
    SAGE_ID,
  );
  expect(paint.ok).toBe(true);
  await page.evaluate(() => window.__flat!.select('sejour'));
  const finish = page.getByTestId('properties').getByRole('region', { name: 'Finish' });
  await finish.getByRole('tab', { name: 'Textures' }).click();
  await finish.getByRole('button', { name: 'Herringbone parquet (glossy oak)' }).click();
  await page.evaluate(() => window.__flat!.whenRendered());
  const saved = await page.evaluate(async () => {
    await window.__flat!.flushAutosave();
    return window.__flat!.getScene();
  });

  await page.reload();
  await page.evaluate(() => window.__flat!.ready);
  const restored = await page.evaluate(() => window.__flat!.getScene());
  expect(restored).toEqual(saved);
  expect(restored.rooms.find((r) => r.id === 'sejour')).toMatchObject({ wallFinish: SAGE_ID, floorMaterial: `lib-${PARQUET}` });
  // The restored textured floor loads again from the base path.
  await page.evaluate(() => window.__flat!.whenRendered());
  expect((await page.evaluate(() => window.__flat!.stats().textureSets)).slugs).toEqual([PARQUET]);

  const history = await page.evaluate(() => window.__flat!.history());
  expect(history.canUndo).toBe(true);
  expect(history.labels).toHaveLength(2);
  const undone = await page.evaluate(() => window.__flat!.undo());
  expect(undone.ok).toBe(true);
  const after = await page.evaluate(() => window.__flat!.getScene());
  expect(after.rooms.find((r) => r.id === 'sejour')!.floorMaterial ?? null).toBeNull();
  expect(after.rooms.find((r) => r.id === 'sejour')!.wallFinish).toBe(SAGE_ID);
  // Releasing the only user of the floor texture leaves its set cached as idle (undo/redo must not re-download it).
  expect(await page.evaluate(() => window.__flat!.stats().textureSets)).toMatchObject({ loaded: 0, slugs: [], idle: 1 });
  expect(traffic.bad).toEqual([]);
});
