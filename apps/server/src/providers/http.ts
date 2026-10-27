import type { CircuitState } from '@flat/scene';
import { robotsAllows } from './robots';
import { ProviderError } from './types';

/** Identifies this tool to the retailer (D3: an honest User-Agent, single user, GET only). */
export const USER_AGENT = '3d-flat-simulator/0.1 (personal local design tool; one user, GET only, no bulk)';
/** Product token matched against robots.txt `User-agent` groups. */
export const ROBOTS_TOKEN = '3d-flat-simulator';

export const DEFAULT_GAP_MS = 1500;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const ROBOTS_TTL_MS = 24 * 60 * 60_000;
const MAX_REDIRECTS = 3;
export const DEFAULT_BODY_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_QUEUE = 20;
const ROBOTS_MAX_BYTES = 512 * 1024;
/** How long an open circuit stays open. */
const OPEN_BLOCKED_MS = 30 * 60_000;
const OPEN_RATE_LIMITED_MS = 5 * 60_000;
const OPEN_FAILURES_MS = 60_000;
const FAILURES_TO_OPEN = 3;

export interface NetworkOptions {
  /** The real network (default global `fetch`); tests inject a fake. */
  fetch?: typeof fetch;
  clock: { now(): number };
  /** Waits `ms` (default a real timer); tests advance their fake clock here. */
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1) (default `Math.random`), for the backoff jitter. */
  random?: () => number;
  /** Pause between two requests to one host (default 1500 ms). */
  gapMs?: number;
  /** Per request, headers to end of response head (default 10 s). */
  timeoutMs?: number;
  /** Per response, the whole body (default 30 s): a slow-drip server cannot hold the host slot for ever. */
  bodyTimeoutMs?: number;
  /** Requests waiting for one host at most; one more is refused as "busy" (default 20). */
  maxQueue?: number;
  /** Retries after a 5xx or network error (default 2). */
  maxRetries?: number;
  backoffBaseMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Applied to every log line (redacts credentials). */
  redact?: (text: string) => string;
}

export interface CircuitStatus {
  state: CircuitState;
  retryAt?: number;
}

export interface ProviderNetwork {
  /** GET-only fetch with the UA, the per-host queue and gap, robots.txt, timeout, backoff and the circuit breaker. */
  fetch: typeof fetch;
  /** Provider-wide circuit (always `closed` for a host-scoped provider such as pasted-url). */
  circuit(): CircuitStatus;
  /** Circuit of one host (host-scoped providers). */
  circuitOf(host: string): CircuitStatus;
}

export interface ProviderNetworkOptions {
  /** `provider`: one 403/429 pauses the whole provider (IKEA). `host`: per site (pasted-url). */
  scope?: 'provider' | 'host';
  /** The wire for this provider (default: the network's `fetch`). pasted-url uses a DNS-pinned one (M6). */
  transport?: typeof fetch;
}

class Breaker {
  state: CircuitState = 'closed';
  failures = 0;
  retryAt = 0;
  reason: 'blocked' | 'failures' = 'failures';
  /** Half-open: exactly one request (the probe) is let through. */
  probing = false;
}

const isRedirect = (s: number) => s === 301 || s === 302 || s === 303 || s === 307 || s === 308;
const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The shared, polite network layer (D3). One instance per server: it owns the per-host queue (1 request
 * at a time, `gapMs` between two requests) and the robots.txt cache (24 h), so two providers on one host
 * still share the same politeness budget. Each provider gets its own circuit breaker via `forProvider`.
 */
