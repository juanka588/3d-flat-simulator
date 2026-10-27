import { HistoryResponse, LogResponse, PostCommandResponse, SceneResponse, ServerMsg, makeEnvelope, serializeScene } from '@flat/scene';
import type { ApplyOk, Command, CommandEnvelope, CommandError, Scene } from '@flat/scene';
import { getTransport, useSceneStore } from '../state/sceneStore';
import { newId } from '../state/ids';
import { SyncCore } from './sync-core';
import type { SyncNotice, SyncState } from './sync-core';
import { useSyncStore } from './sync-store';
import { createViewRelay, setActiveViewRelay } from './view-relay';

/** Where a dev server listens by default (`pnpm server`). */
export const DEV_SERVER = 'http://127.0.0.1:8787';
const PROBE_TIMEOUT_MS = 1000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const HEARTBEAT_MS = 10_000;
const SILENCE_LIMIT_MS = 35_000;
const RETRY_MS = 1000;
const STEP_WAIT_MS = 4000;

export interface ServerTarget {
  /** Origin of the server, no trailing slash. */
  url: string;
  token: string | null;
}

// ------------------------------------------------------------------------ URL / dev probe (pure)

/** An http(s) URL reduced to its origin, or null. */
export function normalizeServerUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

export interface ServerParams {
  /** `?server=<url>`: a valid origin, or null. */
  server: string | null;
  /** `?server=off|none|local` forces Local mode (no probe either). */
  off: boolean;
  token: string | null;
  /** The URL without `token`, when it had one (to hand to `history.replaceState`). */
  withoutToken: string | null;
}

export function readServerParams(href: string): ServerParams {
  const url = new URL(href);
  const raw = url.searchParams.get('server');
  const token = url.searchParams.get('token');
  let withoutToken: string | null = null;
  if (token !== null) {
    url.searchParams.delete('token');
    withoutToken = `${url.pathname}${url.search}${url.hash}`;
  }
  const off = raw !== null && ['off', 'none', 'local'].includes(raw.toLowerCase());
  return { server: raw && !off ? normalizeServerUrl(raw) : null, off, token: token || null, withoutToken };
}

