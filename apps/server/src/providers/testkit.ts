import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createNetwork, type NetworkOptions } from './http';
import { MemoryCache } from './cache';
import type { ProviderContext } from './types';

/** Test helpers: a fake clock, a fake fetch with canned routes and a tiny synthetic GLB. No network, no real time. */

export function fixture(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${rel}`, import.meta.url)), 'utf8');
}

export function fakeClock(start = Date.parse('2026-10-27T10:00:00Z')) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    /** `sleep` for the network layer: advances the clock instead of waiting. */
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}
export type FakeClock = ReturnType<typeof fakeClock>;

/** Smallest valid binary glTF: header, one JSON chunk. `padTo` adds trailing bytes inside the JSON padding to reach a size. */
export function tinyGlb(padTo = 0): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}');
  const padded = Math.max(Math.ceil(json.length / 4) * 4, padTo > 20 ? Math.ceil((padTo - 20) / 4) * 4 : 0);
  const buf = new Uint8Array(20 + padded).fill(0x20);
  const view = new DataView(buf.buffer);
  buf.set([0x67, 0x6c, 0x54, 0x46], 0); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, buf.length, true);
  view.setUint32(12, padded, true);
  buf.set([0x4a, 0x53, 0x4f, 0x4e], 16); // "JSON"
  buf.set(json, 20);
  return buf;
}

export interface Call {
  url: string;
  at: number;
  method: string;
  headers: Record<string, string>;
  redirect?: RequestRedirect | undefined;
  signal?: AbortSignal | undefined;
}
export type Handler = Response | ((call: Call) => Response | Promise<Response>);

const frozen = new WeakMap<Response, { buf: ArrayBuffer; status: number; headers: Headers }>();
/** A new Response with the same status, headers and bytes on every call (a clone would tee the body and block `cancel()`). */
async function fresh(r: Response): Promise<Response> {
  let f = frozen.get(r);
  if (!f) {
    f = { status: r.status, headers: new Headers(r.headers), buf: await r.arrayBuffer() };
    frozen.set(r, f);
  }
  return new Response(f.status === 204 || f.status === 304 || (f.status >= 300 && f.status < 400 && f.buf.byteLength === 0) ? null : f.buf.slice(0), { status: f.status, headers: f.headers });
}

export const text = (body: string, status = 200, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': type, ...headers } });
export const json = (body: unknown, status = 200) => text(JSON.stringify(body), status, 'application/json');
export const status = (code: number, headers: Record<string, string> = {}) => new Response(null, { status: code, headers });

/**
 * Fake `fetch`: routes are matched in order against the full URL (a string = exact or prefix with `*`, or a RegExp).
 * Unmatched URLs answer 599 and are listed in `unmatched`. `robots.txt` answers an allow-all file unless routed.
 */
export function fakeFetch(clock: Pick<FakeClock, 'now'>, routes: [string | RegExp, Handler][] = []) {
  const calls: Call[] = [];
  const unmatched: string[] = [];
  const table = [...routes];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const call: Call = { url, at: clock.now(), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers)), redirect: init?.redirect, signal: init?.signal ?? undefined };
    calls.push(call);
    const signal = init?.signal;
    for (const [pat, handler] of table) {
      const hit = typeof pat === 'string' ? (pat.endsWith('*') ? url.startsWith(pat.slice(0, -1)) : url === pat) : pat.test(url);
      if (!hit) continue;
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const r = typeof handler === 'function' ? await handler(call) : handler;
      return fresh(r);
    }
    if (/\/robots\.txt$/.test(url)) return text('User-agent: *\nAllow: /\n', 200, 'text/plain');
    unmatched.push(url);
    return new Response('no route', { status: 599 });
  }) as typeof fetch;
  return {
    fetch: impl,
    calls,
    unmatched,
    /** Add a route in front of the existing ones. */
    on: (pat: string | RegExp, handler: Handler) => void table.unshift([pat, handler]),
    /** Calls to non-robots URLs. */
    pages: () => calls.filter((c) => !c.url.endsWith('/robots.txt')),
  };
}

/** A request that never answers until aborted (timeouts). */
export const hang: Handler = (call) =>
  new Promise<Response>((_, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'));
    if (call.signal?.aborted) abort();
    else call.signal?.addEventListener('abort', abort, { once: true });
  });

/** A provider context wired to a fake fetch through the real polite network layer. */
export function testContext(
  routes: [string | RegExp, Handler][] = [],
  opts: { lookup?: ProviderContext['lookup']; network?: Partial<NetworkOptions>; scope?: 'provider' | 'host'; id?: string } = {},
) {
  const clock = fakeClock();
  const f = fakeFetch(clock, routes);
  const net = createNetwork({ fetch: f.fetch, clock, sleep: clock.sleep, random: () => 0, ...opts.network });
  const pn = net.forProvider(opts.id ?? 'test', { scope: opts.scope ?? 'provider' });
  const cache = new MemoryCache({ clock });
  const logs: string[] = [];
  const ctx: ProviderContext = {
    fetch: pn.fetch,
    cache: cache.scope(opts.id ?? 'test'),
    clock,
    log: (_l, m) => void logs.push(m),
    ...(opts.lookup ? { lookup: opts.lookup } : {}),
  };
  return { ctx, clock, fetch: f, net: pn, cache, logs };
}

export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
