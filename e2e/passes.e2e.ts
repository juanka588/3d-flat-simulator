/**
 * CG1 render passes (`__flat.passes`): deterministic bytes under software GL, a legend that maps pixels to entity ids (checked by
 * unprojecting depth pixels back to the plan), structural edges that ignore textures, and no debug markers in any pass.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cameraFromMatrixWorld, unprojectPixel } from '../packages/scene/src/index';
import { charmeFlat, flat, loadScene, openApp } from './helpers';

type Passes = Awaited<ReturnType<NonNullable<Window['__flat']>['passes']>>;

test.slow();

const SIZE = { width: 640, height: 480 };
/** Séjour, looking at the kitchen (the spike's pose). */
const SEJOUR = { mode: 'walk' as const, position: [0.3, 2.57] as [number, number], eyeHeight: 1.6, headingDeg: 146.24, pitchDeg: 0, fovDeg: 75 };

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await loadScene(page, charmeFlat);
  await flat(page, (f) => f.setComfort({ showPerson: false, translucentDoors: false }));
});

const shoot = async (page: Page, kinds?: string[]): Promise<Passes> => {
  await page.evaluate((p) => window.__flat!.setCamera(p), SEJOUR);
  return page.evaluate((k) => window.__flat!.passes({ size: { width: 640, height: 480 }, ...(k ? { kinds: k as never } : {}) }), kinds);
};

const bytes = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
const sha = (url: string) => createHash('sha256').update(bytes(url)).digest('hex');
/** Decodes a pass PNG (8 or 16 bit, 1/3 channels, filter 0, as written by the passes). */
function decode(url: string) {
  const b = bytes(url);
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const bitDepth = b[24]!;
  const channels = b[25] === 0 ? 1 : 3;
  let at = 8;
  const idat: Buffer[] = [];
  while (at < b.length) {
    const len = b.readUInt32BE(at);
    if (b.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(b.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels * (bitDepth / 8);
  const sample = (y: number, i: number) => (bitDepth === 16 ? raw.readUInt16BE(y * (rowBytes + 1) + 1 + i * 2) : raw[y * (rowBytes + 1) + 1 + i]!);
  return { width, height, bitDepth, channels, sample };
}

/** RGBA bytes of an 8-bit pass (gray is replicated). */
function rgb(url: string) {
  const d = decode(url);
  const data = new Uint8Array(d.width * d.height * 4);
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      for (let c = 0; c < 3; c++) data[(y * d.width + x) * 4 + c] = d.sample(y, x * d.channels + (d.channels === 1 ? 0 : c));
      data[(y * d.width + x) * 4 + 3] = 255;
    }
  }
  return { width: d.width, height: d.height, data };
}

function gray16(url: string): Uint16Array {
  const d = decode(url);
  expect([d.bitDepth, d.channels]).toEqual([16, 1]);
  const out = new Uint16Array(d.width * d.height);
  for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) out[y * d.width + x] = d.sample(y, x);
  return out;
}

test('every pass is the same size, and two runs give identical bytes', async ({ page }) => {
  const a = await shoot(page);
  const b = await shoot(page);
  expect(Object.keys(a.images).sort()).toEqual(['color', 'depth', 'depthVis', 'edges', 'edgesItems', 'ids', 'instances', 'normals']);
  for (const [k, url] of Object.entries(a.images)) {
    const png = k === 'color' ? { width: bytes(url).readUInt32BE(16), height: bytes(url).readUInt32BE(20) } : decode(url);
    expect([png.width, png.height], k).toEqual([SIZE.width, SIZE.height]);
    expect(sha(url), `${k} is deterministic`).toBe(sha(b.images[k as keyof Passes['images']]!));
  }
  expect(a.camera).toEqual(b.camera);
  expect(a.legend).toEqual(b.legend);
  expect(a.camera).toMatchObject({ type: 'perspective', width: 640, height: 480, fovDeg: 75 });
});

