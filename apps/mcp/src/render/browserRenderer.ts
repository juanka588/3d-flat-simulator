import { fileURLToPath } from 'node:url';
import { RENDER_LIMITS, type CameraPose, type LightingView, type SceneResponse } from '@flat/scene';
import type { RenderChannel } from './browser';
import { PageSession, SessionError, type ModelSource, type PageOutput } from './pageSession';
import { QueueBusyError, SerialQueue } from './queue';
import { hasBuild } from './staticServer';

/**
 * The render service (M4.9): a warm headless Chromium showing the built viewer, driven through
 * `window.__flat`. `render()` is a pure function of (scene@rev, pose, lighting, size): the scene is
 * loaded into the page only when `(epoch, rev)` changes (or for a preview), everything else is set per call.
 *
 * Build the viewer for the loopback server with `BASE_PATH=/ pnpm --filter @flat/web build` (any base
 * path works: it is read from `dist/index.html`). `FLAT_WEB_URL` points at another directory or at a
 * running web app (`http://127.0.0.1:5173/`).
 */

export const DEFAULT_DIST = fileURLToPath(new URL('../../../web/dist', import.meta.url));
export const BUILD_HINT = 'Run `pnpm mcp:setup` in the repo (it runs `BASE_PATH=/ pnpm --filter @flat/web build` and installs Chromium), or set FLAT_WEB_URL to a running web app, then retry.';

import { RenderError } from './errors';

export interface RenderRequest {
  scene: SceneResponse;
  /** An uncommitted (preview) state: always loaded into the page, never cached. */
  preview?: boolean;
  pose: CameraPose;
  lighting: LightingView;
  size: { width: number; height: number };
  format?: 'png' | 'jpeg';
  /** Where the viewer gets provider models from (see `ModelSource`). */
  models?: ModelSource | undefined;
}

export interface RenderOutput extends Omit<PageOutput, 'sceneLoaded' | 'contextLost'> {
  renderMs: number;
  /** The warm page was reused (no browser start). */
  warm: boolean;
  sceneLoaded: boolean;
}

export interface RendererOptions {
  /** Directory of the built web app (default `apps/web/dist`) or, when it is an http(s) URL, a running web app. */
  webUrl?: string | undefined;
  distDir?: string;
  channel?: RenderChannel;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  timeoutMs?: number;
  /** Budget of a render that has to start the browser first (launch + viewer load + shader compile can take 15 s or more on a cold machine). */
  coldTimeoutMs?: number;
  /** Idle time after which the browser is closed. */
  idleMs?: number;
  /** Renders in flight (running + waiting) before `render_unavailable` "busy". */
  maxQueue?: number;
}

export const IDLE_MS = 10 * 60_000;
/** Default budget of a cold render. */
export const COLD_TIMEOUT_MS = 60_000;

/** The long edge clamped to `RENDER_LIMITS.maxEdgePx`, aspect kept; `clamped` tells whether it changed. */
export function clampSize(size: { width: number; height: number }): { width: number; height: number; clamped: boolean } {
  const long = Math.max(size.width, size.height);
  if (long <= RENDER_LIMITS.maxEdgePx) return { ...size, clamped: false };
  const k = RENDER_LIMITS.maxEdgePx / long;
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)), clamped: true };
}

export class BrowserRenderer {
  readonly session: PageSession;
  private readonly queue: SerialQueue;
  private readonly timeoutMs: number;
  private readonly coldTimeoutMs: number;
  private readonly idleMs: number;
  private readonly distDir: string;
  private readonly webUrl: string | undefined;
  private idle: NodeJS.Timeout | undefined;

  constructor(opts: RendererOptions = {}) {
    this.distDir = opts.distDir ?? DEFAULT_DIST;
    this.webUrl = opts.webUrl;
    this.timeoutMs = opts.timeoutMs ?? RENDER_LIMITS.timeoutMs;
    this.coldTimeoutMs = Math.max(this.timeoutMs, opts.coldTimeoutMs ?? COLD_TIMEOUT_MS);
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.queue = new SerialQueue(opts.maxQueue ?? 3);
    this.session = new PageSession({ distDir: this.distDir, webUrl: this.webUrl, channel: opts.channel, log: opts.log ?? (() => undefined) });
  }

