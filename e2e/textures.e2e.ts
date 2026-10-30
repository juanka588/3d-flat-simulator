import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { charmeFlat, flat, loadScene, openApp, openAppPaintOnly, paintOnlyCharme, rendered, savePng, itemTextureSlugs, mapsBySet, usedTextureSlugs } from './helpers';

const MAX_DRAW_CALLS = 70;
const catalog = JSON.parse(readFileSync('apps/web/public/materials/catalog.json', 'utf8')) as { id: string; tileSizeM: number; meanColor: string; roughness: number }[];
const slugs = catalog.map((e) => e.id);

const texStats = (page: Page) => page.evaluate(() => window.__flat!.stats().textureSets);

/** Nothing is loading any more and a frame reflecting that has been drawn (a deterministic "no more requests" point). */
async function idle(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__flat!.stats().textureSets.pending === 0);
  await rendered(page);
}

/** The hook's `whenRendered` waits for pending textures and then for a frame that shows them. */
async function settle(page: Page): Promise<void> {
  await rendered(page);
}

interface SceneJson {
  materials: Record<string, unknown>[];
  walls: { id: string; start: [number, number]; end: [number, number]; finish?: { left?: string; right?: string } }[];
  rooms: { id: string; polygon: [number, number][]; floorMaterial?: string }[];
}

/** The paint-only Charme JSON with library materials added (`lib-<slug>`) and optionally assigned to the séjour floor / walls. */
function withTextures(opts: { floor?: string; walls?: string; extra?: string[]; paintFloor?: string }): unknown {
  const json = structuredClone(paintOnlyCharme()) as unknown as SceneJson;
  const add = (slug: string) => {
    const e = catalog.find((c) => c.id === slug);
    // The paint-only Charme keeps `lib-<slug>` as a paint (the fixture's own oak/turf); the texture replaces it.
    json.materials = json.materials.filter((m) => m.id !== `lib-${slug}`);
    json.materials.push({
      id: `lib-${slug}`,
      name: slug,
      kind: 'texture',
      color: e?.meanColor ?? '#c8b89e',
      roughness: e?.roughness ?? 0.8,
      textureUrl: `lib:${slug}`,
      textureScale: e?.tileSizeM ?? 1,
    });
  };
  const sejour = json.rooms.find((r) => r.id === 'sejour')!;
  if (opts.floor) {
    add(opts.floor);
    sejour.floorMaterial = `lib-${opts.floor}`;
  }
  if (opts.paintFloor) {
    json.materials.push({ id: 'flat-floor', name: 'flat', kind: 'paint', color: opts.paintFloor, roughness: 0.8 });
    sejour.floorMaterial = 'flat-floor';
  }
  if (opts.walls) {
    add(opts.walls);
    const ids = ['w-west', 'w-south', 'w-alcove', 'w-sejour-ch2', 'w-sejour-entree', 'w-niche-north', 'w-niche-west', 'w-sdb-west'];
    for (const w of json.walls) if (ids.includes(w.id)) w.finish = { left: `lib-${opts.walls}`, right: `lib-${opts.walls}` };
  }
  for (const slug of opts.extra ?? []) add(slug);
  return json;
}

/** Standard deviation of the canvas luma (0-255) in a window around a world point. */
function lumaStd(page: Page, point: [number, number, number], half = 40): Promise<number> {
  return page.evaluate(
    async (a) => {
      const hook = window.__flat!;
      const img = new Image();
      img.src = hook.capture();
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const rect = document.querySelector('canvas')!.getBoundingClientRect();
      const scale = img.width / rect.width;
      const at = hook.project(a.point);
      const h = Math.round(a.half * scale);
      const x0 = Math.max(0, Math.round((at.x - rect.left) * scale) - h);
      const y0 = Math.max(0, Math.round((at.y - rect.top) * scale) - h);
      const px = ctx.getImageData(x0, y0, Math.min(img.width - x0, 2 * h + 1), Math.min(img.height - y0, 2 * h + 1)).data;
      const n = px.length / 4;
      let sum = 0;
      let sum2 = 0;
      for (let i = 0; i < px.length; i += 4) {
        const l = 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
        sum += l;
        sum2 += l * l;
      }
      return Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2));
    },
    { point, half },
  );
}

