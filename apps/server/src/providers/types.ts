import type { CircuitState, ProductRecord, ProviderCapabilities, ProviderErrorCode, ProviderInfo } from '@flat/scene';
import { PROVIDER_ERROR_HINTS } from '@flat/scene';

/**
 * Provider framework contracts (D3, M5.0; implemented by lane C / stories M5.6-M5.8).
 *
 * LOCAL-ONLY RULE (D4): provider code and everything it returns stay in `apps/server`. The web app and
 * the Pages build must never import this folder (ESLint boundary + CI graph test), and nothing a
 * provider returns is committed or served from Pages. Credentials come from the environment only and
 * are redacted in logs.
 */

/** Options of `ProductProvider.search`. */
export interface SearchOptions {
  limit: number;
  category?: ProductRecord['category'];
  minPrice?: number;
  maxPrice?: number;
  /** Keep products that fit this box (metres per axis). */
  maxDims?: { w?: number; d?: number; h?: number };
}

/** A model stream: GLB bytes fetched upstream with GET (some CDNs block HEAD), proxied by the local server. */
export interface ModelStream {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  /** Bytes, when the upstream announced it (enforces the 20 MB per-model cap). */
  size?: number;
}

const partialResults = new WeakSet<object>();
/** Marks a search result as incomplete (the rest is still being read in the background): the registry then does not cache it. */
export function markPartial<T extends object>(results: T): T {
  partialResults.add(results);
  return results;
}
export const isPartial = (results: object): boolean => partialResults.has(results);

/** Everything a provider needs from its host. Injected so tests run without network, clock or disk. */
export interface ProviderContext {
  /** The only way to reach the network: the framework wraps it with the UA, 1 req/host, 1.5 s gap, robots.txt, GET-only and the circuit breaker. */
  fetch: typeof fetch;
  /** Memory-only cache (LRU + TTL) scoped to the provider. Search 10 min, product 1 h, GLB 1 h; 200 MB total, 20 MB per entry. */
  cache: ProviderCache;
  clock: { now(): number };
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Cancelled when the HTTP request that triggered the call is aborted. */
  signal?: AbortSignal;
  /**
   * The same context at LOW priority: its requests wait behind every interactive one in the host queue (prefetching the
   * rest of a search, a model nobody asked for yet). Refused quietly (`provider_unavailable` "busy") when the queue is long.
   */
  background?: ProviderContext;
  /** DNS: every address of a host name (IPv4 and IPv6). Injected so SSRF tests need no network; defaults to `dns.lookup(all)`. */
  lookup?: (hostname: string) => Promise<string[]>;
}

export interface ProviderCache {
  get<T>(key: string): T | undefined;
  /** `ttlMs` from now; `bytes` counts against the size caps (default: 1). */
  set<T>(key: string, value: T, ttlMs: number, bytes?: number): void;
  delete(key: string): void;
}

/**
 * A product source. All methods may throw `ProviderError`; the framework turns it into the matching
 * HTTP / MCP error, and repeated `provider_blocked` / `provider_unavailable` failures open the circuit.
 */
export interface ProductProvider {
  /** Slug used in product ids: `ikea-fr`, `pasted-url`, `mock`. */
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  /** Terms restrict use to private, local viewing (shows the personal-use banner). */
  readonly personalUseOnly: boolean;
  /** Short user-facing note shown in the provider list. */
  readonly note?: string;
  /** Records for a text query, best first, at most `opts.limit`. */
  search(query: string, opts: SearchOptions, ctx: ProviderContext): Promise<ProductRecord[]>;
  /** One product by SKU. Throws `product_not_found`. */
  get(sku: string, ctx: ProviderContext): Promise<ProductRecord>;
  /** Only when `capabilities.resolveUrl`: reads one pasted product page. Throws `url_not_allowed`, `provider_blocked`, `provider_parse_failed`, `product_dims_missing`. */
  resolveUrl?(url: string, ctx: ProviderContext): Promise<ProductRecord>;
  /** Only when `capabilities.model3d`: the product's GLB. Throws `model_unavailable`. */
  fetchModel?(sku: string, ctx: ProviderContext): Promise<ModelStream>;
  /** The product photo (`record.photoUrl`), fetched through `ctx.fetch` only after the provider checked the host. The caller caps size and sniffs the MIME type. */
  fetchPhoto?(record: ProductRecord, ctx: ProviderContext): Promise<ModelStream>;
}

/** Failure of a provider call: a stable `code`, a message for the log and a hint for the model. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly hint: string;
  /** For `provider_rate_limited` / `provider_unavailable`: when to try again (epoch ms). */
  readonly retryAt?: number;
  /** Structured extras for in-process callers, e.g. `{ knownDims: { w: 0.77, h: 1.47 } }` for `product_dims_missing`. */
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(
    code: ProviderErrorCode,
    message: string,
    options: { hint?: string; retryAt?: number; cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ProviderError';
    this.code = code;
    this.hint = options.hint ?? PROVIDER_ERROR_HINTS[code];
    if (options.retryAt !== undefined) this.retryAt = options.retryAt;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** Live state of one registered provider. */
export interface ProviderState {
  provider: ProductProvider;
  enabled: boolean;
  circuit: CircuitState;
  retryAt?: number;
}

/**
 * The set of providers of this server, built from `FLAT_PROVIDERS` (comma list of ids; default `mock`
 * in tests, empty otherwise). Implemented by M5.6. Every method returns a promise that rejects with a
 * `ProviderError` for expected failures.
 */
export interface ProviderRegistry {
  /** Provider ids that are enabled. */
  enabledIds(): string[];
  /** All providers, enabled or not, with their circuit state: the body of `GET /api/providers`. */
  info(): ProviderInfo[];
  /** The provider, or undefined when unknown. Does not check `enabled`. */
  get(id: string): ProductProvider | undefined;
  /** Search one provider (`providerId`) or every enabled one; a failing provider is reported, not thrown. */
  search(query: string, opts: SearchOptions & { providerId?: string }): Promise<{ records: ProductRecord[]; statuses: { provider: string; ok: boolean; code?: ProviderErrorCode; message?: string }[]; truncated: boolean }>;
  /** `"provider:sku"` -> record (cached). Throws `unknown_provider`, `provider_disabled`, `product_not_found`, ... */
  getProduct(productId: string): Promise<ProductRecord>;
  /** Pasted URL -> record, through the first enabled provider that `resolveUrl`s it. */
  resolveUrl(url: string): Promise<ProductRecord>;
  /** GLB bytes for a product (cached 1 h, 20 MB cap). Throws `model_unavailable`. */
  fetchModel(productId: string): Promise<ModelStream>;
  /** Starts downloading the GLBs of these products at low priority (fire and forget; unknown, disabled or model-less ones are skipped). */
  prefetchModels?(productIds: readonly string[]): void;
  /** The product photo bytes (memory-cached 1 h, 2 MB cap, raster images only): the web never hotlinks retailer photos. */
  fetchPhoto(productId: string): Promise<{ data: Uint8Array; contentType: string }>;
  /** Records the ids a search returned to an MCP session (the "seen" registry of D9). */
  markSeen(session: string, productIds: readonly string[]): number;
  isSeen(session: string, productId: string): boolean;
}
