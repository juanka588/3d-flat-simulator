import {
  formatProductId,
  parseProductId,
  productIdOf,
  type ProductRecord,
  type ProviderErrorCode,
  type ProviderInfo,
} from '@flat/scene';
import { MemoryCache, TTL_MODEL_MS, TTL_PRODUCT_MS, TTL_SEARCH_MS } from './cache';
import { PROVIDER_CATALOG, type ProviderMeta } from './catalog';
import { createNetwork, readBytesCapped, type NetworkOptions, type ProviderNetwork } from './http';
import { createPinnedFetch } from './pinned';
import { createSecrets, type Secrets } from './secrets';
import { ProviderError, isPartial, warningsOf, type ModelStream, type ProductProvider, type ProviderContext, type ProviderRegistry, type SearchOptions } from './types';

/** Seen-products registry TTL (D9): ids a search returned to an MCP session stay placeable for an hour after the last touch. */
export const SEEN_TTL_MS = 60 * 60_000;
export const SEEN_MAX_SESSIONS = 200;
export const SEEN_MAX_IDS = 5000;
const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46]; // "glTF"
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const TTL_PHOTO_MS = 24 * 60 * 60_000;

type Loader = () => Promise<ProductProvider>;

/**
 * Lazy loaders: a provider module is `import()`ed only when its id is listed in `FLAT_PROVIDERS`. Nothing
 * here imports a provider statically (a test greps this file for that).
 */
const LOADERS: Record<string, Loader> = {
  mock: async () => (await import('./mock')).createMockProvider(),
  'ikea-fr': async () => (await import('./ikea-fr')).createIkeaFrProvider(),
  'pasted-url': async () => (await import('./pasted-url')).createPastedUrlProvider(),
};

/** Providers whose circuit breaker is per site rather than per provider (a blocked site must not pause the others). */
const HOST_SCOPED = new Set(['pasted-url']);

export interface RegistryOptions {
  /** Ids from `FLAT_PROVIDERS`. Unknown ids are logged and ignored. */
  enabled: readonly string[];
  clock?: { now(): number };
  fetch?: typeof fetch;
  sleep?: NetworkOptions['sleep'];
  random?: NetworkOptions['random'];
  gapMs?: number;
  timeoutMs?: number;
  bodyTimeoutMs?: number;
  maxQueue?: number;
  maxRetries?: number;
  lookup?: (hostname: string) => Promise<string[]>;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  secrets?: Secrets;
  /** Replace or add provider constructors (tests). */
  factories?: Record<string, Loader>;
  cache?: { maxTotalBytes?: number; maxEntryBytes?: number };
}

export interface LiveRegistry extends ProviderRegistry {
  /** Provider ids whose module was loaded (empty when nothing is enabled). */
  loaded(): string[];
  /** The memory cache (size inspection in tests). */
  readonly cache: MemoryCache;
}

interface Slot {
  meta: ProviderMeta;
  provider?: ProductProvider;
  net?: ProviderNetwork;
  ctx?: ProviderContext;
}

/** Search score: how many query tokens occur in the record (accent- and case-insensitive prefix match). Soft: a provider already matched on its side. */
function score(rec: ProductRecord, tokens: string[]): number {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const nameWords = fold(rec.name).split(/[^a-z0-9]+/).filter(Boolean);
  const otherWords = fold([rec.category.replace('_', ' '), ...rec.styleTags, ...rec.colours, rec.sku].join(' ')).split(/[^a-z0-9]+/).filter(Boolean);
  let s = 0;
  for (const t of tokens) {
    if (nameWords.some((w) => w.startsWith(t))) s += 2;
    else if (otherWords.some((w) => w.startsWith(t))) s += 1;
  }
  return s;
}

/**
 * Builds the registry. With nothing enabled it imports no provider module and every product route answers
 * `provider_disabled`. Secrets (credentials) are redacted from every log line.
 */
