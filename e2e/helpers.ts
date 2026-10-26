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
