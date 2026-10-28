/**
 * M5.13 catalog UI: search real (mock) products on a real scene server, drag a card onto the 3D view, ghost
 * validity, drop refusal, undo, the item properties, keyboard editing, the locked placard, paste a URL, and the
 * mobile drawer with a long-press drag.
 *
 * Screenshots (always written): catalog-search.png, catalog-ghost-red.png, catalog-placed.png,
 * catalog-properties.png, catalog-mobile.png.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { flat } from './helpers';
import { openConnected, startServer, WEB_ORIGIN } from './server';
import type { RunningServer } from './server';

test.describe.configure({ timeout: 120_000 });

let server: RunningServer;
test.beforeAll(async () => {
  server = await startServer({ providers: 'mock' });
});
test.afterAll(async () => {
  await server?.stop();
});

// A 1x1 PNG for the product photos (the mock products point at a host that does not exist).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Requests the browser sent to the retailer's host: there must be none. */
const hotlinked: string[] = [];

async function prepare(page: Page): Promise<void> {
  hotlinked.length = 0;
  await page.route('https://shop.mock.example/**', (r) => (hotlinked.push(r.request().url()), r.fulfill({ status: 200, contentType: 'image/png', body: PNG })));
  await openConnected(page, server);
  await flat(page, (f) => f.setView({ mode: 'top' }));
}

async function search(page: Page, text: string): Promise<void> {
  await page.getByTestId('catalog-search').fill(text);
  await expect(page.getByTestId('product-card').first()).toBeVisible({ timeout: 15_000 });
}

/** Screen position of a plan point on the floor. */
const screenOf = (page: Page, x: number, z: number) => page.evaluate(([px, pz]) => window.__flat!.project([px!, 0, pz!]), [x, z]);

/** Presses a card and drags it to a plan point; leaves the button down. */
async function dragTo(page: Page, card: ReturnType<Page['getByTestId']>, x: number, z: number): Promise<void> {
  await card.scrollIntoViewIfNeeded();
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 4, { steps: 3 });
  const to = await screenOf(page, x, z);
  await page.mouse.move(to.x, to.y, { steps: 8 });
}

const ghost = (page: Page) => page.evaluate(() => window.__flat!.placement().ghost);
const items = (page: Page) => page.evaluate(() => window.__flat!.getScene().items.map((i) => i.id));
const entries = (page: Page) => page.evaluate(() => window.__flat!.history().entries.length);

test('search, red ghost over the door swing, refused drop, valid drop, undo', async ({ page }) => {
  await prepare(page);
  await search(page, 'bed');
  const card = page.locator('[data-testid=product-card][data-product-id="mock:MOCK-BED-160"]');
  await expect(card).toContainText('299,00');
  await expect(card).toContainText('TTC');
  await expect(card.getByTestId('card-dims')).toContainText('160 × 200 × 90 cm');
  await expect(card.locator('.badge-3d')).toHaveText('3D');
  // photos only ever come through the local server (never hotlinked from the retailer's host)
  expect(hotlinked).toEqual([]);
  await expect(page.getByTestId('product-card').filter({ hasText: 'Bedside' }).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('catalog-search.png') });

  const before = await items(page);
  const h0 = await entries(page);

  // over the door swing of Chambre 1: red, with the violation next to the cursor
  await dragTo(page, card, 8.05, 2.75);
  await expect.poll(async () => (await ghost(page))?.valid).toBe(false);
  expect((await ghost(page))!.message).toMatch(/swing|landing/);
  await expect(page.getByTestId('ghost-tip')).toHaveAttribute('data-valid', 'false');
  await expect(page.getByTestId('ghost-tip')).toContainText(/swing|landing/);
  await page.screenshot({ path: test.info().outputPath('catalog-ghost-red.png') });
  await page.mouse.up();
  await expect(page.getByTestId('placement-notice')).toContainText(/Can't place/);
  expect(await items(page)).toEqual(before);
  expect(await entries(page)).toBe(h0);

  // a valid spot: green, one history entry
  await dragTo(page, card, 8.2, 2.0);
  await expect.poll(async () => (await ghost(page))?.valid).toBe(true);
  await expect(page.getByTestId('ghost-tip')).toHaveAttribute('data-valid', 'true');
  await page.mouse.up();
  await expect.poll(async () => (await items(page)).length).toBe(before.length + 1);
  await expect.poll(() => entries(page)).toBe(h0 + 1);
  const placed = await flat(page, (f) => f.getScene().items.at(-1)!);
  expect(placed.productRef).toEqual({ provider: 'mock', sku: 'MOCK-BED-160' });
  expect(placed.product!.price).toBe(299);
  expect(placed.dims).toEqual({ w: 1.6, d: 2, h: 0.9 });
  expect(placed.roomId).toBe('ch1');
  await flat(page, (f) => f.whenRendered());
  await page.screenshot({ path: test.info().outputPath('catalog-placed.png') });

  // Ctrl+Z removes it
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await items(page)).length).toBe(before.length);
});