test('the legend maps pixels to entities: a fridge pixel unprojects into the fridge footprint', async ({ page }) => {
  const p = await shoot(page, ['depth', 'instances', 'ids']);
  const fridge = p.legend!.instances.find((e) => e.id === 'kitchen-fridge-f');
  expect(fridge, 'the fridge is in view').toBeTruthy();
  expect(fridge).toMatchObject({ class: 'locked_fitting', kind: 'item', roomId: 'sejour' });
  const inst = rgb(p.images.instances!);
  const depth = gray16(p.images.depth!);
  const cam = cameraFromMatrixWorld(p.camera.matrixWorld, p.camera.fovDeg!, 640, 480);
  let n = 0;
  let inside = 0;
  for (let y = 0; y < 480; y++) {
    for (let x = 0; x < 640; x++) {
      const i = (y * 640 + x) * 4;
      if (inst.data[i] !== fridge!.color[0] || inst.data[i + 1] !== fridge!.color[1] || inst.data[i + 2] !== fridge!.color[2]) continue;
      n++;
      const w = unprojectPixel(cam, x + 0.5, y + 0.5, depth[y * 640 + x]! / 1000);
      // Fridge at plan (3.395, 6.95), rotated 270: 0.63 deep along x, 0.60 wide along z, 1.85 high (5 cm tolerance).
      if (Math.abs(w[0] - 3.395) <= 0.315 + 0.05 && Math.abs(w[2] - 6.95) <= 0.3 + 0.05 && w[1] >= -0.05 && w[1] <= 1.9) inside++;
    }
  }
  expect(n).toBe(fridge!.pixels);
  expect(n).toBeGreaterThan(200);
  expect(inside / n).toBeGreaterThan(0.99);
  // The class mask paints the same pixels with the class colour of a locked fitting.
  const ids = rgb(p.images.ids!);
  const cls = p.legend!.classes.find((c) => c.class === 'locked_fitting')!;
  let first = -1;
  for (let i = 0; i < 640 * 480 && first < 0; i++) if (inst.data[i * 4] === fridge!.color[0] && inst.data[i * 4 + 1] === fridge!.color[1] && inst.data[i * 4 + 2] === fridge!.color[2]) first = i;
  expect([ids.data[first * 4], ids.data[first * 4 + 1], ids.data[first * 4 + 2]]).toEqual(cls.color);
  // Walls, floor and ceiling are in the class legend too.
  for (const c of ['wall', 'floor', 'ceiling']) expect(p.legend!.classes.find((e) => e.class === c)!.pixels, c).toBeGreaterThan(0);
});

test('structural edges ignore textures: swapping the floor material leaves them unchanged', async ({ page }) => {
  const before = await shoot(page, ['edges', 'edgesItems', 'color']);
  // Séjour floor: oak parquet (a texture) to a plain paint, and the wall finish too.
  await flat(page, (f) => f.applyCommand({ type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-tile' }));
  await flat(page, (f) => f.applyCommand({ type: 'room.setWallFinish', roomId: 'sejour', materialId: 'floor-deck' }));
  const after = await shoot(page, ['edges', 'edgesItems', 'color']);
  expect(sha(after.images.color!), 'the colour image did change').not.toBe(sha(before.images.color!));
  expect(sha(after.images.edges!)).toBe(sha(before.images.edges!));
  expect(sha(after.images.edgesItems!)).toBe(sha(before.images.edgesItems!));
  const edges = rgb(after.images.edges!);
  let on = 0;
  for (let i = 0; i < 640 * 480; i++) if (edges.data[i * 4]) on++;
  expect(on).toBeGreaterThan(500);
});

test('no debug marker in any pass: selection, person ghost and lamp bulbs are hidden', async ({ page }) => {
  const clean = await shoot(page, ['color', 'ids', 'edges']);
  await flat(page, (f) => f.setComfort({ showPerson: true }));
  await page.evaluate(() => window.__flat!.select('kitchen-fridge-f'));
  await flat(page, (f) => f.whenRendered());
  const busy = await shoot(page, ['color', 'ids', 'edges']);
  expect(sha(busy.images.color!)).toBe(sha(clean.images.color!));
  expect(sha(busy.images.ids!)).toBe(sha(clean.images.ids!));
  expect(sha(busy.images.edges!)).toBe(sha(clean.images.edges!));
  // No pixel of the class mask is the "other" colour: nothing unclassified was drawn.
  expect(busy.legend!.classes.find((c) => c.class === 'other')!.pixels).toBe(0);
  expect(busy.legend!.unclassified).toEqual([]);
});

test('the scene is untouched afterwards: the next colour capture equals the one before', async ({ page }) => {
  await page.evaluate((p) => window.__flat!.setCamera(p), SEJOUR);
  await page.evaluate((s) => window.__flat!.setViewport({ ...s, dpr: 1 }), SIZE);
  const before = await page.evaluate(() => window.__flat!.capture());
  await page.evaluate(() => window.__flat!.passes());
  await page.evaluate(() => window.__flat!.whenRendered());
  expect(await page.evaluate(() => window.__flat!.capture())).toBe(before);
});
