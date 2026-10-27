import type { ProviderCache } from './types';

/** TTLs and caps of D3. */
export const TTL_SEARCH_MS = 10 * 60_000;
export const TTL_PRODUCT_MS = 60 * 60_000;
export const TTL_MODEL_MS = 60 * 60_000;
export const CACHE_TOTAL_BYTES = 200 * 1024 * 1024;
export const CACHE_ENTRY_BYTES = 20 * 1024 * 1024;

interface Entry {
  value: unknown;
  expires: number;
  bytes: number;
}

export interface MemoryCacheOptions {
  clock: { now(): number };
  maxTotalBytes?: number;
  maxEntryBytes?: number;
}

/**
 * Memory-only LRU + TTL cache (nothing is ever written to disk). The clock is injected, so tests do not
 * sleep. Entries bigger than `maxEntryBytes` are not stored (the caller still has the value). Eviction
 * drops the least recently used entries until the total fits `maxTotalBytes`. `flight` is single-flight:
 * concurrent callers of one key share one loader call.
 */
export class MemoryCache {
  private readonly map = new Map<string, Entry>();
  private readonly flights = new Map<string, Promise<unknown>>();
  private total = 0;
  private readonly clock: { now(): number };
  readonly maxTotalBytes: number;
  readonly maxEntryBytes: number;

  constructor(opts: MemoryCacheOptions) {
    this.clock = opts.clock;
    this.maxTotalBytes = opts.maxTotalBytes ?? CACHE_TOTAL_BYTES;
    this.maxEntryBytes = opts.maxEntryBytes ?? CACHE_ENTRY_BYTES;
  }

  get<T>(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.clock.now()) {
      this.remove(key, e);
      return undefined;
    }
    // LRU: re-insert as most recent.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number, bytes = 1): void {
    const old = this.map.get(key);
    if (old) this.remove(key, old);
    if (bytes > this.maxEntryBytes || bytes > this.maxTotalBytes || ttlMs <= 0) return;
    this.purgeExpired();
    this.map.set(key, { value, expires: this.clock.now() + ttlMs, bytes });
    this.total += bytes;
    for (const [k, e] of this.map) {
      if (this.total <= this.maxTotalBytes) break;
      if (k === key) continue;
      this.remove(k, e);
    }
  }

  delete(key: string): void {
    const e = this.map.get(key);
    if (e) this.remove(key, e);
  }

  /** Cached value, else one shared `load()` whose result is stored (`size` gives its byte count). */
  async flight<T>(key: string, ttlMs: number, load: () => Promise<T>, size: (v: T) => number = () => 1): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const running = this.flights.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = (async () => {
      try {
        const v = await load();
        this.set(key, v, ttlMs, size(v));
        return v;
      } finally {
        this.flights.delete(key);
      }
    })();
    this.flights.set(key, p);
    return p;
  }

  /** A view that prefixes every key (one per provider); shares the budget of this cache. */
  scope(prefix: string): ProviderCache & { flight: MemoryCache['flight'] } {
    const k = (key: string) => `${prefix}\u0000${key}`;
    return {
      get: (key) => this.get(k(key)),
      set: (key, value, ttl, bytes) => this.set(k(key), value, ttl, bytes),
      delete: (key) => this.delete(k(key)),
      flight: (key, ttl, load, size) => this.flight(k(key), ttl, load, size),
    };
  }

  get bytes(): number {
    return this.total;
  }
  get size(): number {
    return this.map.size;
  }

  private remove(key: string, e: Entry) {
    this.map.delete(key);
    this.total -= e.bytes;
  }
  private purgeExpired() {
    const now = this.clock.now();
    for (const [k, e] of this.map) if (e.expires <= now) this.remove(k, e);
  }
}