test('item properties, nudge, rotate, delete and the locked placard', async ({ page }) => {
  await prepare(page);
  await search(page, 'bed');
  const card = page.locator('[data-testid=product-card][data-product-id="mock:MOCK-BED-160"]');
  await dragTo(page, card, 8.2, 2.0);
  await page.mouse.up();
  const props = page.getByTestId('item-properties');
  await expect(props).toBeVisible();
  await expect(props.getByTestId('item-price')).toContainText('299,00');
  await expect(props.getByTestId('item-date')).toContainText(String(new Date().getUTCFullYear()));
  const link = props.getByTestId('item-link');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('href', 'https://shop.mock.example/p/mock-bed-160');
  await expect(props.getByTestId('badge-mesh')).toBeVisible();
  await expect(page.getByTestId('room-items')).toContainText('MOCK Double bed frame');
  await expect(page.getByTestId('flat-total')).toContainText('299,00');
  await page.screenshot({ path: test.info().outputPath('catalog-properties.png') });

  const id = (await items(page)).at(-1)!;
  const get = () => flat(page, (f) => f.getScene().items.at(-1)!);
  const p0 = (await get()).position;
  await page.locator('canvas').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await get()).position[0]).toBeCloseTo(p0[0] + 0.01, 4);
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => (await get()).position[1]).toBeCloseTo(p0[1] + 0.05, 4);
  await page.keyboard.press('r');
  await expect.poll(async () => (await get()).rotation).toBe(90);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await items(page)).includes(id)).toBe(false);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await items(page)).includes(id)).toBe(true);

  // the placard: locked, built-in, nothing to remove
  await flat(page, (f) => f.select('placard-ch1'));
  await expect(props.getByTestId('badge-builtin')).toHaveText('Built-in (locked)');
  await expect(props.getByTestId('remove-item')).toHaveCount(0);
  await expect(props.getByTestId('lock-toggle')).toHaveCount(0);
  await page.keyboard.press('Delete');
  expect(await items(page)).toContain('placard-ch1');
});

test('the gizmo moves and rotates the selected item (one history entry per drag), a wall mount has an elevation handle', async ({ page }) => {
  await prepare(page);
  const base = (await items(page)).length; // the flat's own fixtures (placards, kitchen, bathroom...) plus the TV
  await search(page, 'bed');
  const card = page.locator('[data-testid=product-card][data-product-id="mock:MOCK-BED-160"]');
  await dragTo(page, card, 5.4, 1.9);
  await page.mouse.up();
  await expect.poll(async () => (await items(page)).length).toBe(base + 1);
  const get = () => flat(page, (f) => f.getScene().items.at(-1)!);
  const h0 = await entries(page);

  // move: grab the item, drop it 0.4 m north
  const from = await screenOf(page, 5.4, 1.9);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const to = await screenOf(page, 5.4, 1.5);
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await get()).position[1]).toBeCloseTo(1.5, 2);
  expect(await entries(page)).toBe(h0 + 1);

  // rotate: grab the ring (1.4 m east of the centre) and bring it to the west side (half a turn)
  const ring0 = await screenOf(page, 5.4 + 1.4, 1.6);
  await page.mouse.move(ring0.x, ring0.y);
  await page.mouse.down();
  // (a quarter turn would stand the bed across the room's walkway to the window: the release is refused and the turn reverted, see placement.test.ts)
  const ring1 = await screenOf(page, 5.4 - 1.4, 1.5);
  await page.mouse.move(ring1.x, ring1.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await get()).rotation).toBe(180);
  expect(await entries(page)).toBe(h0 + 2);

  // a wall mount: against the west wall of Chambre 2 (back flush), at a height that fits under the ceiling
  await page.getByTestId('catalog-search').fill('mirror');
  const mirror = page.locator('[data-testid=product-card][data-product-id="mock:MOCK-MIRR-50"]');
  await expect(mirror).toBeVisible();
  await dragTo(page, mirror, 4.2, 1.5);
  await expect.poll(async () => (await ghost(page))?.valid).toBe(true);
  await page.mouse.up();
  await expect.poll(async () => (await items(page)).length).toBe(base + 2);
  const m = await get();
  expect(m.mount).toBe('wall');
  expect(m.rotation).toBe(90);
  expect(m.position[0]).toBeCloseTo(4.14 + 0.015, 2);
  expect(m.elevation + 1.5).toBeLessThanOrEqual(2.5);
  const handle = await page.evaluate(() => window.__flat!.project([4.2, 1.2, 1.5]));
  expect(handle.x).toBeGreaterThan(0);
});