export async function createProviderRegistry(opts: RegistryOptions): Promise<LiveRegistry> {
  const log = (level: 'info' | 'warn' | 'error', m: string) => opts.log?.(level, (opts.secrets ?? createSecrets({})).redact(m));
  const loaders = { ...LOADERS, ...opts.factories };
  const providers = new Map<string, ProductProvider>();
  for (const id of new Set(opts.enabled.map((s) => s.trim()).filter(Boolean))) {
    const load = loaders[id];
    if (!load) {
      log('warn', `FLAT_PROVIDERS: unknown provider "${id}" ignored (known: ${Object.keys(loaders).join(', ')})`);
      continue;
    }
    providers.set(id, await load());
  }
  return assembleRegistry(opts, providers);
}

function assembleRegistry(opts: RegistryOptions, providers: ReadonlyMap<string, ProductProvider>): LiveRegistry {
  const clock = opts.clock ?? { now: () => Date.now() };
  const secrets = opts.secrets ?? createSecrets({});
  const rawLog = opts.log ?? (() => undefined);
  const log = (level: 'info' | 'warn' | 'error', m: string) => rawLog(level, secrets.redact(m));
  const cache = new MemoryCache({ clock, ...opts.cache });
  const network = createNetwork({
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    clock,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.random ? { random: opts.random } : {}),
    ...(opts.gapMs !== undefined ? { gapMs: opts.gapMs } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.bodyTimeoutMs !== undefined ? { bodyTimeoutMs: opts.bodyTimeoutMs } : {}),
    ...(opts.maxQueue !== undefined ? { maxQueue: opts.maxQueue } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    log,
    redact: secrets.redact,
  });
  const slots = new Map<string, Slot>();
  for (const [id, meta] of Object.entries(PROVIDER_CATALOG)) slots.set(id, { meta });
  const loadedIds: string[] = [];
  for (const [id, provider] of providers) {
    // Pasted URLs reach arbitrary hosts: the connection itself is pinned to the vetted address (M6). A test `fetch` replaces the wire.
    const hostScoped = HOST_SCOPED.has(provider.id);
    const net = network.forProvider(provider.id, {
      scope: hostScoped ? 'host' : 'provider',
      ...(hostScoped && !opts.fetch ? { transport: createPinnedFetch({ ...(opts.lookup ? { lookup: opts.lookup } : {}) }) } : {}),
    });
    const slot: Slot = slots.get(id) ?? {
      meta: { id: provider.id, label: provider.label, capabilities: provider.capabilities, personalUseOnly: provider.personalUseOnly, ...(provider.note ? { note: provider.note } : {}) },
    };
    slot.provider = provider;
    slot.net = net;
    const base: ProviderContext = {
      fetch: net.fetch,
      cache: cache.scope(provider.id),
      clock,
      log: (level, message) => log(level, `${provider.id}: ${message}`),
      ...(opts.lookup ? { lookup: opts.lookup } : {}),
    };
    // The low-priority twin: same cache and rules, but its requests queue behind every interactive one.
    const background: ProviderContext = { ...base, fetch: ((i: RequestInfo | URL, init: RequestInit = {}) => net.fetch(i, { ...init, priority: 'low' } as RequestInit)) as typeof fetch };
    slot.ctx = { ...base, background };
    slots.set(id, slot);
    loadedIds.push(id);
  }

  const enabledSlots = () => [...slots.values()].filter((s) => s.provider);

  function slotFor(id: string): Required<Pick<Slot, 'provider' | 'ctx'>> & Slot {
    const slot = slots.get(id);
    if (!slot) throw new ProviderError('unknown_provider', `unknown provider "${id}"`);
    if (!slot.provider || !slot.ctx) throw new ProviderError('provider_disabled', `provider "${id}" is not enabled (FLAT_PROVIDERS)`);
    return slot as Required<Pick<Slot, 'provider' | 'ctx'>> & Slot;
  }

  const flights = new Map<string, Promise<unknown>>();
  function once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = flights.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = run().finally(() => flights.delete(key));
    flights.set(key, p);
    return p;
  }

  const rememberRecord = (rec: ProductRecord) => cache.set(`rec\0${productIdOf(rec)}`, rec, TTL_PRODUCT_MS, 4096);

  // ---- seen registry ----
  const seen = new Map<string, { ids: Set<string>; expires: number }>();
  const sweepSeen = () => {
    const now = clock.now();
    for (const [k, v] of seen) if (v.expires <= now) seen.delete(k);
  };

  const reg: LiveRegistry = {
    loaded: () => [...loadedIds],
    cache,

    enabledIds: () => enabledSlots().map((s) => s.meta.id),

    info(): ProviderInfo[] {
      return [...slots.values()].map((s) => {
        const c = s.provider && s.net ? s.net.circuit() : { state: 'closed' as const };
        return {
          id: s.meta.id,
          label: s.meta.label,
          capabilities: s.meta.capabilities,
          enabled: s.provider !== undefined,
          circuit: c.state,
          ...(c.state === 'open' && 'retryAt' in c && c.retryAt !== undefined ? { retryAt: c.retryAt } : {}),
          personalUseOnly: s.meta.personalUseOnly,
          ...(s.meta.note ? { note: s.meta.note } : {}),
        };
      });
    },

    get: (id) => slots.get(id)?.provider,

    async search(query, sopts) {
      const { providerId, ...rest } = sopts;
      let targets: Slot[];
      if (providerId !== undefined) targets = [slotFor(providerId)];
      else {
        targets = enabledSlots().filter((s) => s.meta.capabilities.search);
        if (enabledSlots().length === 0) throw new ProviderError('provider_disabled', 'no product provider is enabled (set FLAT_PROVIDERS, e.g. FLAT_PROVIDERS=ikea-fr)');
      }
      const statuses: { provider: string; ok: boolean; code?: ProviderErrorCode; message?: string }[] = [];
      const lists: { rank: number; recs: ProductRecord[] }[] = [];
      await Promise.all(
        targets.map(async (s, i) => {
          const p = s.provider!;
          try {
            if (!p.capabilities.search) throw new ProviderError('provider_disabled', `${p.id} has no search; paste a product URL instead`);
            const key = `search\0${p.id}\0${query.trim().toLowerCase()}\0${JSON.stringify(rest)}`;
            // A partial answer (the rest of the pages is still being read in the background) is not cached: asking again gets more.
            const cached = cache.get<ProductRecord[]>(key);
            const recs =
              cached ??
              (await once(key, async () => {
                const found = await p.search(query, rest, s.ctx!);
                if (!isPartial(found)) cache.set(key, found, TTL_SEARCH_MS, 4096 * (found.length + 1));
                return found;
              }));
            for (const r of recs) rememberRecord(r);
            lists[i] = { rank: i, recs };
            const warnings = warningsOf(recs);
            statuses.push({ provider: p.id, ok: true, ...(warnings.length ? { message: warnings.join('; ').slice(0, 300) } : {}) });
          } catch (e) {
            const pe = e instanceof ProviderError ? e : undefined;
            if (!pe) log('error', `${p.id}: search failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
            statuses.push({ provider: p.id, ok: false, code: pe?.code ?? 'provider_unavailable', message: pe ? pe.message : 'unexpected provider error' });
          }
        }),
      );
      statuses.sort((a, b) => (a.provider < b.provider ? -1 : 1));
      const tokens = query.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      // Uniform filters, then rank: query score, provider relevance order (round-robin across providers), cheaper, sku.
      const seenIds = new Set<string>();
      const ranked: { rec: ProductRecord; s: number; pos: number }[] = [];
      for (const l of lists) {
        if (!l) continue;
        l.recs.forEach((rec, idx) => {
          const id = productIdOf(rec);
          if (seenIds.has(id)) return;
          if (rest.category !== undefined && rec.category !== rest.category) return;
          if (rest.minPrice !== undefined && rec.price < rest.minPrice) return;
          if (rest.maxPrice !== undefined && rec.price > rest.maxPrice) return;
          if (rest.maxDims?.w !== undefined && rec.dims.w > rest.maxDims.w) return;
          if (rest.maxDims?.d !== undefined && rec.dims.d > rest.maxDims.d) return;
          if (rest.maxDims?.h !== undefined && rec.dims.h > rest.maxDims.h) return;
          seenIds.add(id);
          ranked.push({ rec, s: score(rec, tokens), pos: idx });
        });
      }
      ranked.sort((a, b) => b.s - a.s || a.pos - b.pos || a.rec.price - b.rec.price || (a.rec.sku < b.rec.sku ? -1 : a.rec.sku > b.rec.sku ? 1 : 0));
      const records = ranked.slice(0, rest.limit).map((r) => r.rec);
      // A provider is asked for `limit` records, so one that returned a full page may have had more.
      const full = lists.some((l) => l && l.recs.length >= rest.limit);
      return { records, statuses, truncated: ranked.length > rest.limit || full };
    },

    async getProduct(productId) {
      const ref = parseProductId(productId);
      if (!ref) throw new ProviderError('product_not_found', `"${productId}" is not a product id (expected provider:sku)`);
      const s = slotFor(ref.provider);
      const key = `rec\0${formatProductId(ref)}`;
      return cache.flight(key, TTL_PRODUCT_MS, () => s.provider.get(ref.sku, s.ctx), () => 4096);
    },

    async resolveUrl(url) {
      const candidates = enabledSlots().filter((s) => s.meta.capabilities.resolveUrl && s.provider!.resolveUrl);
      if (candidates.length === 0) throw new ProviderError('provider_disabled', 'no provider can read a pasted URL (enable pasted-url in FLAT_PROVIDERS)');
      let last: ProviderError | undefined;
      for (const s of candidates) {
        try {
          const rec = await once(`resolve\0${s.meta.id}\0${url}`, () => s.provider!.resolveUrl!(url, s.ctx!));
          rememberRecord(rec);
          return rec;
        } catch (e) {
          if (e instanceof ProviderError && e.code === 'url_not_allowed' && s !== candidates[candidates.length - 1]) {
            last = e;
            continue; // another provider may know this URL
          }
          throw e;
        }
      }
      throw last ?? new ProviderError('url_not_allowed', 'no provider could read this URL');
    },

    async fetchModel(productId): Promise<ModelStream> {
      const ref = parseProductId(productId);
      if (!ref) throw new ProviderError('product_not_found', `"${productId}" is not a product id`);
      const s = slotFor(ref.provider);
      const p = s.provider;
      if (!p.capabilities.model3d || !p.fetchModel) throw new ProviderError('model_unavailable', `${p.id} has no 3D models`);
      const key = `glb\0${formatProductId(ref)}`;
      const bytes = await cache.flight(
        key,
        TTL_MODEL_MS,
        async () => readModel(await p.fetchModel!(ref.sku, s.ctx), cache.maxEntryBytes),
        (b) => b.byteLength,
      );
      return {
        stream: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        contentType: 'model/gltf-binary',
        size: bytes.byteLength,
      };
    },

    prefetchModels(productIds) {
      for (const id of productIds.slice(0, 60)) {
        const ref = parseProductId(id);
        const slot = ref ? slots.get(ref.provider) : undefined;
        const p = slot?.provider;
        if (!ref || !slot || !p || !slot.ctx || !p.capabilities.model3d || !p.fetchModel) continue;
        const key = `glb\0${formatProductId(ref)}`;
        if (cache.get(key) !== undefined) continue;
        const ctx = slot.ctx.background ?? slot.ctx;
        // Same cache key and single flight as a viewer request: whoever asks first downloads, the other one waits for it.
        void cache
          .flight(key, TTL_MODEL_MS, async () => readModel(await p.fetchModel!(ref.sku, ctx), cache.maxEntryBytes), (b) => b.byteLength)
          .catch((e: unknown) => log('info', `${ref.provider}: model prefetch of ${ref.sku} skipped: ${e instanceof Error ? e.message : String(e)}`));
      }
    },

    markSeen(session, ids) {
      sweepSeen();
      let entry = seen.get(session);
      if (entry) seen.delete(session); // re-insert below: Map order = least recently used first
      else {
        if (seen.size >= SEEN_MAX_SESSIONS) seen.delete(seen.keys().next().value!);
        entry = { ids: new Set(), expires: 0 };
      }
      seen.set(session, entry);
      for (const id of ids) {
        if (entry.ids.has(id)) entry.ids.delete(id);
        else if (entry.ids.size >= SEEN_MAX_IDS) entry.ids.delete(entry.ids.values().next().value!); // at the cap the LRU id goes, the new one stays
        entry.ids.add(id);
      }
      entry.expires = clock.now() + SEEN_TTL_MS;
      return entry.ids.size;
    },

    isSeen(session, productId) {
      const entry = seen.get(session);
      if (!entry) return false;
      if (entry.expires <= clock.now()) {
        seen.delete(session);
        return false;
      }
      if (!entry.ids.has(productId)) return false;
      // A use counts as recency for both the id and the session (the TTL still runs from the last markSeen).
      entry.ids.delete(productId);
      entry.ids.add(productId);
      seen.delete(session);
      seen.set(session, entry);
      return true;
    },

    async fetchPhoto(productId) {
      const ref = parseProductId(productId);
      if (!ref) throw new ProviderError('product_not_found', `"${productId}" is not a product id`);
      const s = slotFor(ref.provider);
      const p = s.provider;
      if (!p.fetchPhoto) throw new ProviderError('product_not_found', `${p.id} has no product photos`);
      return cache.flight(
        `photo\0${formatProductId(ref)}`,
        TTL_PHOTO_MS,
        async () => {
          const rec = await reg.getProduct(productId);
          if (!rec.photoUrl) throw new ProviderError('product_not_found', `${productId} has no photo`);
          return readPhoto(await p.fetchPhoto!(rec, s.ctx.background ?? s.ctx), PHOTO_MAX_BYTES);
        },
        (ph) => ph.data.byteLength,
      );
    },
  };
  return reg;
}

/** MIME type from the magic bytes (the upstream header is not trusted); raster images only, never SVG. */
export function sniffImage(b: Uint8Array): string | undefined {
  const at = (o: number, ...bytes: number[]) => bytes.every((x, i) => b[o + i] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return 'image/avif';
  return undefined;
}

async function readPhoto(m: ModelStream, maxBytes: number): Promise<{ data: Uint8Array; contentType: string }> {
  const res = new Response(m.stream, { headers: m.size !== undefined ? { 'content-length': String(m.size) } : {} });
  const tooBig = () => new ProviderError('model_unavailable', `photo is larger than ${maxBytes} bytes`);
  const data = await readBytesCapped(res, maxBytes, tooBig);
  const contentType = sniffImage(data);
  if (!contentType) throw new ProviderError('model_unavailable', 'the downloaded file is not a raster image');
  return { data, contentType };
}

/** Reads a provider model fully (the upstream stream is consumed once, then served from memory), enforcing the size cap and the GLB magic. */
async function readModel(m: ModelStream, maxBytes: number): Promise<Uint8Array> {
  if (m.size !== undefined && m.size > maxBytes) {
    await m.stream.cancel().catch(() => undefined);
    throw new ProviderError('model_unavailable', `model is ${m.size} bytes (limit ${maxBytes})`);
  }
  const reader = m.stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderError('model_unavailable', `model is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  if (out.byteLength < 12 || GLB_MAGIC.some((b, i) => out[i] !== b)) {
    throw new ProviderError('model_unavailable', 'the downloaded file is not a binary glTF (GLB)');
  }
  return out;
}

/** A registry with nothing enabled: no provider module is imported and every product route answers `provider_disabled`. */
export function createDisabledRegistry(opts: Omit<RegistryOptions, 'enabled'> = {}): LiveRegistry {
  return assembleRegistry({ ...opts, enabled: [] }, new Map());
}

export type { SearchOptions };