export function createNetwork(opts: NetworkOptions) {
  const realFetch = opts.fetch ?? fetch;
  const now = () => opts.clock.now();
  const sleep = opts.sleep ?? sleepReal;
  const random = opts.random ?? Math.random;
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  const maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
  const maxRetries = opts.maxRetries ?? 2;
  const backoffBase = opts.backoffBaseMs ?? 500;
  const redact = opts.redact ?? ((s: string) => s);
  const log = (level: 'info' | 'warn' | 'error', m: string) => opts.log?.(level, redact(m));

  // ---- per-host queue + gap ----
  // One request at a time per host. The slot is held until the response BODY is consumed (or cancelled, or
  // times out) and the gap is measured from that moment, so a big GLB never overlaps the next request.
  // Interactive requests go before background ones (prefetch); each class is first come, first served. A background request is
  // refused when the queue is half full, so prefetching can never crowd out what somebody is waiting for.
  interface HostState {
    busy: boolean;
    queue: { low: boolean; grant: () => void }[];
  }
  const hosts = new Map<string, HostState>();
  const lastEnd = new Map<string, number>();
  type Hold = (done: Promise<void>) => void;
  function pump(host: string, st: HostState) {
    if (st.busy) return;
    let at = st.queue.findIndex((w) => !w.low);
    if (at < 0) at = 0;
    const next = st.queue.splice(at, 1)[0];
    if (!next) {
      hosts.delete(host);
      return;
    }
    st.busy = true;
    next.grant();
  }
  async function onHost<T>(host: string, low: boolean, fn: (hold: Hold) => Promise<T>): Promise<T> {
    const st = hosts.get(host) ?? { busy: false, queue: [] };
    hosts.set(host, st);
    const waiting = st.queue.length + (st.busy ? 1 : 0);
    if (waiting >= (low ? Math.ceil(maxQueue / 2) : maxQueue)) {
      if (!st.busy && st.queue.length === 0) hosts.delete(host);
      throw new ProviderError('provider_unavailable', `${host}: busy (${waiting} requests already queued)`);
    }
    await new Promise<void>((grant) => {
      st.queue.push({ low, grant });
      pump(host, st);
    });
    let held: Promise<void> | undefined;
    try {
      const wait = (lastEnd.get(host) ?? -Infinity) + gapMs - now();
      if (wait > 0) await sleep(wait);
      return await fn((p) => {
        held = p;
      });
    } finally {
      const free = () => {
        lastEnd.set(host, now());
        st.busy = false;
        pump(host, st);
      };
      if (held) void held.then(free, free);
      else free();
    }
  }

  // ---- one attempt: headers -> response head, with timeout; the body is guarded separately ----
  async function attempt(wire: typeof fetch, url: URL, init: RequestInit, hold: Hold): Promise<Response> {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);
    const outer = init.signal;
    const onOuter = () => ctl.abort();
    if (outer) {
      if (outer.aborted) ctl.abort();
      else outer.addEventListener('abort', onOuter, { once: true });
    }
    let res: Response;
    try {
      res = await wire(url, { method: 'GET', headers: buildHeaders(init.headers), redirect: 'manual', signal: ctl.signal });
    } catch (e) {
      if (timedOut) throw new ProviderError('provider_unavailable', `${url.host} did not answer within ${timeoutMs / 1000} s`, { cause: e });
      if (outer?.aborted) throw e;
      if (e instanceof ProviderError) throw e; // e.g. the pinned transport refused a private address
      throw new NetworkError(e);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
    return guardBody(res, hold, bodyTimeoutMs, () => ctl.abort(), url.host);
  }

  // ---- robots.txt (24 h) ----
  const robots = new Map<string, { text: string; expires: number }>();

  function forProvider(providerId: string, popts: ProviderNetworkOptions = {}): ProviderNetwork {
    const scope = popts.scope ?? 'provider';
    const wire = popts.transport ?? realFetch;
    const breakers = new Map<string, Breaker>();
    const breaker = (host: string) => {
      const key = scope === 'provider' ? '*' : host;
      let b = breakers.get(key);
      if (!b) breakers.set(key, (b = new Breaker()));
      return b;
    };
    const statusOf = (b: Breaker): CircuitStatus => {
      if (b.state === 'open' && now() >= b.retryAt) return { state: 'half_open' };
      return b.state === 'open' ? { state: 'open', retryAt: b.retryAt } : { state: b.state };
    };
    const open = (b: Breaker, reason: Breaker['reason'], ms: number, host: string) => {
      b.state = 'open';
      b.reason = reason;
      b.retryAt = now() + ms;
      log('warn', `${providerId}: circuit open for ${Math.round(ms / 1000)} s (${reason}, ${host})`);
    };
    const refuseOpen = (b: Breaker, host: string): never => {
      if (b.reason === 'blocked') {
        throw new ProviderError('provider_blocked', `${providerId}: paused after the retailer blocked a request (${host})`, { retryAt: b.retryAt });
      }
      throw new ProviderError('provider_unavailable', `${providerId}: paused after repeated failures (${host})`, { retryAt: b.retryAt });
    };
    /** Cheap check before queueing: an open circuit refuses without waiting in line. */
    const peek = (b: Breaker, host: string) => {
      if (b.state === 'open' && now() < b.retryAt) refuseOpen(b, host);
    };
    /**
     * The gate, evaluated INSIDE the host slot right before the request goes out (a call queued before a 403
     * must not reach the retailer after it). Half-open lets exactly one probe through; returns true for it.
     */
    const admit = (b: Breaker, host: string): boolean => {
      if (b.state === 'open') {
        if (now() < b.retryAt) refuseOpen(b, host);
        b.state = 'half_open';
        b.probing = false;
      }
      if (b.state === 'half_open') {
        if (b.probing) throw new ProviderError('provider_unavailable', `${providerId}: probing ${host} after a pause; try again shortly`);
        b.probing = true;
        return true;
      }
      return false;
    };

    type Attempt = { res: Response } | { retry: unknown };
    /** One gated request inside the host slot. 403/429 open the circuit and throw; 5xx and network errors ask for a retry. */
    async function gatedAttempt(url: URL, init: RequestInit, b: Breaker): Promise<Attempt> {
      return onHost(url.host, (init as { priority?: string }).priority === 'low', async (hold) => {
        const probe = admit(b, url.hostname);
        try {
          let res: Response;
          try {
            res = await attempt(wire, url, init, hold);
          } catch (e) {
            if (e instanceof NetworkError) return { retry: e.cause };
            if (e instanceof ProviderError && e.code === 'provider_unavailable') {
              if (b.state === 'half_open' || ++b.failures >= FAILURES_TO_OPEN) open(b, 'failures', OPEN_FAILURES_MS, url.hostname);
            }
            throw e;
          }
          if (res.status === 403 || res.status === 429) {
            await res.body?.cancel().catch(() => undefined);
            const retryAfter = Number(res.headers.get('retry-after'));
            const ms = res.status === 429 ? Math.max(OPEN_RATE_LIMITED_MS, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0) : OPEN_BLOCKED_MS;
            open(b, 'blocked', ms, url.hostname);
            throw new ProviderError('provider_blocked', `${url.host} answered ${res.status}`, { retryAt: b.retryAt });
          }
          if (res.status >= 500) {
            const ra = Number(res.headers.get('retry-after'));
            await res.body?.cancel().catch(() => undefined);
            return { retry: Object.assign(new Error(`HTTP ${res.status}`), { retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined }) };
          }
          b.state = 'closed';
          b.failures = 0;
          return { res };
        } finally {
          if (probe) b.probing = false;
        }
      });
    }

    /**
     * robots.txt of the origin (RFC 9309 with a fail-closed twist): 200 = parsed; 404/410 = no file, allow all;
     * a same-host redirect is followed; 403/429 open the circuit and refuse; anything else (other 4xx, 5xx,
     * a redirect off the host, an unreadable body) refuses this request. Only 200 and 404/410 are cached (24 h).
     */
    async function robotsText(url: URL, b: Breaker, prio: RequestInit): Promise<string> {
      const hit = robots.get(url.origin);
      if (hit && hit.expires > now()) return hit.text;
      let robotsUrl = new URL('/robots.txt', url.origin);
      for (let hop = 0; ; hop++) {
        const r = await gatedAttempt(robotsUrl, prio, b).catch((e) => {
          if (e instanceof ProviderError) throw e;
          throw new ProviderError('provider_unavailable', `${url.host}: robots.txt unreachable`, { cause: e });
        });
        if ('retry' in r) throw new ProviderError('provider_unavailable', `${url.host}: robots.txt unreachable (${errText(r.retry)})`);
        const res = r.res;
        if (isRedirect(res.status)) {
          await res.body?.cancel().catch(() => undefined);
          const loc = res.headers.get('location');
          let next: URL | undefined;
          try {
            next = loc ? new URL(loc, robotsUrl) : undefined;
          } catch {
            next = undefined;
          }
          if (!next || hop >= MAX_REDIRECTS || next.hostname !== robotsUrl.hostname || (next.protocol !== 'https:' && next.protocol !== 'http:')) {
            throw new ProviderError('provider_unavailable', `${url.host}: robots.txt redirects somewhere it may not follow`);
          }
          robotsUrl = next;
          continue;
        }
        let text = '';
        if (res.status === 200) {
          try {
            text = new TextDecoder().decode(await readBytesCapped(res, ROBOTS_MAX_BYTES));
          } catch (e) {
            throw new ProviderError('provider_unavailable', `${url.host}: robots.txt could not be read`, { cause: e });
          }
        } else {
          await res.body?.cancel().catch(() => undefined);
          if (res.status !== 404 && res.status !== 410) throw new ProviderError('provider_unavailable', `${url.host}: robots.txt answered ${res.status}`);
        }
        robots.set(url.origin, { text, expires: now() + ROBOTS_TTL_MS });
        return text;
      }
    }
    async function assertRobots(url: URL, b: Breaker, prio: RequestInit): Promise<void> {
      if (url.pathname === '/robots.txt') return;
      const text = await robotsText(url, b, prio);
      if (!robotsAllows(text, url.pathname + url.search, ROBOTS_TOKEN)) {
        throw new ProviderError('robots_disallowed', `robots.txt of ${url.host} disallows ${url.pathname}`);
      }
    }

    async function request(url: URL, init: RequestInit): Promise<Response> {
      const b = breaker(url.hostname);
      peek(b, url.hostname);
      await assertRobots(url, b, { priority: (init as { priority?: string }).priority } as RequestInit);
      let lastError: unknown;
      for (let n = 0; n <= maxRetries; n++) {
        if (n > 0) await sleep(backoffBase * 2 ** (n - 1) + random() * backoffBase);
        log('info', `${providerId}: GET ${url.origin}${url.pathname}${n > 0 ? ` (retry ${n})` : ''}`);
        const r = await gatedAttempt(url, init, b);
        if ('res' in r) return r.res;
        lastError = r.retry;
        const ra = (r.retry as { retryAfter?: number }).retryAfter;
        if (n < maxRetries && ra !== undefined) await sleep(Math.min(ra, 10) * 1000);
      }
      if (b.state === 'half_open' || ++b.failures >= FAILURES_TO_OPEN) open(b, 'failures', OPEN_FAILURES_MS, url.hostname);
      throw new ProviderError('provider_unavailable', `${url.host} failed after ${maxRetries + 1} attempts: ${errText(lastError)}`, {
        ...(b.state === 'open' ? { retryAt: b.retryAt } : {}),
        cause: lastError,
      });
    }

    const politeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method !== 'GET') throw new Error(`providers may only send GET requests (got ${method})`);
      let url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ProviderError('url_not_allowed', `unsupported protocol ${url.protocol}`);
      const manual = init.redirect === 'manual';
      for (let hop = 0; ; hop++) {
        const res = await request(url, init);
        if (manual || !isRedirect(res.status)) return res;
        await res.body?.cancel().catch(() => undefined);
        const loc = res.headers.get('location');
        if (!loc || hop >= MAX_REDIRECTS) throw new ProviderError('provider_unavailable', `${url.host}: too many or empty redirects`);
        const next = new URL(loc, url);
        if (next.hostname !== url.hostname) throw new ProviderError('url_not_allowed', `redirect from ${url.hostname} to another host (${next.hostname}) refused`);
        url = next;
      }
    }) as typeof fetch;

    return {
      fetch: politeFetch,
      circuit: () => (scope === 'provider' ? statusOf(breaker('')) : { state: 'closed' }),
      circuitOf: (host) => statusOf(breaker(host)),
    };
  }

  return { forProvider, gapMs, timeoutMs };
}
export type Network = ReturnType<typeof createNetwork>;