test('paste a product URL (mock) and fill the missing size', async ({ page }) => {
  await prepare(page);
  await page.getByTestId('paste-url').fill('https://shop.mock.example/p/mock-desk-120');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByTestId('product-card').first()).toContainText('MOCK Desk 120x60');
  await expect(page.getByTestId('product-card').first()).toContainText('pasted');
  // an unknown page is refused with the server's message
  await page.getByTestId('paste-url').fill('https://shop.mock.example/p/nothing');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByTestId('paste-error')).toContainText(/not know|cannot|URL/i);
  // a page without sizes: the W/D/H form, then the card carries "your sizes"
  await page.route(`${server.url}/api/products/resolve`, (r) =>
    r.fulfill({
      status: 422,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': WEB_ORIGIN },
      body: JSON.stringify({
        ok: false,
        errors: [{ code: 'product_dims_missing', path: '', message: 'no depth in the data', hint: 'type the sizes', details: { draft: { provider: 'pasted-url', sku: 'abcdef0123456789', name: 'Canape pasted', url: 'https://www.meubles-exemple.fr/p/canape', price: 450, currency: 'EUR', priceTtc: true, category: 'sofa' } } }],
      }),
    }),
  );
  await page.getByTestId('paste-url').fill('https://www.meubles-exemple.fr/p/canape');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByTestId('dims-form')).toBeVisible();
  await page.getByTestId('dims-w').fill('200');
  await page.getByTestId('dims-d').fill('90');
  await page.getByTestId('dims-h').fill('85');
  await page.getByTestId('dims-submit').click();
  const card = page.getByTestId('product-card').first();
  await expect(card).toContainText('Canape pasted');
  await expect(card.getByTestId('card-dims')).toContainText('200 × 90 × 85 cm (your sizes)');
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test('the drawer: search, long-press a card, drag it onto the view; the bottom sheet still works', async ({ page }) => {
    await page.route('https://shop.mock.example/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await openConnected(page, server);
    await flat(page, (f) => f.setView({ mode: 'top' }));
    await page.getByRole('button', { name: 'Menu' }).tap();
    await search(page, 'bed');
    const before = (await items(page)).length;
    const cardSel = '[data-testid=product-card][data-product-id="mock:MOCK-BED-160"]';
    // a touch long press (350 ms) picks the card up: the drawer closes, the ghost follows the finger
    await page.evaluate((sel) => {
      const el = document.querySelector(sel)!;
      const r = el.getBoundingClientRect();
      const ev = (type: string, x: number, y: number) => new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      el.dispatchEvent(ev('pointerdown', r.x + r.width / 2, r.y + r.height / 2));
    }, cardSel);
    await expect(page.locator('.app.mobile.menu-closed')).toBeVisible();
    const to = await screenOf(page, 8.2, 2.0);
    await page.evaluate(([x, y]) => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: x!, clientY: y! })), [to.x, to.y]);
    await expect.poll(async () => (await ghost(page))?.valid).toBe(true);
    await page.screenshot({ path: test.info().outputPath('catalog-mobile.png') });
    await page.evaluate(([x, y]) => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: x!, clientY: y! })), [to.x, to.y]);
    await expect.poll(async () => (await items(page)).length).toBe(before + 1);
    // the bottom sheet opens compact with the price, and expands on tap
    const sheet = page.getByTestId('properties');
    await expect(sheet.getByTestId('sheet-summary')).toContainText('299');
    await sheet.getByRole('button', { name: /Show details/ }).tap();
    await expect(sheet.getByTestId('item-price')).toContainText('299,00');
    await sheet.getByTestId('remove-item').tap();
    await expect.poll(async () => (await items(page)).length).toBe(before);
  });
});

test('keyboard: "Add to room" places a card through the solver, and item keys leave fields alone', async ({ page }) => {
  await prepare(page);
  await search(page, 'bed');
  const card = page.locator('[data-testid=product-card][data-product-id="mock:MOCK-BED-160"]');
  const before = await items(page);
  const add = card.getByTestId('add-to-room');
  await add.focus();
  await expect(add).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await items(page)).length).toBe(before.length + 1);
  const placed = (await items(page)).at(-1)!;
  const item = await flat(page, (f) => f.getScene().items.at(-1)!);
  expect(item.relation).toBeTruthy();
  expect(item.roomId).toBeTruthy();
  await expect(page.getByTestId('item-properties')).toBeVisible();
  expect((await page.evaluate(() => window.__flat!.placement())).notice).toMatch(/Added/);

  // focus in the search field: arrows and Delete belong to the field, the item stays
  await page.getByTestId('catalog-search').focus();
  const p0 = item.position;
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Delete');
  expect((await items(page)).includes(placed)).toBe(true);
  expect((await flat(page, (f) => f.getScene().items.at(-1)!)).position).toEqual(p0);
});
