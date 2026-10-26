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
