import { readFileSync, writeFileSync } from 'node:fs';
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

/** Asserts that the sun/exposure maths in `@flat/scene` works (lighting tests must never skip silently). */
export async function expectLighting(page: Page): Promise<void> {
  const info = await page.evaluate(() => window.__flat!.sunInfo());
  expect(info.available, info.available ? '' : `lighting maths unavailable: ${info.error}`).toBe(true);
}

/** Writes the current canvas to a PNG file. */
export async function savePng(page: Page, file: string): Promise<void> {
  const url = await page.evaluate(() => window.__flat!.capture());
  writeFileSync(file, Buffer.from(url.split(',')[1]!, 'base64'));
}

/** Plan point (x, z) as a floor-level world point. */
export const floorPoint = (x: number, z: number): [number, number, number] => [x, 0, z];

/** True when a plan point lies inside a polygon (even-odd rule). */
export function inPolygon(p: [number, number], polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
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

/**
 * Luma (0-255, Rec. 709 on sRGB values) of the canvas pixels along a vertical scanline: the column
 * at `xFrac` of the canvas width, rows `y0Frac` to `y1Frac` of its height, top to bottom.
 */
export function columnLuma(page: Page, xFrac: number, y0Frac: number, y1Frac: number): Promise<number[]> {
  return page.evaluate(
    async (a) => {
      const img = new Image();
      img.src = window.__flat!.capture();
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const x = Math.round(a.xFrac * (img.width - 1));
      const y0 = Math.round(a.y0Frac * img.height);
      const y1 = Math.round(a.y1Frac * img.height);
      const px = ctx.getImageData(x, y0, 1, y1 - y0).data;
      const out: number[] = [];
      for (let i = 0; i < px.length; i += 4) out.push(0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!);
      return out;
    },
    { xFrac, y0Frac, y1Frac },
  );
}

/** Largest |second difference| of a scanline: ~0 for a smooth gradient, large for stripes (shadow acne). */
export function maxSecondDifference(values: number[]): number {
  let max = 0;
  for (let i = 1; i < values.length - 1; i++) max = Math.max(max, Math.abs(values[i - 1]! - 2 * values[i]! + values[i + 1]!));
  return max;
}
