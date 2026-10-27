/**
 * M5.18 nightly: the furniture rendering gaps that need a real WebGL page.
 *  - a fixed-camera pixel probe: a parametric bed and wardrobe change the pixels where they stand (and nowhere else);
 *  - a performance test: 50 repeated model items stay within 150 draw calls thanks to instancing, one model fetch.
 * Not part of the fast gates (`pnpm check` and `e2e-static`): it runs with the nightly `pnpm e2e`.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { sofaGlb } from '../apps/web/src/viewer/synthetic-glb';
import { charmeFlat, flat, loadScene, openApp, rendered } from './helpers';

test.describe.configure({ timeout: 120_000 });

const items = (...more: unknown[]) => ({ ...charmeFlat, items: [...(charmeFlat['items'] as unknown[]), ...more] });

function parametric(id: string, generator: 'bed' | 'wardrobe', position: [number, number], dims: { w: number; d: number; h: number }, params: Record<string, unknown>) {
  return { id, assetId: `param:${generator}`, position, elevation: 0, rotation: 0, roomId: 'ch1', mount: 'floor', dims, mesh: { kind: 'parametric', generator, params } };
}

type Rgb = [number, number, number];

/** Mean colour of a (2*half+1) square around the projection of each world point, from ONE capture. */
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

const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('fixed camera: a parametric bed and wardrobe change the pixels inside their exact footprint, and only there', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => window.__flat!.setClock('manual'));
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  await rendered(page);

  // Plan view draws every item as its footprint, so the probe checks the footprint: points 12 cm inside the four
  // corners of each piece must change, points 12 cm behind the back edge must not (the plan also tints the clearance zones, which never reach the back).
  const pieces = [
    { id: 'bed', cx: 7.9, cz: 1.9, w: 1.6, d: 2 },
    { id: 'wardrobe', cx: 9.3, cz: 3.4, w: 1.2, d: 0.6 },
  ];
  const inside = (pc: (typeof pieces)[number]): [number, number, number][] =>
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => [pc.cx + sx! * (pc.w / 2 - 0.12), 0, pc.cz + sz! * (pc.d / 2 - 0.12)]);
  const behind = (pc: (typeof pieces)[number]): [number, number, number][] =>
    [-1, 1].flatMap((sx) => [[pc.cx + sx * (pc.w / 2 - 0.12), 0, pc.cz - pc.d / 2 - 0.12] as [number, number, number]]).concat([[pc.cx, 0, pc.cz - pc.d / 2 - 0.12]]);
  const probes = pieces.flatMap((pc) => [...inside(pc), ...behind(pc)]);
  const elsewhere: [number, number, number] = [2.4, 0, 3.0];

  const baseline = await colours(page, [...probes, elsewhere]);

  const bed = parametric('probe-bed', 'bed', [7.9, 1.9], { w: 1.6, d: 2, h: 0.9 }, { w: 1.6, l: 2, h: 0.9 });
  const wardrobe = parametric('probe-wardrobe', 'wardrobe', [9.3, 3.4], { w: 1.2, d: 0.6, h: 2.2 }, { w: 1.2, d: 0.6, h: 2.2, doors: 2, doorType: 'hinged', finish: 'dark' });
  expect(await loadScene(page, items(bed, wardrobe))).toBe(true);
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  await rendered(page);
  expect(await flat(page, (f) => f.modelStats())).toMatchObject({ sources: { 'probe-bed': 'parametric', 'probe-wardrobe': 'parametric' } });

  const withItems = await colours(page, [...probes, elsewhere]);
  probes.forEach((p, i) => {
    const isInside = i % 7 < 4;
    const d = distance(baseline[i]!, withItems[i]!);
    if (isInside) expect(d, `${pieces[Math.floor(i / 7)]!.id} inside point ${p}: ${baseline[i]} -> ${withItems[i]}`).toBeGreaterThan(25);
    else expect(d, `${pieces[Math.floor(i / 7)]!.id} behind point ${p}: ${baseline[i]} -> ${withItems[i]}`).toBeLessThan(4);
  });
  expect(distance(baseline.at(-1)!, withItems.at(-1)!), 'another room is unchanged').toBeLessThan(4);
});

const ORIGIN = 'http://models.test';
const DIMS = { w: 2.1, d: 0.95, h: 0.85 };

function sofa(i: number) {
  const col = i % 10;
  const row = Math.floor(i / 10);
  return {
    id: `perf-sofa-${i}`,
    assetId: 'product:mock',
    position: [0.9 + col * 0.95, 4.4 + row * 0.5] as [number, number],
    elevation: 0,
    rotation: (i % 4) * 90,
    roomId: 'sejour',
    productRef: { provider: 'mock', sku: 'SOFA-1' },
    product: { provider: 'mock', sku: 'SOFA-1', name: 'Test sofa', url: 'https://example.com/sofa', price: 299, currency: 'EUR', dims: DIMS, category: 'sofa', snapshotAt: '2026-10-27T10:00:00Z' },
    mesh: { kind: 'provider' },
  };
}

test('performance: 50 items of one model stay within 150 draw calls (instanced) and one model fetch', async ({ page }) => {
  await openApp(page);
  const glb = Buffer.from(sofaGlb());
  const fetched: string[] = [];
  await page.route(`${ORIGIN}/**`, (route) => {
    fetched.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'model/gltf-binary', headers: { 'access-control-allow-origin': '*' }, body: glb });
  });
  await flat(page, (f) =>
    f.setMeshResolver((item) => ({ source: 'provider', dims: item.product.dims, scale: [1, 1, 1], product: 'mock:SOFA-1', reason: 'perf' })),
  );
  await flat(page, (f) => f.setModelOrigin('http://models.test'));
  const fifty = Array.from({ length: 50 }, (_, i) => sofa(i));
  expect(await loadScene(page, items(...fifty))).toBe(true);
  const stats = await flat(page, (f) => f.modelStats());
  expect(stats.loaded).toBe(50);
  expect(stats.requests).toHaveLength(1);
  expect(fetched).toHaveLength(1);
  expect(stats.cache.models).toBe(1);

  await page.evaluate(() => window.__flat!.clearFrameCalls());
  await rendered(page);
  await page.evaluate(() => window.__flat!.setLighting({ sunOn: true } as never));
  await rendered(page);
  await page.evaluate(() => window.__flat!.setView({ mode: 'top' }));
  await rendered(page);
  const calls = await page.evaluate(() => window.__flat!.frameCalls());
  expect(calls.length).toBeGreaterThan(0);
  expect(Math.max(...calls), `draw calls per frame: ${calls.join(',')}`).toBeLessThanOrEqual(150);
});