/** True when something answers at the dev server address (the reply is opaque: CORS does not matter). */
export async function probeServer(fetchImpl: typeof fetch, url = DEV_SERVER, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    await fetchImpl(`${url}/healthz`, { mode: 'no-cors', cache: 'no-store', signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chooses the server: `?server=` on any build; in dev only, an automatic probe of the default
 * address. The probe is skipped for automated browsers (so a running dev server is not mutated by
 * the e2e suite) and in production builds, which never probe.
 */
export async function resolveTarget(opts: { href: string; dev: boolean; automated: boolean; fetchImpl: typeof fetch }): Promise<ServerTarget | null> {
  const p = readServerParams(opts.href);
  if (p.off) return null;
  if (p.server) return { url: p.server, token: p.token };
  if (!opts.dev || opts.automated) return null;
  return (await probeServer(opts.fetchImpl)) ? { url: DEV_SERVER, token: p.token } : null;
}

/** Reconnect delay after `attempt` failures (0-based): 0.5 s, 1 s, 2 s ... capped at 10 s. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

// ------------------------------------------------------------------------------- the client

type OutboxItem =
  | { kind: 'cmd'; id: string; envelope: CommandEnvelope }
  | { kind: 'step'; id: string; step: 'undo' | 'redo'; resolve: (ok: boolean) => void };

const NO_INVERSE: Command = { type: 'batch', label: 'sync', commands: [] };

function describe(env: CommandEnvelope): string {
  return env.cmd.type === 'batch' ? `"${env.cmd.label}"` : env.cmd.type;
}

function firstError(errors: CommandError[]): string {
  const e = errors[0];
  return e ? e.message : 'unknown error';
}

export class SyncClient {
  readonly core: SyncCore;
  /** Ephemeral `view` messages (camera/lighting from the assistant); applied only while "Follow assistant view" is on. */
  /** Identifies this tab to the server (`/ws?client=`, and `X-Flat-Client` on any view POST). */
  readonly clientId = `tab-${newId()}`;
  private readonly views = createViewRelay(() => this.core.epoch);
  private ws: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastMessage = 0;
  private outbox: OutboxItem[] = [];
  private flushing = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private historyTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHistoryKey = '';
  private catching = false;
  private rerunCatchUp = false;
  private snapshotting = false;
  private stopped = false;
  private waiters = new Set<() => void>();
  /** Command type per envelope id, for the test hook's history entries. */
  private readonly types = new Map<string, string>();
  private readonly onOnline = () => {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.connect();
    }
  };

  constructor(
    private readonly target: ServerTarget,
    private readonly store = useSceneStore,
  ) {
    this.core = new SyncCore({
      send: (env) => this.enqueue({ kind: 'cmd', id: env.id, envelope: env }),
      display: (scene, changed, opts) => {
        const result: ApplyOk = { ok: true, scene, inverse: NO_INVERSE, changed, warnings: [] };
        this.store.getState().receiveRemote(makeEnvelope(NO_INVERSE, { id: 'sync', ts: 0 }), result, opts);
      },
      notice: (n) => this.onNotice(n),
      needCatchUp: () => this.catchUp(),
      needSnapshot: () => this.snapshot(),
      changed: (s) => this.onState(s),
    });
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  start(): void {
    useSyncStore.setState({
      mode: 'server',
      serverUrl: this.target.url,
      status: 'connecting',
      resolve: { useServer: () => this.core.useServerScene(), keepMine: () => void this.keepMine() },
    });
    // The server owns the history: the local stack (and the autosaved tail) is not used any more.
    this.store.getState().setRemoteHistory({ past: [], futureCount: 0, canUndo: false, canRedo: false });
    this.store.getState().setTransport({
      send: (env) => {
        this.types.set(env.id, env.cmd.type);
        this.core.local(env);
      },
      step: (kind) => this.step(kind),
      canStep: (kind) => this.core.status === 'connected' && (kind === 'undo' ? this.core.state.canUndo : this.core.state.canRedo),
      replaceScene: (scene) => void this.importScene(scene),
    });
    window.addEventListener('online', this.onOnline);
    setActiveViewRelay(this.views);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    setActiveViewRelay(null);
    window.removeEventListener('online', this.onOnline);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.historyTimer);
    clearInterval(this.heartbeat);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.store.getState().setTransport(null);
    this.store.getState().setRemoteHistory(null);
    useSyncStore.setState({ mode: 'local', serverUrl: null, resolve: null, conflict: null, pending: 0 });
  }

  // ---- socket ------------------------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    this.reconnectTimer = undefined;
    // `client` lets the server skip this tab when relaying a view it posted itself (`X-Flat-Client`).
    const ws = new WebSocket(`${this.target.url.replace(/^http/, 'ws')}/ws?client=${encodeURIComponent(this.clientId)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.lastMessage = Date.now();
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastMessage > SILENCE_LIMIT_MS) ws.close();
        else if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}');
      }, HEARTBEAT_MS);
    };
    ws.onmessage = (ev) => {
      this.lastMessage = Date.now();
      let raw: unknown;
      let parsed;
      try {
        raw = JSON.parse(String(ev.data));
        parsed = ServerMsg.safeParse(raw);
      } catch {
        return;
      }
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.type === 'hello') {
        this.attempt = 0;
        this.views.reset(); // the server's view counter restarts with the server process
        this.core.onHello(msg);
      } else if (msg.type === 'reset') this.core.onReset(msg);
      else if (msg.type === 'view') this.views.handle(raw);
      else if (msg.type === 'applied') {
        this.types.set(msg.envelope.id, msg.envelope.cmd.type);
        this.core.onApplied(msg);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.heartbeat);
      this.core.onDisconnect();
      if (this.stopped) return;
      this.reconnectTimer = setTimeout(() => this.connect(), backoffMs(this.attempt++));
    };
    ws.onerror = () => {
      // `close` follows
    };
  }

  // ---- HTTP ----------------------------------------------------------------------------------

  private async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: string): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.target.token) headers.authorization = `Bearer ${this.target.token}`;
    const res = await fetch(this.target.url + path, { method, headers, ...(body !== undefined ? { body } : {}), cache: 'no-store' });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // not JSON
    }
    return { status: res.status, json };
  }

  private errorsOf(res: { status: number; json: unknown }): CommandError[] {
    const errors = (res.json as { errors?: CommandError[] } | null)?.errors;
    return Array.isArray(errors) && errors.length ? errors : [{ code: 'invalid_command', path: '', message: `server answered ${res.status}` }];
  }

  // ---- outgoing commands -----------------------------------------------------------------------

  private enqueue(item: OutboxItem): void {
    if (item.kind === 'cmd' && this.outbox.some((i) => i.kind === 'cmd' && i.id === item.id)) {
      void this.flush();
      return;
    }
    this.outbox.push(item);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (;;) {
        if (this.core.status !== 'connected') return;
        const held = new Set(this.core.pending.map((p) => p.envelope.id));
        this.outbox = this.outbox.filter((i) => i.kind === 'step' || held.has(i.id));
        const item = this.outbox[0];
        if (!item) return;
        let res;
        try {
          res =
            item.kind === 'cmd'
              ? await this.request('POST', '/api/commands', JSON.stringify(item.envelope))
              : await this.request('POST', `/api/${item.step}`, JSON.stringify({ id: item.id }));
        } catch {
          this.retryLater(); // network: the id is idempotent, so trying again is safe
          return;
        }
        if (res.status === 429 || res.status >= 500) {
          this.retryLater();
          return;
        }
        this.outbox = this.outbox.filter((i) => i !== item);
        await this.settle(item, res);
      }
    } finally {
      this.flushing = false;
    }
  }

  private retryLater(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.flush(), RETRY_MS);
  }

  private async settle(item: OutboxItem, res: { status: number; json: unknown }): Promise<void> {
    const ok = res.status === 200 ? PostCommandResponse.safeParse(res.json) : null;
    if (item.kind === 'cmd') {
      if (ok?.success) this.core.onResponse(item.id, { kind: 'ok', noop: ok.data.result.noop === true });
      else this.core.onResponse(item.id, { kind: 'rejected', errors: this.errorsOf(res) });
      return;
    }
    if (ok?.success) {
      if (!ok.data.result.noop) await this.waitForRev(ok.data.rev);
      item.resolve(true);
      return;
    }
    item.resolve(false);
    useSyncStore.getState().pushNotice('info', `Could not ${item.step}: ${firstError(this.errorsOf(res))}`);
  }

  /** Resolves when the log entry `rev` has been applied locally (or after a short wait). */
  private waitForRev(rev: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        if (this.core.confirmedRev >= rev) {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve();
      }, STEP_WAIT_MS);
      this.waiters.add(done);
      done();
    });
  }

  private step(kind: 'undo' | 'redo'): Promise<boolean> {
    return new Promise((resolve) => this.enqueue({ kind: 'step', id: `${kind}-${newId()}`, step: kind, resolve }));
  }

  // ---- incoming ----------------------------------------------------------------------------------

  private catchUp(): void {
    if (this.catching) {
      this.rerunCatchUp = true;
      return;
    }
    this.catching = true;
    void (async () => {
      try {
        do {
          this.rerunCatchUp = false;
          const res = await this.request('GET', `/api/log?since=${this.core.confirmedRev}`);
          const log = LogResponse.safeParse(res.json);
          if (log.success) this.core.onLog(log.data);
        } while (this.rerunCatchUp);
      } catch {
        // offline: the reconnect (or the retry below) asks again
        if (this.ws?.readyState === WebSocket.OPEN) setTimeout(() => this.catchUp(), RETRY_MS);
      } finally {
        this.catching = false;
      }
    })();
  }

  private snapshot(): void {
    if (this.snapshotting) return;
    this.snapshotting = true;
    void (async () => {
      try {
        const res = await this.request('GET', '/api/scene');
        const scene = SceneResponse.safeParse(res.json);
        if (scene.success) this.core.onSnapshot(scene.data);
      } catch {
        if (this.ws?.readyState === WebSocket.OPEN) setTimeout(() => this.snapshot(), RETRY_MS);
      } finally {
        this.snapshotting = false;
      }
    })();
  }

  private onState(s: SyncState): void {
    useSyncStore.setState({
      status: s.status,
      rev: s.confirmedRev,
      epoch: s.epoch,
      pending: s.pending.length,
      conflict: s.conflict ? { epoch: s.conflict.epoch, rev: s.conflict.rev, pendingCount: s.conflict.pendingCount } : null,
    });
    this.store.getState().setHistoryFlags(s.canUndo, s.canRedo);
    for (const w of [...this.waiters]) w();
    const key = `${s.epoch}:${s.confirmedRev}:${s.status === 'connected'}`;
    if (s.status === 'connected' && key !== this.lastHistoryKey) {
      this.lastHistoryKey = key;
      this.scheduleHistory();
    }
    if (s.status === 'connected') void this.flush();
  }

  private scheduleHistory(): void {
    clearTimeout(this.historyTimer);
    this.historyTimer = setTimeout(() => void this.refreshHistory(), 60);
  }

  private async refreshHistory(): Promise<void> {
    if (this.core.status !== 'connected') return;
    try {
      const res = await this.request('GET', '/api/history');
      const h = HistoryResponse.safeParse(res.json);
      if (!h.success || h.data.epoch !== this.core.epoch || h.data.rev < this.core.confirmedRev) return;
      this.core.setHistoryFlags(h.data.canUndo, h.data.canRedo);
      const state = this.core.state;
      this.store.getState().setRemoteHistory({
        past: h.data.past.map((p) => ({ id: p.id, label: p.label, type: this.types.get(p.id) ?? p.label, author: p.author.kind, ts: p.ts })),
        futureCount: h.data.future.length,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      });
    } catch {
      // history is a convenience; the next change asks again
    }
  }

  // ---- notices and decisions ---------------------------------------------------------------------

  private onNotice(n: SyncNotice): void {
    const push = useSyncStore.getState().pushNotice;
    if (n.kind === 'conflict') push('warning', `A pending change was dropped: ${describe(n.envelope)} no longer applies after another edit (${firstError(n.errors)}).`);
    else if (n.kind === 'rejected') push('error', `The server refused ${describe(n.envelope)}: ${firstError(n.errors)}`);
    else push('warning', `${n.count} local change${n.count === 1 ? ' was' : 's were'} discarded; showing the server scene.`);
  }

  /** "Keep mine (overwrite server)": uploads the displayed scene as the new shared one. */
  private async keepMine(): Promise<void> {
    const scene = this.core.beginOverwrite();
    if (scene) await this.upload(scene);
  }

  private async importScene(scene: Scene): Promise<void> {
    if (this.core.status !== 'connected') {
      useSyncStore.getState().pushNotice('warning', 'Not connected: the loaded flat was not shared and will be replaced by the server scene.');
      return;
    }
    this.core.beginOverwrite(scene);
    await this.upload(scene);
  }

  private async upload(scene: Scene): Promise<void> {
    try {
      const res = await this.request('PUT', '/api/scene', serializeScene(scene));
      const body = res.json as { ok?: boolean; epoch?: string; rev?: number } | null;
      if (res.status === 200 && body?.ok && typeof body.epoch === 'string' && typeof body.rev === 'number') {
        this.core.finishOverwrite({ epoch: body.epoch, rev: body.rev });
        return;
      }
      this.core.abortOverwrite();
      useSyncStore.getState().pushNotice('error', `The server did not accept the scene: ${firstError(this.errorsOf(res))}`);
    } catch {
      this.core.abortOverwrite();
      useSyncStore.getState().pushNotice('error', 'Could not reach the server to replace its scene.');
    }
  }
}

/** Starts live sync when a server is configured (`?server=`) or, in dev, found. Never throws. */
export async function startSync(): Promise<SyncClient | null> {
  try {
    const href = window.location.href;
    const params = readServerParams(href);
    // The token lives in memory only: take it off the address bar (and history) right away.
    if (params.withoutToken !== null) window.history.replaceState(window.history.state, '', params.withoutToken);
    if (getTransport()) return null;
    const target = await resolveTarget({
      href,
      dev: import.meta.env.DEV,
      automated: typeof navigator !== 'undefined' && navigator.webdriver === true,
      fetchImpl: (...a) => fetch(...a),
    });
    if (!target) return null;
    const client = new SyncClient(target);
    client.start();
    return client;
  } catch {
    return null;
  }
}