class NetworkError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('network error');
    this.cause = cause;
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Only whitelisted request headers pass: no cookies, no credentials. */
function buildHeaders(h: HeadersInit | undefined): Headers {
  const out = new Headers({ 'user-agent': USER_AGENT, accept: '*/*' });
  if (h) {
    for (const [k, v] of new Headers(h)) {
      if (k === 'accept' || k === 'accept-language' || k === 'range') out.set(k, v);
    }
  }
  return out;
}

/** Reads a response body up to `maxBytes`; a longer body throws (and is cancelled). */
export async function readBytesCapped(res: Response, maxBytes: number, onTooLarge?: () => Error): Promise<Uint8Array> {
  const tooLarge = onTooLarge ?? (() => new ProviderError('provider_parse_failed', `response is larger than ${maxBytes} bytes`));
  const announced = Number(res.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export async function readTextCapped(res: Response, maxBytes: number, onTooLarge?: () => Error): Promise<string> {
  return new TextDecoder('utf-8').decode(await readBytesCapped(res, maxBytes, onTooLarge));
}

/**
 * Wraps a response so the host slot is held until its body is read to the end, cancelled, errors, or the
 * body deadline passes (a slow-drip server then gets its stream errored and its socket aborted).
 */
function guardBody(res: Response, hold: (done: Promise<void>) => void, bodyTimeoutMs: number, abort: () => void, host: string): Response {
  if (!res.body) return res;
  let finish!: () => void;
  hold(new Promise<void>((r) => (finish = r)));
  const reader = res.body.getReader();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  const end = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    finish();
  };
  const timer = setTimeout(() => {
    ctl.error(new ProviderError('provider_unavailable', `${host}: the response body did not finish within ${Math.round(bodyTimeoutMs / 1000)} s`));
    abort();
    reader.cancel().catch(() => undefined);
    end();
  }, bodyTimeoutMs);
  timer.unref?.();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          end();
          c.close();
        } else c.enqueue(value);
      } catch (e) {
        end();
        try {
          c.error(e);
        } catch {
          // already errored by the deadline
        }
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason).catch(() => undefined);
    },
  });
  const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  Object.defineProperty(out, 'url', { value: res.url });
  return out;
}