const webpRequests: string[] = [];
const libRequests: string[] = [];
test.beforeEach(async ({ page }) => {
  webpRequests.length = 0;
  libRequests.length = 0;
  page.on('request', (r) => {
    if (/^\/materials\//.test(new URL(r.url()).pathname)) libRequests.push(new URL(r.url()).pathname);
    if (/\/materials\/.*\.webp/.test(r.url())) webpRequests.push(new URL(r.url()).pathname);
  });
  // The default Charme load uses library textures; every other test starts from the paint-only flat.
  if (test.info().title.startsWith('the default Charme load')) await openApp(page);
  else await openAppPaintOnly(page);
});

const FLOOR_POINT: [number, number, number] = [2, 0, 5];
const steadyCalls = async (page: Page) => {
  await rendered(page);
  return flat(page, (h) => h.stats().calls);
};

test('the default Charme load fetches exactly the texture sets the flat uses, once, and nothing else from the library', async ({ page }) => {
  await idle(page);
  const slugsInUse = usedTextureSlugs(charmeFlat);
  // (The bathroom floor is beige limestone tiles since the real-fittings fixture, 2b00eb8.)
  expect(slugsInUse).toEqual(['parquet-light-oak', 'tile-grey-large', 'tile-limestone-beige', 'turf-artificial-green']);
  // Plus the sets the fittings' finishes use (M5R): each set's three maps exactly once, nothing unrelated.
  const sets = mapsBySet(webpRequests);
  const items = itemTextureSlugs();
  for (const slug of slugsInUse) expect(sets[slug], slug).toEqual(['color', 'normal', 'roughness']);
  for (const [slug, maps] of Object.entries(sets)) {
    expect(slugsInUse.includes(slug) || items.has(slug), slug).toBe(true);
    expect(maps, slug).toEqual(['color', 'normal', 'roughness']);
  }
  const stats = await texStats(page);
  expect(stats).toMatchObject({ loaded: Object.keys(sets).length, pending: 0 });
  expect([...stats.slugs].sort()).toEqual(Object.keys(sets).sort());
  expect(libRequests.filter((p) => !p.endsWith('.webp'))).toEqual(['/materials/catalog.json']);
});

test('the paint-only Charme load makes zero texture requests', async ({ page }) => {
  await idle(page);
  expect(webpRequests).toEqual([]);
  expect(libRequests).toEqual([]);
  expect((await texStats(page)).loaded).toBe(0);
  expect(await loadScene(page, paintOnlyCharme())).toBe(true);
  await idle(page);
  expect(webpRequests).toEqual([]);
  expect((await texStats(page)).loaded).toBe(0);
});

test('a library floor loads exactly its three maps and is visibly textured', async ({ page }) => {
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  expect(await loadScene(page, withTextures({ paintFloor: '#93704d' }))).toBe(true);
  await rendered(page);
  const flatStd = await lumaStd(page, FLOOR_POINT);

  expect(await loadScene(page, withTextures({ floor: 'parquet-light-oak' }))).toBe(true);
  await settle(page);
  expect(webpRequests.sort().map((p) => p.split('/materials/')[1])).toEqual(['parquet-light-oak/color.webp', 'parquet-light-oak/normal.webp', 'parquet-light-oak/roughness.webp']);
  const stats = await texStats(page);
  expect(stats).toMatchObject({ loaded: 1, pending: 0, slugs: ['parquet-light-oak'] });

  const texturedStd = await lumaStd(page, FLOOR_POINT);
  console.log(`floor luma std: flat ${flatStd.toFixed(2)}, textured ${texturedStd.toFixed(2)}`);
  expect(texturedStd).toBeGreaterThan(flatStd + 2);
  expect(await steadyCalls(page)).toBeLessThanOrEqual(MAX_DRAW_CALLS);
});

test('an unknown library texture makes no request and falls back to paint', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  const json = withTextures({}) as SceneJson;
  json.materials.push({ id: 'bad', name: 'bad', kind: 'texture', color: '#ff0000', roughness: 0.8, textureUrl: 'lib:no-such-material' });
  const sejour = json.rooms.find((r) => r.id === 'sejour')!;
  sejour.floorMaterial = 'bad';
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  expect(await loadScene(page, json)).toBe(true);
  await idle(page);
  expect(webpRequests).toEqual([]);
  expect((await texStats(page)).loaded).toBe(0);
  expect(warnings.some((w) => w.includes('no-such-material'))).toBe(true);
});

test('eighteen textures loaded one after another (two more than the cap) never keep more than 16 sets', async ({ page }) => {
  test.slow();
  // 18 = cap + 2 is enough to force evictions; each step is a full scene load plus three downloads.
  for (const slug of slugs.slice(0, 18)) {
    expect(await loadScene(page, withTextures({ floor: slug }))).toBe(true);
    await settle(page);
    const stats = await texStats(page);
    expect(stats.loaded + (stats.idle ?? 0)).toBeLessThanOrEqual(16);
  }
  // Only the last one is in use; the earlier ones stay cached as idle (evicted first), never more than 16 in all.
  const last = await texStats(page);
  expect(last.loaded).toBe(1);
  expect(last.loaded + (last.idle ?? 0)).toBeLessThanOrEqual(16);
});

