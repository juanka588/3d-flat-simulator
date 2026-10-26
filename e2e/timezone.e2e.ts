import { expect, test } from '@playwright/test';
import { expectLighting, openApp, rendered } from './helpers';

// The browser runs in Tokyo; the flat is in Paris. When it is 21:30 on 21 Dec in Paris it is already
// 22 Dec 05:30 in Tokyo, so a default date taken from the browser would be a day off.
test.use({ timezoneId: 'Asia/Tokyo' });

const INSTANT = new Date('2026-12-21T20:30:00Z');

test('the default date and the Now button use the site time zone, not the browser one', async ({ page }) => {
  await page.clock.setFixedTime(INSTANT);
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Tokyo');
  expect(await page.evaluate(() => new Date().getDate())).toBe(22); // browser-local day

  await openApp(page);
  await expectLighting(page);
  const site = await page.evaluate(() => window.__flat!.stats().sceneName);
  expect(site).toContain('Charme');

  // Europe/Paris wall clock for the same instant.
  const paris = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(INSTANT);
  const part = (t: string) => paris.find((p) => p.type === t)!.value;
  expect(`${part('year')}-${part('month')}-${part('day')}`).toBe('2026-12-21');

  await expect(page.getByTestId('date-input')).toHaveValue('2026-12-21');

  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await rendered(page);
  await expect(page.getByTestId('date-input')).toHaveValue('2026-12-21');
  // Now rounds to the 5-minute slider step: 21:30 Paris (05:30 in Tokyo).
  await expect(page.getByTestId('time-output')).toHaveText(`${part('hour')}:${part('minute')}`);
});
