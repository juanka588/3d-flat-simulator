import { writeFileSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { PNG } from 'pngjs';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';
import { BrowserRenderer, DEFAULT_DIST } from './browserRenderer';
import { McpRenderer } from './service';
import { apply, startFlatServer, toolContext, type RunningServer } from './harness';
import { startStaticServer, type StaticServer } from './staticServer';
import { renderTools } from '../tools/render';
import type { ToolContext } from '../tools/registry';

/**
 * Slow: drives a real headless Chromium (SwiftShader) against a real apps/server. Not part of `pnpm test`:
 * run with `MCP_RENDER=1 pnpm test:render` (needs `BASE_PATH=/ pnpm --filter @flat/web build` and
 * `npx playwright install chromium`). Pixel probes, not golden images.
 */

const SAGE = { id: 'paint-sage', name: 'Sage', kind: 'paint', color: '#9caf88', roughness: 0.9 } as const;
const tool = renderTools()[0]!;

type Img = { type: string; data?: string; mimeType?: string };
const images = (r: CallToolResult) => (r.content as Img[]).filter((c) => c.type === 'image');
const bytes = (c: Img) => Buffer.from(c.data!, 'base64');
const data = (r: CallToolResult) => r.structuredContent as Record<string, any>;
const decode = (c: Img) => PNG.sync.read(bytes(c));

/** Mean RGB of the box [x0,x1)x[y0,y1) given as fractions of the image. */
function meanRgb(png: PNG, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.floor(png.height * y0); y < Math.floor(png.height * y1); y++) {
    for (let x = Math.floor(png.width * x0); x < Math.floor(png.width * x1); x++) {
      const i = (png.width * y + x) * 4;
      r += png.data[i]!; g += png.data[i + 1]!; b += png.data[i + 2]!; n++;
    }
  }
  return [r / n, g / n, b / n];
}
const luma = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function save(name: string, r: CallToolResult, which = 0) {
  writeFileSync(`/tmp/render-${name}.png`, bytes(images(r)[which]!));
}

