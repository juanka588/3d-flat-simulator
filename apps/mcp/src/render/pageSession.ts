import type { Browser, Page } from 'playwright';
import type { CameraPose, LightingView, SceneResponse } from '@flat/scene';
import { launchBrowser, type RenderChannel } from './browser';
import { startStaticServer, type StaticServer } from './staticServer';

/**
 * The warm page. One Chromium, one context, one page showing the built viewer in local mode
 * (`?test&w=&h=&dpr=1`, no `?server=`: it is never a sync client and never touches the user's tab).
 * The walk-comfort "lights on in walk mode" preference is seeded OFF so a render is a pure function
 * of the lighting it is given.
 */

/** localStorage key of the walk-mode "lights on" preference (apps/web/src/state/effectiveLighting.ts). */
export const WALK_LIGHTS_KEY = 'flat.walkLightsOn';

export type FailureKind = 'timeout' | 'dead' | 'unavailable';

/** A failure of the render machinery. `dead`: the page/browser is gone (recreate and retry). */
export class SessionError extends Error {
  constructor(
    public readonly kind: FailureKind,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export interface PageJob {
  /** The scene to draw; loaded into the page only when `(epoch, rev)` differs from what is there, or `preview`. */
  scene: SceneResponse;
  /** Preview state: always loaded, and the page is then marked dirty so the next committed render reloads. */
  preview: boolean;
  pose: CameraPose;
  lighting: LightingView;
  size: { width: number; height: number };
  format: 'png' | 'jpeg';
}

export interface PageOutput {
  /** Encoded image bytes. */
  data: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  /** Whether the scene had to be (re)loaded into the page for this render. */
  sceneLoaded: boolean;
  sun: { available: boolean; isUp?: boolean; altitudeDeg?: number; azimuthDeg?: number };
  lampsLit: string[];
  /** The pose the viewer reports following. */
  appliedPose: CameraPose | null;
  contextLost: boolean;
}

interface Handle {
  browser: Browser;
  page: Page;
  server: StaticServer | undefined;
  /** `(epoch, rev)` of the scene in the page; `null`: unknown/dirty. */
  sceneKey: string | null;
  viewport: { width: number; height: number };
  dead: boolean;
}

export interface SessionOptions {
  /** Directory of the built web app, served on loopback. Ignored when `webUrl` is an http(s) URL. */
  distDir: string;
  webUrl?: string | undefined;
  channel: RenderChannel;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface SessionStats {
  launches: number;
  pageLoads: number;
  sceneLoads: number;
  renders: number;
}

const INIT_SCRIPT = `
  try { localStorage.setItem(${JSON.stringify(WALK_LIGHTS_KEY)}, '0'); } catch {}
  window.__renderCtxLost = false;
  document.addEventListener('webglcontextlost', () => { window.__renderCtxLost = true; }, true);
`;

/** Runs inside the page. A string, not a function: the TS toolchain (tsx/esbuild) must not rewrite it. */
const RENDER_SCRIPT = `async (a) => {
  const f = window.__flat;
  if (!f) return { error: 'the viewer test hook is missing' };
  if (a.viewport) await f.setViewport({ width: a.viewport.width, height: a.viewport.height, dpr: 1 });
  let sceneError = null;
  if (a.scene) {
    const r = await f.loadScene(a.scene);
    if (!r.ok) sceneError = (r.errors || []).join('; ') || 'the viewer rejected the scene';
  }
  if (sceneError) return { error: sceneError };
  if (f.setComfort) await f.setComfort({ translucentDoors: false });
  await f.setLighting(a.lighting);
  await f.setCamera(a.pose);
  await f.whenRendered();
  let dataUrl = f.capture();
  let mimeType = 'image/png';
  if (a.format === 'jpeg') {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const oc = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = oc.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, bmp.width, bmp.height);
    ctx.drawImage(bmp, 0, 0);
    const blob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    dataUrl = await new Promise((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => bad(fr.error); fr.readAsDataURL(blob); });
    mimeType = 'image/jpeg';
  }
  const s = f.stats();
  const sun = f.sunInfo();
  return {
    dataUrl, mimeType, canvasSize: s.canvasSize, lampsLit: s.lights.lampsLit, pose: s.pose,
    sun: sun.available ? { available: true, isUp: sun.isUp, altitudeDeg: sun.altitudeDeg, azimuthDeg: sun.azimuthDeg } : { available: false },
    contextLost: !!window.__renderCtxLost,
  };
}`;

const DEAD = /closed|crash|disconnected|Target page|Execution context was destroyed|context lost|has been closed|browser has been/i;

export class PageSession {
  readonly stats: SessionStats = { launches: 0, pageLoads: 0, sceneLoads: 0, renders: 0 };
  private handle: Handle | undefined;

  constructor(private readonly opts: SessionOptions) {}

  /** Test/diagnostic access to the live browser (undefined when torn down). */
  get browser(): Browser | undefined {
    return this.handle?.browser;
  }
  get page(): Page | undefined {
    return this.handle?.page;
  }
  get isWarm(): boolean {
    return !!this.handle && !this.handle.dead;
  }

  async close(): Promise<void> {
    const h = this.handle;
    this.handle = undefined;
    if (!h) return;
    h.dead = true;
    await h.page.close({ runBeforeUnload: false }).catch(() => undefined);
    await h.browser.close().catch(() => undefined);
    await h.server?.close().catch(() => undefined);
  }

  /** Marks the page unusable (the next render recreates browser and page). */
  async discard(): Promise<void> {
    await this.close();
  }

  private async open(size: { width: number; height: number }): Promise<Handle> {
    const { opts } = this;
    let server: StaticServer | undefined;
    let base: string;
    if (opts.webUrl && /^https?:\/\//i.test(opts.webUrl)) {
      base = opts.webUrl;
    } else {
      server = await startStaticServer(opts.webUrl ?? opts.distDir);
      base = server.url;
    }
    let browser: Browser;
    try {
      browser = await launchBrowser(opts.channel);
    } catch (e) {
      await server?.close().catch(() => undefined);
      const msg = e instanceof Error ? e.message : String(e);
      throw new SessionError('unavailable', `cannot launch the headless browser: ${msg.split('\n')[0]}`, 'Install it with `npx playwright install chromium` (or set FLAT_RENDER_CHANNEL=chrome to use the installed Chrome).');
    }
    this.stats.launches += 1;
    const handle: Handle = { browser, page: undefined as unknown as Page, server, sceneKey: null, viewport: size, dead: false };
    browser.on('disconnected', () => {
      handle.dead = true;
    });
    try {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
      await context.addInitScript(INIT_SCRIPT);
      const page = await context.newPage();
      page.on('crash', () => {
        handle.dead = true;
      });
      page.on('pageerror', (e) => opts.log('warn', `render page error: ${e.message}`));
      handle.page = page;
      const url = new URL(base);
      url.search = `?test&w=${size.width}&h=${size.height}&dpr=1`;
      await page.goto(url.toString(), { waitUntil: 'load' });
      await page.waitForFunction('window.__flat !== undefined', undefined, { timeout: 15_000 });
      await page.evaluate('window.__flat.ready');
      this.stats.pageLoads += 1;
    } catch (e) {
      await browser.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
      throw e;
    }
    return handle;
  }

  /** Draws `job`. Throws `SessionError` (`dead` when the page/browser is gone) or the underlying error. */
  async render(job: PageJob): Promise<{ out: PageOutput; warm: boolean }> {
    const warm = this.isWarm;
    if (!warm) {
      await this.close();
      this.handle = await this.open(job.size);
    }
    const h = this.handle!;
    try {
      const key = `${job.scene.epoch}:${job.scene.rev}`;
      const mustLoad = job.preview || h.sceneKey !== key;
      const viewport = h.viewport.width !== job.size.width || h.viewport.height !== job.size.height ? job.size : undefined;
      const arg = { viewport, scene: mustLoad ? job.scene.scene : undefined, lighting: job.lighting, pose: job.pose, format: job.format };
      // The scene is dirty from the moment we start replacing it until a committed one is in.
      if (mustLoad) h.sceneKey = null;
      const r = (await h.page.evaluate(([src, a]) => (0, eval)(src as string)(a), [RENDER_SCRIPT, arg] as const)) as
        | { error: string }
        | { dataUrl: string; mimeType: 'image/png' | 'image/jpeg'; canvasSize: [number, number]; lampsLit: string[]; pose: CameraPose | null; sun: PageOutput['sun']; contextLost: boolean };
      if ('error' in r) throw new SessionError('unavailable', `the viewer could not draw the scene: ${r.error}`);
      if (viewport) h.viewport = viewport;
      if (mustLoad) {
        this.stats.sceneLoads += 1;
        h.sceneKey = job.preview ? null : key;
      }
      this.stats.renders += 1;
      if (r.contextLost) {
        await this.discard();
        throw new SessionError('dead', 'WebGL context lost while rendering');
      }
      const comma = r.dataUrl.indexOf(',');
      return {
        warm,
        out: {
          data: Buffer.from(r.dataUrl.slice(comma + 1), 'base64'),
          mimeType: r.mimeType,
          width: r.canvasSize[0],
          height: r.canvasSize[1],
          sceneLoaded: mustLoad,
          sun: r.sun,
          lampsLit: r.lampsLit,
          appliedPose: r.pose,
          contextLost: false,
        },
      };
    } catch (e) {
      if (e instanceof SessionError) throw e;
      if (h.dead || DEAD.test(e instanceof Error ? e.message : String(e))) {
        await this.discard();
        throw new SessionError('dead', `the render browser went away: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
      }
      throw e;
    }
  }
}
