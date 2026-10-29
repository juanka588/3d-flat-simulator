/**
 * CG8: stand-ins for products without a 3D model show the product's look. A FAKE product (provider "mock") has a rug, a
 * cushion and a picture frame as parametric stand-ins; the local server is stubbed with `page.route` and serves a red
 * photo. With the server the photo parts are red; without it (Pages / Local mode) or when the photo is missing they keep the
 * palette colour, and nothing is requested from anywhere but the local server.
 */
import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { charmeFlat, flat, openApp, rendered, savePng } from './helpers';

test.describe.configure({ timeout: 120_000 });

const ORIGIN = 'http://models.test';
const OUT = '.tmp/e2e-standins';

type Rgb = [number, number, number];

function product(sku: string, name: string, category: string, dims: { w: number; d: number; h: number }) {
  return { provider: 'mock', sku, name, url: 'https://example.com/p', price: 19, currency: 'EUR', dims, category, snapshotAt: '2026-10-29T10:00:00Z' };
}

function standIn(id: string, sku: string, name: string, category: string, generator: string, position: [number, number], elevation: number, dims: { w: number; d: number; h: number }, params: Record<string, unknown>) {
  return {
    id,
    assetId: `param:${generator}`,
    position,
    elevation,
    rotation: 0,
    roomId: 'sejour',
    mount: 'floor',
    dims,
    productRef: { provider: 'mock', sku },
    product: product(sku, name, category, dims),
    mesh: { kind: 'parametric', generator, params },
  };
}

const RUG = standIn('rug-1', 'RUG-1', 'TESTRUG Tapis - beige 120x180 cm', 'rug', 'rug', [2.2, 4.6], 0, { w: 1.2, d: 1.8, h: 0.01 }, { w: 1.2, d: 1.8, h: 0.01, photo: true, colour: 'sand' });
const CUSHION = standIn('cushion-1', 'CUSHION-1', 'TESTCUSHION Coussin - beige 50x50 cm', 'cushion', 'cushion', [2.2, 4.4], 0, { w: 0.5, d: 0.5, h: 0.125 }, { w: 0.5, d: 0.5, h: 0.125, photo: true, colour: 'sand' });
const sceneWithStandIns = () => ({ ...charmeFlat, items: [...(charmeFlat['items'] as unknown[]), RUG, CUSHION] });

const RUG_POINT: [number, number, number] = [2.2, 0.01, 5.1];
const CUSHION_POINT: [number, number, number] = [2.2, 0.125, 4.4];

async function colours(page: Page, points: [number, number, number][], half = 3): Promise<Rgb[]> {
  return page.evaluate(
    async ({ pts, h }) => {
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
      return pts.map((p) => {
        const at = hook.project(p);
        const x0 = Math.max(0, Math.round((at.x - rect.left) * scale) - h);
        const y0 = Math.max(0, Math.round((at.y - rect.top) * scale) - h);
        const px = ctx.getImageData(x0, y0, 2 * h + 1, 2 * h + 1).data;
        const sum: Rgb = [0, 0, 0];
        for (let i = 0; i < px.length; i += 4) for (let k = 0; k < 3; k++) sum[k]! += px[i + k]!;
        const n = px.length / 4;
        return [sum[0]! / n, sum[1]! / n, sum[2]! / n] as Rgb;
      });
    },
    { pts: points, h: half },
  );
}

/** Loads the scene; resolves the errors (empty = loaded). */
async function load(page: Page): Promise<string[]> {
  return page.evaluate(async (j) => {
    const r = await window.__flat!.loadScene(j);
    return r.ok ? [] : JSON.parse(JSON.stringify(r)).errors?.map((e: { message?: string }) => e.message ?? String(e)) ?? ['failed'];
  }, sceneWithStandIns());
}

async function show(page: Page, file: string): Promise<void> {
  await page.evaluate(() => window.__flat!.setView({ mode: 'orbit' }));
  await page.evaluate(() => window.__flat!.setCamera({ mode: 'orbit', target: [2.2, 0.2, 4.7], azimuthDeg: 160, elevationDeg: 50, distance: 4.5, fovDeg: 50 }));
  await rendered(page);
  mkdirSync(OUT, { recursive: true });
  await savePng(page, `${OUT}/${file}`);
}

const redPhoto = () => sharp({ create: { width: 96, height: 96, channels: 3, background: '#c02020' } }).png().toBuffer();

test('with the local server the photo parts show the product photo; the server is the only place a photo is read from', async ({ page }) => {
  const photo = await redPhoto();
  const requests: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/products\//.test(r.url())) requests.push(r.url());
  });
  await page.route(`${ORIGIN}/api/products/**`, (route) => route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: photo }));
  await openApp(page);
  await flat(page, (f) => f.setModelOrigin('http://models.test'));
  expect(await load(page)).toEqual([]);
  await show(page, 'with-photo.png');
  expect(requests.sort()).toEqual([`${ORIGIN}/api/products/mock%3ACUSHION-1/photo`, `${ORIGIN}/api/products/mock%3ARUG-1/photo`]);
  const [rug, cushion] = await colours(page, [RUG_POINT, CUSHION_POINT]);
  expect(rug![0] - rug![1], `rug ${rug}`).toBeGreaterThan(40);
  expect(cushion![0] - cushion![1], `cushion ${cushion}`).toBeGreaterThan(40);
  expect((await flat(page, (f) => f.modelStats())).sources).toMatchObject({ 'rug-1': 'parametric', 'cushion-1': 'parametric' });
});

test('without a server (Pages / Local mode) the stand-ins keep their palette colour and nothing is requested', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/products\//.test(r.url())) requests.push(r.url());
  });
  await openApp(page);
  expect(await load(page)).toEqual([]);
  await show(page, 'no-server.png');
  expect(requests).toEqual([]);
  const [rug, cushion] = await colours(page, [RUG_POINT, CUSHION_POINT]);
  // sand (#c2a97f): warm, red above blue, and not the red photo
  for (const c of [rug!, cushion!]) {
    expect(c[0], `${c}`).toBeGreaterThan(c[2] + 20);
    expect(c[0] - c[1], `${c}`).toBeLessThan(40);
  }
});

test('a missing photo leaves the palette colour', async ({ page }) => {
  await page.route(`${ORIGIN}/api/products/**`, (route) => route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'no photo' }));
  await openApp(page);
  await flat(page, (f) => f.setModelOrigin('http://models.test'));
  expect(await load(page)).toEqual([]);
  await show(page, 'photo-404.png');
  const [rug] = await colours(page, [RUG_POINT]);
  expect(rug![0] - rug![1], `${rug}`).toBeLessThan(40);
});