describe.runIf(process.env.MCP_RENDER)('render service (slow: real browser, real server)', () => {
  let user: StaticServer;
  let srv: RunningServer;
  let browser: BrowserRenderer;
  let ctx: ToolContext;
  const call = (args: Record<string, unknown>) => tool.handler(ctx, args);

  beforeAll(async () => {
    user = await startStaticServer(DEFAULT_DIST);
    srv = await startFlatServer(new URL(user.url).origin);
    browser = new BrowserRenderer();
    ctx = toolContext(srv.flat, { renderer: new McpRenderer(srv.flat, browser) });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await srv?.stop();
    await user?.close();
  });

  it('sizes, PNG magic bytes, metadata, and the sample renders', async () => {
    const r = await call({ view: 'room', roomId: 'sejour' });
    expect(r.isError, JSON.stringify(r.content[0])).toBeFalsy();
    const img = images(r);
    expect(img).toHaveLength(1);
    expect(img[0]!.mimeType).toBe('image/png');
    expect(bytes(img[0]!).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const png = decode(img[0]!);
    expect([png.width, png.height]).toEqual([1024, 768]);
    expect(data(r)).toMatchObject({ ok: true, width: 1024, height: 768, mimeType: 'image/png', view: 'room', roomId: 'sejour', rev: 0 });
    expect(data(r).pose.mode).toBe('orbit');
    expect(data(r).renderMs).toBeGreaterThan(0);
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual(data(r));
    save('sejour-overview', r);

    const small = await call({ view: 'top', size: { width: 640, height: 480 } });
    expect([decode(images(small)[0]!).width, decode(images(small)[0]!).height]).toEqual([640, 480]);
    expect(data(small).warm).toBe(true);
    save('top', small);

    const big = await call({ view: 'orbit', size: { width: 4000, height: 2000 } });
    const bp = decode(images(big)[0]!);
    expect([bp.width, bp.height]).toEqual([1568, 784]);
    expect(data(big).warnings.join(' ')).toMatch(/clamped/);

    const walk = await call({ view: 'walk', roomId: 'sejour', facing: 'door-balcony-sejour', date: '2026-06-21', time: '18:00' });
    expect(walk.isError, JSON.stringify(walk.content[0])).toBeFalsy();
    expect(data(walk)).toMatchObject({ view: 'walk' });
    expect(data(walk).lighting).toMatchObject({ date: '2026-06-21', time: '18:00' });
    expect(data(walk).sun).toMatchObject({ available: true, isUp: true });
    expect(data(walk).sun.elevationDeg).toBeGreaterThan(10);
    save('walk-balcon-18h', walk);
  });

  it('jpeg option', async () => {
    const png = await call({ view: 'room', roomId: 'ch1' });
    const jpg = await call({ view: 'room', roomId: 'ch1', format: 'jpeg' });
    expect(jpg.isError).toBeFalsy();
    const j = images(jpg)[0]!;
    expect(j.mimeType).toBe('image/jpeg');
    expect(bytes(j).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(data(jpg).mimeType).toBe('image/jpeg');
    expect(bytes(j).length).toBeLessThan(bytes(images(png)[0]!).length);
  });

  it('the walk-mode "lights on" comfort preference does not leak into renders', async () => {
    const room = await call({ view: 'room', roomId: 'sejour', preset: 'day' });
    const walk = await call({ view: 'walk', roomId: 'sejour', preset: 'day' });
    expect(data(walk).lampsLit).toEqual(data(room).lampsLit);
    expect(data(walk).lighting.exposureEV).toBe(0);
  });

  it('door leaves are opaque in a walk render (the walk comfort translucency is off)', async () => {
    const view = { view: 'walk', roomId: 'sejour', facing: 'door-balcony-sejour', preset: 'day' };
    const r = await call(view);
    expect(r.isError, JSON.stringify(r.content[0])).toBeFalsy();
    const page = browser.session.page!;
    const leaves = () => page.evaluate('window.__flat.doorLeaves()') as Promise<{ id: string; transparent: boolean; opacity: number }[]>;
    const used = await leaves();
    expect(used.length).toBeGreaterThan(0);
    for (const l of used) expect(l, JSON.stringify(used)).toMatchObject({ id: 'builtin:door', transparent: false, opacity: 1 });
    // Pixels: the same view with the comfort translucency forced on differs where the leaf is.
    const opaque = decode(images(r)[0]!);
    const translucent = PNG.sync.read(
      Buffer.from(((await page.evaluate("(async () => { await window.__flat.setComfort({ translucentDoors: true }); return window.__flat.capture(); })()")) as string).split(',')[1]!, 'base64'),
    );
    await page.evaluate("window.__flat.setComfort({ translucentDoors: false })");
    let changed = 0;
    for (let i = 0; i < opaque.data.length; i += 4) if (Math.abs(opaque.data[i]! - translucent.data[i]!) + Math.abs(opaque.data[i + 1]! - translucent.data[i + 1]!) + Math.abs(opaque.data[i + 2]! - translucent.data[i + 2]!) > 24) changed++;
    expect(changed, 'pixels that differ between opaque and translucent leaves').toBeGreaterThan(200);
    writeFileSync('/tmp/render-walk-door-opaque.png', bytes(images(r)[0]!));
    writeFileSync('/tmp/render-walk-door-translucent.png', PNG.sync.write(translucent));
  });

  it('a render after room_set_wall_finish (sage) shows sage walls (pixel probe)', async () => {
    const view = { view: 'walk', roomId: 'sejour', facing: 'w-sejour-ch2', date: '2026-06-21', time: '12:00' };
    const before = await call(view);
    expect(before.isError, JSON.stringify(before.content[0])).toBeFalsy();
    await apply(srv.flat, { type: 'material.define', material: SAGE });
    await apply(srv.flat, { type: 'room.setWallFinish', roomId: 'sejour', materialId: 'paint-sage' });
    const after = await call(view);
    expect(data(after).rev).toBeGreaterThan(data(before).rev);
    // The wall straight ahead is the middle of the picture.
    const [br, bg, bb] = meanRgb(decode(images(before)[0]!), 0.45, 0.4, 0.55, 0.6);
    const [r, g, b] = meanRgb(decode(images(after)[0]!), 0.45, 0.4, 0.55, 0.6);
    expect(Math.abs(bg - bb), `before ${[br, bg, bb]}`).toBeLessThan(12); // neutral before
    expect(g, `after ${[r, g, b]}`).toBeGreaterThan(b + 12); // green over blue
    expect(g).toBeGreaterThanOrEqual(r); // sage: green >= red >= blue
    expect(r).toBeGreaterThan(b);
    save('sejour-sage', after);
  });

  it('the evening preset with a lamp on is brighter than with it off', async () => {
    const view = { view: 'walk', roomId: 'sejour', preset: 'evening' };
    const on = await call(view);
    const off = await call({ ...view, lamps: { 'l-sejour': { on: false }, 'l-cuisine': { on: false } } });
    expect(data(on).lampsLit).toEqual(expect.arrayContaining(['l-sejour']));
    expect(data(off).lampsLit).not.toContain('l-sejour');
    expect(data(on).sun.isUp).toBe(false);
    expect(data(on).warnings.join(' ')).toMatch(/sun below horizon/);
    const lOn = luma(meanRgb(decode(images(on)[0]!), 0, 0, 1, 1));
    const lOff = luma(meanRgb(decode(images(off)[0]!), 0, 0, 1, 1));
    expect(lOn, `on ${lOn} off ${lOff}`).toBeGreaterThan(lOff * 1.2);
    // Near the lamp (the upper-middle of the picture, where the ceiling light is) the gain is bigger still.
    const nearOn = luma(meanRgb(decode(images(on)[0]!), 0.3, 0.2, 0.7, 0.45));
    const nearOff = luma(meanRgb(decode(images(off)[0]!), 0.3, 0.2, 0.7, 0.45));
    expect(nearOn).toBeGreaterThan(nearOff * 1.2);
    save('evening', on);
  });

  it('unknown_room lists the nearest ids; a facing target not in the room lists its walls', async () => {
    const r = await call({ view: 'room', roomId: 'sejoure' });
    expect(r.isError).toBe(true);
    expect(data(r).code).toBe('unknown_room');
    expect(data(r).hint).toContain('"sejour"');
    const f = await call({ view: 'walk', roomId: 'ch1', facing: 'w-sejour-ch2' });
    expect(f.isError).toBe(true);
    expect(data(f).code).toBe('invalid_command');
    expect(data(f).hint).toMatch(/walls \[|walls of/);
    const none = await call({ view: 'walk', facing: 'N' });
    expect(data(none).code).toBe('invalid_command');
  });

  it('compare returns the after and the before image', async () => {
    await call({ view: 'room', roomId: 'ch1' });
    const revBefore = data(await call({ view: 'top' })).rev;
    await apply(srv.flat, { type: 'room.setWallFinish', roomId: 'ch1', materialId: 'paint-sage' });
    const r = await call({ view: 'walk', roomId: 'ch1', facing: 'w-ch2-ch1', compare: 'before_after' });
    expect(r.isError, JSON.stringify(r.content[0])).toBeFalsy();
    expect(images(r)).toHaveLength(2);
    expect(data(r).compare).toEqual({ beforeRev: revBefore });
    expect(data(r).images.map((i: { label: string }) => i.label)).toEqual(['after', 'before']);
    const a = decode(images(r)[0]!);
    const b = decode(images(r)[1]!);
    expect(meanRgb(a, 0.4, 0.4, 0.6, 0.6)[1] - meanRgb(a, 0.4, 0.4, 0.6, 0.6)[2]).toBeGreaterThan(meanRgb(b, 0.4, 0.4, 0.6, 0.6)[1] - meanRgb(b, 0.4, 0.4, 0.6, 0.6)[2] + 8);
  });

  it('reloads the scene in the page only when (epoch, rev) changes; previews always load and dirty the cache', async () => {
    const loads = () => browser.stats.sceneLoads;
    await call({ view: 'top' });
    const base = loads();
    await call({ view: 'room', roomId: 'ch2' });
    await call({ view: 'walk', roomId: 'ch2' });
    expect(loads()).toBe(base);
    await apply(srv.flat, { type: 'light.update', id: 'l-ch2', patch: { lumens: 777 } });
    await call({ view: 'top' });
    expect(loads()).toBe(base + 1);
    await call({ view: 'top' });
    expect(loads()).toBe(base + 1);
    // A preview state is always loaded...
    const sc = await srv.flat.getScene();
    if (!sc.ok) throw new Error('scene');
    const r = (ctx.renderer as unknown as McpRenderer).render({ view: 'top' }, { scene: sc.data });
    await r;
    expect(loads()).toBe(base + 2);
    // ... and the committed scene is reloaded afterwards, even at the same rev.
    await call({ view: 'top' });
    expect(loads()).toBe(base + 3);
  });

  it("does not touch the user's tab", async () => {
    const ub: Browser = await launchBrowser(undefined);
    try {
      const page: Page = await ub.newPage({ viewport: { width: 900, height: 600 } });
      await page.goto(`${user.url}?test&server=${encodeURIComponent(srv.url)}`);
      await page.waitForFunction("window.__flat && window.__flat.connection().status === 'connected'", undefined, { timeout: 30_000 });
      await page.evaluate("window.__flat.ready");
      const snap = () =>
        page.evaluate(`(() => { const f = window.__flat; const s = f.stats(); return { mode: s.mode, camera: s.camera, lamps: s.lights.lampsLit, ev: s.exposure, sun: f.sunInfo().time + f.sunInfo().date, size: s.canvasSize, rev: f.connection().rev }; })()`) as Promise<Record<string, unknown>>;
      const before = await snap();
      const r = await call({ view: 'walk', roomId: 'sejour', preset: 'night', size: { width: 512, height: 384 } });
      expect(r.isError).toBeFalsy();
      await call({ view: 'top', preset: 'evening' });
      const after = await snap();
      expect(after).toEqual(before);
    } finally {
      await ub.close();
    }
  });

  it('recovers transparently after the browser is killed, and after a page crash', async () => {
    const launches = browser.stats.launches;
    await browser.session.browser!.close();
    const r = await call({ view: 'top', size: { width: 320, height: 240 } });
    expect(r.isError, JSON.stringify(r.content[0])).toBeFalsy();
    expect(data(r).warm).toBe(false);
    expect(browser.stats.launches).toBe(launches + 1);

    const crashed = browser.session.page!.goto('chrome://crash').catch(() => undefined);
    await crashed;
    const r2 = await call({ view: 'top', size: { width: 320, height: 240 } });
    expect(r2.isError, JSON.stringify(r2.content[0])).toBeFalsy();
  });

  it('the call beyond a full queue (depth 3) is "busy"; the queued ones succeed', async () => {
    await browser.session.discard(); // cold start keeps the first render busy long enough
    const results = await Promise.all([1, 2, 3, 4].map(() => call({ view: 'top', size: { width: 320, height: 240 } })));
    const failed = results.filter((x) => x.isError);
    expect(failed).toHaveLength(1);
    expect(data(failed[0]!)).toMatchObject({ code: 'render_unavailable' });
    expect(data(failed[0]!).message).toMatch(/busy/);
    expect(results.filter((x) => !x.isError)).toHaveLength(3);
  });

  it('a hard timeout becomes render_timeout, leaves no browser behind, and the next call recovers', async () => {
    const slow = new BrowserRenderer({ timeoutMs: 1, coldTimeoutMs: 1 });
    const c = toolContext(srv.flat, { renderer: new McpRenderer(srv.flat, slow) });
    try {
      const r = await tool.handler(c, { view: 'top' });
      expect(r.isError).toBe(true);
      expect(data(r).code).toBe('render_timeout');
      expect(data(r).message).toMatch(/start the browser/);
      // The abandoned cold start finishes in the background and must tear itself down (no orphan Chromium).
      await new Promise((ok) => setTimeout(ok, 6000));
      expect(slow.session.isWarm).toBe(false);
      expect(slow.session.browser).toBeUndefined();
    } finally {
      await slow.close();
    }
  }, 30_000);

  it('a cold start gets the longer cold budget: a 1 ms warm timeout does not fail the first render', async () => {
    const cold = new BrowserRenderer({ timeoutMs: 1 });
    const c = toolContext(srv.flat, { renderer: new McpRenderer(srv.flat, cold) });
    try {
      const r = await tool.handler(c, { view: 'top', size: { width: 320, height: 240 } });
      expect(r.isError, JSON.stringify(r.content[0])).toBeFalsy();
      expect(images(r)).toHaveLength(1);
    } finally {
      await cold.close();
    }
  }, 90_000);
});