  get stats() {
    return this.session.stats;
  }

  /** Throws `render_unavailable` when there is no web build to serve. */
  private checkBuild(): void {
    const target = this.webUrl;
    if (target && /^https?:\/\//i.test(target)) return;
    const dir = target ?? this.distDir;
    if (!hasBuild(dir)) throw new RenderError('render_unavailable', `the web app build was not found at ${dir}`, BUILD_HINT);
  }

  async render(req: RenderRequest): Promise<RenderOutput> {
    this.checkBuild();
    return this.queue
      .run(() => this.run(req))
      .catch((e: unknown) => {
        if (e instanceof QueueBusyError) throw new RenderError('render_unavailable', `busy: ${e.message}`, 'Wait for the earlier renders to finish and retry.');
        throw e;
      });
  }

  private async run(req: RenderRequest): Promise<RenderOutput> {
    clearTimeout(this.idle);
    const started = performance.now();
    const cold = !this.session.isWarm;
    const budget = cold ? this.coldTimeoutMs : this.timeoutMs;
    const deadline = started + budget;
    try {
      for (let attempt = 0; ; attempt++) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new SessionError('timeout', 'render timed out');
        try {
          const { out, warm } = await this.within(
            this.session.render({
              scene: req.scene,
              preview: req.preview ?? false,
              pose: req.pose,
              lighting: req.lighting,
              size: req.size,
              format: req.format ?? 'png',
              ...(req.models ? { models: req.models } : {}),
            }),
            remaining,
          );
          const { contextLost: _c, ...rest } = out;
          void _c;
          return { ...rest, warm, renderMs: Math.round(performance.now() - started) };
        } catch (e) {
          if (e instanceof SessionError && e.kind === 'dead' && attempt === 0) continue; // recreate browser and page, once
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof SessionError) {
        if (e.kind === 'timeout') {
          const diag = this.session.diagnostics.slice(-4);
          await this.session.discard();
          throw new RenderError(
            'render_timeout',
            `the render took longer than ${Math.round(budget / 1000)} s${cold ? ' (it had to start the browser first)' : ''}`,
            `${cold ? 'Retry: the first render starts Chromium and loads the viewer, which can be slow on a cold machine (the phases are logged on stderr). ' : 'Retry with a smaller size. '}${diag.length ? `Page log: ${diag.join(' | ')}` : ''}`.trim(),
          );
        }
        if (e.kind === 'blank') {
          await this.session.discard(); // the next render starts from a fresh page
          throw new RenderError('render_failed', e.message, e.hint);
        }
        throw new RenderError('render_unavailable', e.message, e.hint ?? BUILD_HINT);
      }
      await this.session.discard();
      throw new RenderError('render_unavailable', `render failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`, 'Retry; if it persists, check that the web build is current.');
    } finally {
      this.idle = setTimeout(() => void this.session.close(), this.idleMs);
      this.idle.unref();
    }
  }

  private within<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, bad) => {
      timer = setTimeout(() => bad(new SessionError('timeout', 'render timed out')), ms);
    });
    work.catch(() => undefined);
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  async close(): Promise<void> {
    clearTimeout(this.idle);
    await this.session.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The process-wide renderer used by the tools.
// ---------------------------------------------------------------------------------------------

let shared: { key: string; renderer: BrowserRenderer } | undefined;

/** One renderer per process (and config): the browser stays warm across tool calls. */
export function sharedRenderer(config: { webUrl?: string | undefined; renderChannel?: 'chrome' | undefined; log?: RendererOptions['log'] }): BrowserRenderer {
  const key = `${config.webUrl ?? ''}|${config.renderChannel ?? ''}`;
  if (!shared || shared.key !== key) {
    void shared?.renderer.close();
    shared = { key, renderer: new BrowserRenderer({ webUrl: config.webUrl, channel: config.renderChannel, log: config.log }) };
  }
  return shared.renderer;
}

/** Closes the shared browser (call on shutdown). */
export async function closeSharedRenderer(): Promise<void> {
  const s = shared;
  shared = undefined;
  await s?.renderer.close();
}

export { QueueBusyError, SerialQueue } from './queue';
export { SessionError } from './pageSession';
