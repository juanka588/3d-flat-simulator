/**
 * Cache of loaded models (M5.12): refcounted, least-recently-used eviction of IDLE entries, single-flight
 * loading, disposal on eviction. Generic over the cached value so it can be tested without WebGL.
 *
 * Limits: `maxModels` entries and `maxBytes` of estimated GPU memory. Only entries nobody holds
 * (`refs === 0`) are evicted, so a model on screen is never disposed under the renderer; if everything is
 * in use the cache stays over its limits until something is released.
 */

export const MAX_MODELS = 24;
export const MAX_MODEL_BYTES = 64 * 1024 * 1024;

export interface Loaded<T> {
  value: T;
  /** Estimated GPU memory of the value (geometry buffers plus decoded textures). */
  bytes: number;
}

export interface ModelHandle<T> {
  readonly key: string;
  readonly value: T;
  /** Gives the model back; idempotent. */
  release(): void;
}

export interface ModelCacheOptions<T> {
  maxModels?: number;
  maxBytes?: number;
  /** Frees the GPU resources of an evicted (or cleared) value. */
  dispose: (value: T) => void;
  /** Re-uploads a value after the WebGL context was restored. */
  restore?: (value: T) => void;
}

export interface ModelCacheStats {
  /** Cached models (in use or idle). */
  models: number;
  /** Models held by at least one handle. */
  inUse: number;
  /** Loads in flight. */
  pending: number;
  bytes: number;
  evictions: number;
}

export interface ModelCache<T> {
  /** Resolves a handle on the model for `key`, loading it with `load` unless cached or already loading (single flight). */
  acquire(key: string, load: () => Promise<Loaded<T>>): Promise<ModelHandle<T>>;
  has(key: string): boolean;
  stats(): ModelCacheStats;
  /** The WebGL context came back: lets every cached value re-upload. */
  restore(): void;
  /** Disposes everything, in use or not (the renderer is gone). */
  clear(): void;
}

interface Entry<T> {
  key: string;
  value: T;
  bytes: number;
  refs: number;
  lastUsed: number;
}

interface Flight<T> {
  promise: Promise<Entry<T>>;
  waiters: number;
}

export function createModelCache<T>(options: ModelCacheOptions<T>): ModelCache<T> {
  const maxModels = options.maxModels ?? MAX_MODELS;
  const maxBytes = options.maxBytes ?? MAX_MODEL_BYTES;
  const entries = new Map<string, Entry<T>>();
  const flights = new Map<string, Flight<T>>();
  let tick = 0;
  let bytes = 0;
  let evictions = 0;

  const evict = () => {
    while (entries.size > maxModels || bytes > maxBytes) {
      let lru: Entry<T> | undefined;
      for (const e of entries.values()) if (e.refs === 0 && (!lru || e.lastUsed < lru.lastUsed)) lru = e;
      if (!lru) return;
      entries.delete(lru.key);
      bytes -= lru.bytes;
      evictions++;
      options.dispose(lru.value);
    }
  };

  const handleFor = (entry: Entry<T>): ModelHandle<T> => {
    let released = false;
    return {
      key: entry.key,
      value: entry.value,
      release() {
        if (released) return;
        released = true;
        // The entry may have been cleared meanwhile: then there is nothing to give back.
        if (entries.get(entry.key) !== entry) return;
        entry.refs--;
        entry.lastUsed = ++tick;
        evict();
      },
    };
  };

  return {
    async acquire(key, load) {
      const cached = entries.get(key);
      if (cached) {
        cached.refs++;
        cached.lastUsed = ++tick;
        return handleFor(cached);
      }
      let flight = flights.get(key);
      if (!flight) {
        const fresh: Flight<T> = { waiters: 0, promise: undefined as unknown as Promise<Entry<T>> };
        fresh.promise = load().then(
          (loaded) => {
            flights.delete(key);
            // Every acquirer that joined while loading holds the model from the start, so it cannot be evicted before they get it.
            const entry: Entry<T> = { key, value: loaded.value, bytes: loaded.bytes, refs: fresh.waiters, lastUsed: ++tick };
            entries.set(key, entry);
            bytes += entry.bytes;
            evict();
            return entry;
          },
          (error: unknown) => {
            flights.delete(key);
            throw error;
          },
        );
        flights.set(key, fresh);
        flight = fresh;
      }
      flight.waiters++;
      return handleFor(await flight.promise);
    },
    has: (key) => entries.has(key),
    stats: () => ({
      models: entries.size,
      inUse: [...entries.values()].filter((e) => e.refs > 0).length,
      pending: flights.size,
      bytes,
      evictions,
    }),
    restore() {
      for (const e of entries.values()) options.restore?.(e.value);
    },
    clear() {
      for (const e of entries.values()) options.dispose(e.value);
      entries.clear();
      bytes = 0;
    },
  };
}
