import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { FlatTestHook } from '../apps/web/src/test-hook-types';

export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => window.__flat!.ready);
  await expect(page.locator('canvas')).toBeVisible();
}

/** Runs a function against `window.__flat` in the page. */
export function flat<T>(page: Page, fn: (hook: FlatTestHook) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__flat)`) as Promise<T>;
}

/** Waits for a rendered frame that reflects the current scene, mode and selection. */
export function rendered(page: Page): Promise<void> {
  return page.evaluate(() => window.__flat!.whenRendered());
}

/** Loads a scene through the test hook; resolves after the new scene has been drawn. */
export function loadScene(page: Page, json: unknown): Promise<boolean> {
  return page.evaluate(async (j) => (await window.__flat!.loadScene(j)).ok, json);
}

export interface FlatJson {
  name: string;
  site: { northAngle: number };
  walls: { id: string; start: [number, number]; end: [number, number]; thickness: number }[];
  rooms: { id: string; name: string; polygon: [number, number][] }[];
  [key: string]: unknown;
}

function readFixture(name: string): FlatJson {
  return JSON.parse(readFileSync(`packages/scene/fixtures/${name}.flat.json`, 'utf8')) as FlatJson;
}

export const sampleFlat = readFixture('sample');
export const charmeFlat = readFixture('charme-3205');

/** Shoelace area of a plan polygon. */
export function polygonArea(polygon: [number, number][]): number {
  let sum = 0;
  polygon.forEach(([x1, y1], i) => {
    const [x2, y2] = polygon[(i + 1) % polygon.length]!;
    sum += x1 * y2 - x2 * y1;
  });
  return Math.abs(sum) / 2;
}

/** Skips the current test when the sun/exposure maths in `@flat/scene` is unavailable (stubs). */
export async function lightingAvailable(page: Page): Promise<{ ok: true } | { ok: false; reason: string }> {
  const info = await page.evaluate(() => window.__flat!.sunInfo());
  return info.available ? { ok: true } : { ok: false, reason: `lighting maths unavailable (${info.error}); skipping until integration` };
}

/**
 * Mean luminance (0-1, Rec. 709 on sRGB values) of the current canvas, or of a square window
 * (`half` px each side of the centre) around the projection of a world point.
 */
export function meanLuma(page: Page, probe?: { point: [number, number, number]; half?: number }): Promise<number> {
  return page.evaluate(async (p) => {
    const hook = window.__flat!;
    const img = new Image();
    img.src = hook.capture();
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    let x0 = 0;
    let y0 = 0;
    let w = img.width;
    let h = img.height;
    if (p) {
      const rect = document.querySelector('canvas')!.getBoundingClientRect();
      const scale = img.width / rect.width;
      const at = hook.project(p.point);
      const half = Math.round((p.half ?? 6) * scale);
      x0 = Math.max(0, Math.round((at.x - rect.left) * scale) - half);
      y0 = Math.max(0, Math.round((at.y - rect.top) * scale) - half);
      w = Math.min(img.width - x0, 2 * half + 1);
      h = Math.min(img.height - y0, 2 * half + 1);
    }
    const px = ctx.getImageData(x0, y0, w, h).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += (0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!) / 255;
    return sum / (px.length / 4);
  }, probe);
}
