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
}

class Breaker {
  state: CircuitState = 'closed';
  failures = 0;
  retryAt = 0;
  reason: 'blocked' | 'failures' = 'failures';
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
  const maxRetries = opts.maxRetries ?? 2;
  const backoffBase = opts.backoffBaseMs ?? 500;
  const redact = opts.redact ?? ((s: string) => s);
  const log = (level: 'info' | 'warn' | 'error', m: string) => opts.log?.(level, redact(m));

  // ---- per-host queue + gap ----
  const tails = new Map<string, Promise<void>>();
  const lastEnd = new Map<string, number>();
  async function onHost<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(host) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => gate);
    tails.set(host, tail);
    await prev;
    try {
      const wait = (lastEnd.get(host) ?? -Infinity) + gapMs - now();
      if (wait > 0) await sleep(wait);
      return await fn();
    } finally {
      lastEnd.set(host, now());
      release();
      if (tails.get(host) === tail) tails.delete(host);
    }
  }

  // ---- one attempt: headers -> response head, with timeout ----
  async function attempt(url: URL, init: RequestInit): Promise<Response> {
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
    try {
      return await realFetch(url, { method: 'GET', headers: buildHeaders(init.headers), redirect: 'manual', signal: ctl.signal });
    } catch (e) {
      if (timedOut) throw new ProviderError('provider_unavailable', `${url.host} did not answer within ${timeoutMs / 1000} s`, { cause: e });
      if (outer?.aborted) throw e;
      throw new NetworkError(e);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
  }

  // ---- robots.txt (24 h) ----
  const robots = new Map<string, { text: string; expires: number }>();
  async function robotsText(url: URL): Promise<string> {
    const hit = robots.get(url.origin);
    if (hit && hit.expires > now()) return hit.text;
    const robotsUrl = new URL('/robots.txt', url.origin);
    const res = await onHost(url.host, () => attempt(robotsUrl, {})).catch((e) => {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('provider_unavailable', `${url.host}: robots.txt unreachable`, { cause: e });
    });
    let text = '';
    if (res.status === 200) text = new TextDecoder().decode(await readBytesCapped(res, ROBOTS_MAX_BYTES).catch(() => new Uint8Array()));
    else {
      await res.body?.cancel().catch(() => undefined);
      // RFC 9309: 4xx = no robots file (everything allowed); a protected site answers 403 and the page request will trip the circuit.
      if (res.status >= 500) throw new ProviderError('provider_unavailable', `${url.host}: robots.txt answered ${res.status}`);
    }
    robots.set(url.origin, { text, expires: now() + ROBOTS_TTL_MS });
    return text;
  }
  async function assertRobots(url: URL): Promise<void> {
    if (url.pathname === '/robots.txt') return;
    const text = await robotsText(url);
    if (!robotsAllows(text, url.pathname + url.search, ROBOTS_TOKEN)) {
      throw new ProviderError('robots_disallowed', `robots.txt of ${url.host} disallows ${url.pathname}`);
    }
  }

  function forProvider(providerId: string, popts: ProviderNetworkOptions = {}): ProviderNetwork {
    const scope = popts.scope ?? 'provider';
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
    const gate = (b: Breaker, host: string) => {
      if (b.state !== 'open') return;
      if (now() >= b.retryAt) {
        b.state = 'half_open';
        return;
      }
      if (b.reason === 'blocked') {
        throw new ProviderError('provider_blocked', `${providerId}: paused after the retailer blocked a request (${host})`, { retryAt: b.retryAt });
      }
      throw new ProviderError('provider_unavailable', `${providerId}: paused after repeated failures (${host})`, { retryAt: b.retryAt });
    };

    async function request(url: URL, init: RequestInit): Promise<Response> {
      const b = breaker(url.hostname);
      gate(b, url.hostname);
      await assertRobots(url);
      let lastError: unknown;
      for (let n = 0; n <= maxRetries; n++) {
        if (n > 0) await sleep(backoffBase * 2 ** (n - 1) + random() * backoffBase);
        log('info', `${providerId}: GET ${url.origin}${url.pathname}${n > 0 ? ` (retry ${n})` : ''}`);
        let res: Response;
        try {
          res = await onHost(url.host, () => attempt(url, init));
        } catch (e) {
          if (e instanceof NetworkError) {
            lastError = e.cause;
            continue;
          }
          if (e instanceof ProviderError && e.code === 'provider_unavailable') {
            if (++b.failures >= FAILURES_TO_OPEN) open(b, 'failures', OPEN_FAILURES_MS, url.hostname);
            throw e;
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
          lastError = new Error(`HTTP ${res.status}`);
          const ra = Number(res.headers.get('retry-after'));
          await res.body?.cancel().catch(() => undefined);
          if (n < maxRetries && Number.isFinite(ra) && ra > 0) await sleep(Math.min(ra, 10) * 1000);
          continue;
        }
        b.state = 'closed';
        b.failures = 0;
        return res;
      }
      if (++b.failures >= FAILURES_TO_OPEN) open(b, 'failures', OPEN_FAILURES_MS, url.hostname);
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