test('A -> B -> A does not download A again', async ({ page }) => {
  expect(await loadScene(page, withTextures({ floor: 'parquet-light-oak' }))).toBe(true);
  await settle(page);
  expect(await loadScene(page, withTextures({ floor: 'plaster-rough-white' }))).toBe(true);
  await settle(page);
  expect(await texStats(page)).toMatchObject({ loaded: 1, slugs: ['plaster-rough-white'], idle: 1 });
  expect(await loadScene(page, withTextures({ floor: 'parquet-light-oak' }))).toBe(true);
  await settle(page);
  await idle(page);
  const oak = webpRequests.filter((p) => p.includes('/parquet-light-oak/'));
  expect(oak).toHaveLength(3);
  expect(await texStats(page)).toMatchObject({ loaded: 1, slugs: ['parquet-light-oak'] });
});

test('edits (swatch clicks, drag frames) neither re-fetch the textures nor flash the textured floor back to paint', async ({ page }) => {
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  expect(await loadScene(page, withTextures({ floor: 'parquet-light-oak' }))).toBe(true);
  await settle(page);
  const texturedStd = await lumaStd(page, FLOOR_POINT);
  const requests = webpRequests.length;
  expect(requests).toBe(3);
  for (let i = 0; i < 12; i++) {
    const hex = `#${(0x405060 + i * 0x0a0b0c).toString(16)}`;
    const id = `paint-edit-${i}`;
    const res = await page.evaluate(
      ([mid, color]) =>
        window.__flat!.applyCommand({
          type: 'batch',
          label: 'edit',
          commands: [
            { type: 'material.define', material: { id: mid, name: mid, kind: 'paint', color, roughness: 0.9 } },
            { type: 'room.setWallFinish', roomId: 'ch1', materialId: mid },
          ],
        }),
      [id, hex],
    );
    expect(res.ok).toBe(true);
    // The frame that shows the edit must still show the textured floor.
    await rendered(page);
    expect((await texStats(page)).slugs).toEqual(['parquet-light-oak']);
    if (i % 4 === 3) expect(await lumaStd(page, FLOOR_POINT)).toBeGreaterThan(texturedStd - 2);
  }
  await idle(page);
  expect(webpRequests).toHaveLength(requests);
});

test('twenty textures in use at once stay within the LRU cap and the draw-call budget', async ({ page }) => {
  const json = withTextures({ extra: slugs.slice(0, 20) }) as SceneJson;
  json.walls.slice(0, 20).forEach((w, i) => (w.finish = { left: `lib-${slugs[i]}`, right: `lib-${slugs[i]}` }));
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  expect(await loadScene(page, json)).toBe(true);
  await settle(page);
  const stats = await texStats(page);
  expect(stats.loaded).toBeLessThanOrEqual(16);
  expect(stats.pending).toBe(0);
  expect(await steadyCalls(page)).toBeLessThanOrEqual(MAX_DRAW_CALLS);
});

test('captures: herringbone parquet floor and plaster walls', async ({ page }) => {
  expect(await loadScene(page, withTextures({ floor: 'parquet-herringbone-glossy' }))).toBe(true);
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  await settle(page);
  await savePng(page, test.info().outputPath('tex-floor-oak-top.png'));
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await page.evaluate((p) => window.__flat!.setWalkPose(p), { x: 2, z: 7.6, yawDeg: 0 });
  await settle(page);
  await savePng(page, test.info().outputPath('tex-floor-oak.png'));
  const calls = await steadyCalls(page);
  console.log(`walk draw calls with parquet: ${calls}`);
  expect(calls).toBeLessThanOrEqual(MAX_DRAW_CALLS);

  const WALL_POINT: [number, number, number] = [0.05, 1.2, 5];
  const WALK_WALL = { x: 1.6, z: 5, yawDeg: 90 };
  expect(await loadScene(page, withTextures({}))).toBe(true);
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await page.evaluate((p) => window.__flat!.setWalkPose(p), WALK_WALL);
  await settle(page);
  const paintStd = await lumaStd(page, WALL_POINT, 60);
  expect(await loadScene(page, withTextures({ walls: 'plaster-rough-white' }))).toBe(true);
  await page.evaluate(() => window.__flat!.setView({ mode: 'walk' }));
  await page.evaluate((p) => window.__flat!.setWalkPose(p), WALK_WALL);
  await settle(page);
  const plasterStd = await lumaStd(page, WALL_POINT, 60);
  console.log(`wall luma std: paint ${paintStd.toFixed(2)}, plaster ${plasterStd.toFixed(2)}`);
  expect(plasterStd).toBeGreaterThan(paintStd + 0.5);
  await savePng(page, test.info().outputPath('tex-walls-plaster.png'));
  expect(await steadyCalls(page)).toBeLessThanOrEqual(MAX_DRAW_CALLS);
  expect((await texStats(page)).slugs).toEqual(['plaster-rough-white']);
});
