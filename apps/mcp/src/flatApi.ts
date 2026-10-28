import {
  type Author,
  type CheckpointsResponse,
  type CommandEnvelope,
  type HistoryResponse,
  type PostCheckpointBody,
  type PostCheckpointResponse,
  type PostCommandResponse,
  type PostViewBody,
  type PostViewResponse,
  type SceneResponse,
  type UndoToBody,
  type UndoToResponse,
} from '@flat/scene';
import {
  ASSET_PATH_PREFIX,
  providerModelUrl,
  serverMeshUrl,
  type GetProductResponse,
  type IsSeenResponse,
  type MarkSeenResponse,
  type ProductSearchParamsInput,
  type ProductSearchResponse,
  type ProvidersResponse,
} from '@flat/assets';
import type { McpConfig } from './config';
import { ulid } from './ulid';

/**
 * The only door from the MCP tools to the scene server. Tools depend on this interface, never on
 * `fetch`: tests inject `MockFlatApi` (in-memory, real reducer + history), production uses
 * `HttpFlatApi`. Every method resolves (never throws) with `FlatResult`.
 */

type ApiErrorItem = { code: string; path: string; message: string; hint?: string };

/** The scene server did not answer (down, refused, timed out) or answered with an error. */
export type FlatApiFailure =
  | {
      ok: false;
      kind: 'unreachable';
      message: string;
      /** The request timed out. */
      timedOut?: boolean;
      /** A write whose outcome is unknown (timeout or connection reset after sending): the server may have committed it. */
      mayHaveApplied?: boolean;
    }
  | { ok: false; kind: 'http'; status: number; errors: ApiErrorItem[]; /** Current revision for 409 `precondition_failed`. */ rev?: number; epoch?: string };
export type FlatResult<T> = { ok: true; data: T } | FlatApiFailure;

export interface WriteOptions {
  /** Fail with `precondition_failed` (-> `stale_scene`) unless the scene is at this revision. */
  ifRev?: number;
}

export interface StepBody {
  /** Idempotency id (one per tool call; a retry with the same id returns the first result). */
  id?: string;
  author?: Author;
  ifRev?: number;
}

export interface FlatApi {
  /** `GET /api/scene` */
  getScene(): Promise<FlatResult<SceneResponse>>;
  /** `POST /api/commands`; `opts.ifRev` is copied into the envelope. 422 -> `errors`, 409 -> stale. */
  postCommand(envelope: CommandEnvelope, opts?: WriteOptions): Promise<FlatResult<PostCommandResponse>>;
  /** `GET /api/history` (shared stack: entries of every author). */
  history(): Promise<FlatResult<HistoryResponse>>;
  /** `POST /api/undo`: reverts the latest change, whoever made it. */
  undo(body?: StepBody): Promise<FlatResult<PostCommandResponse>>;
  /** `POST /api/redo` */
  redo(body?: StepBody): Promise<FlatResult<PostCommandResponse>>;
  /** `POST /api/checkpoints` (lane C, M4.7). */
  checkpoint(body: PostCheckpointBody): Promise<FlatResult<PostCheckpointResponse>>;
  /** `GET /api/checkpoints` (lane C). */
  listCheckpoints(): Promise<FlatResult<CheckpointsResponse>>;
  /** `POST /api/undo-to` (lane C). */
  undoTo(body: UndoToBody): Promise<FlatResult<UndoToResponse>>;
  /** `POST /api/view` (lane C): ephemeral relay to the user's tab. */
  postView(body: PostViewBody): Promise<FlatResult<PostViewResponse>>;
  /** `GET /api/materials`: the material library catalog (raw JSON). */
  materials(): Promise<FlatResult<unknown>>;

  // ---- M5 products (providers live in the scene server; nothing here touches a retailer) ----
  /** `GET /api/providers` */
  listProviders(): Promise<FlatResult<ProvidersResponse>>;
  /** `GET /api/products/search?q=&provider=&category=&minPrice=&maxPrice=&maxW=&maxD=&maxH=&limit=` */
  searchProducts(params: ProductSearchParamsInput): Promise<FlatResult<ProductSearchResponse>>;
  /** `GET /api/products/:productId` (the id is `provider:sku`, URL-encoded). 404 -> `product_not_found`. */
  getProduct(productId: string): Promise<FlatResult<GetProductResponse>>;
  /** `POST /api/products/resolve` with `{url}`: reads one pasted product page (paste-URL provider). */
  resolveProductUrl(url: string): Promise<FlatResult<GetProductResponse>>;
  /** `POST /api/products/seen` with `{session, productIds}`: the ids a search returned to this MCP session. */
  markProductsSeen(session: string, productIds: readonly string[]): Promise<FlatResult<MarkSeenResponse>>;
  /** `GET /api/products/seen?session=&id=`: whether a search of this session returned the product (D9: only seen products can be placed). */
  isProductSeen(session: string, productId: string): Promise<FlatResult<IsSeenResponse>>;
  /**
   * URL (no request is made) the viewer / a render uses to fetch a model, same origin as the scene server:
   * `GET /api/assets/products/:provider/:sku.glb` (a provider model, streamed; personal use) or
   * `GET /api/assets/meshes/:assetId.glb` (a library mesh).
   */
  assetUrl(ref: AssetRef): string;
  /**
   * `GET` of an `assetUrl` (a provider GLB or a library mesh) with the server token. The render service
   * serves it to the headless viewer: the render page has its own origin, which the server's provider
   * routes (origin-checked, retailer data) rightly refuse, so the browser never talks to them itself.
   */
  fetchAsset(url: string): Promise<FlatResult<FetchedAsset>>;
}

export interface FetchedAsset {
  status: number;
  contentType: string;
  body: Uint8Array;
}

/** What `FlatApi.assetUrl` addresses. */
export type AssetRef = { kind: 'product-model'; productId: string } | { kind: 'mesh'; assetId: string };

/** Errors that prove the request never reached the server (so a write cannot have been applied). */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

export interface HttpFlatApiOptions {
  /** Pause before the single retry of an idempotent write (default 150 ms). */
  retryDelayMs?: number;
}

/**
 * HTTP implementation. Writes (`postCommand`, `undo`, `redo`, `undoTo`) are retried ONCE on a network
 * error or timeout, with the same envelope / id: the scene server answers a repeated id with the first
 * result, so a change that was committed but whose answer was lost is applied exactly once. If the
 * retry also fails with a timeout or reset, the failure says the write `mayHaveApplied`.
 */
export class HttpFlatApi implements FlatApi {
  private readonly retryDelayMs: number;
  constructor(
    private readonly config: Pick<McpConfig, 'serverUrl' | 'token' | 'requestTimeoutMs'>,
    private readonly fetchImpl: typeof fetch = fetch,
    options: HttpFlatApiOptions = {},
  ) {
    this.retryDelayMs = options.retryDelayMs ?? 150;
  }

  /** One attempt (retry only for idempotent writes: `retry`). */
  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, retry = false, timeoutMs = this.config.requestTimeoutMs): Promise<FlatResult<T>> {
    let r = await this.attempt<T>(method, path, body, timeoutMs);
    if (retry && !r.ok && r.kind === 'unreachable') {
      if (this.retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      r = await this.attempt<T>(method, path, body, timeoutMs);
    }
    return r;
  }

  private async attempt<T>(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<FlatResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.serverUrl + path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      const timedOut = isTimeout(e);
      const neverSent = !timedOut && ((cause?.code !== undefined && NEVER_SENT.has(cause.code)) || cause?.message === 'bad port');
      return {
        ok: false,
        kind: 'unreachable',
        message: `${this.config.serverUrl}${path}: ${timedOut ? `timed out after ${timeoutMs} ms` : (cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e)))}`,
        ...(timedOut ? { timedOut: true } : {}),
        mayHaveApplied: method === 'POST' && !neverSent,
      };
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // not JSON
    }
    if (res.ok) return { ok: true, data: json as T };
    const j = (json ?? {}) as { errors?: ApiErrorItem[]; rev?: number; epoch?: string };
    const errors = Array.isArray(j.errors) && j.errors.length ? j.errors : [{ code: 'internal_error', path: '', message: `scene server answered ${res.status}` }];
    return { ok: false, kind: 'http', status: res.status, errors, ...(j.rev !== undefined ? { rev: j.rev } : {}), ...(j.epoch !== undefined ? { epoch: j.epoch } : {}) };
  }

  /** Provider calls go to a retailer politely (1.5 s gap per request; a search also reads product pages): a cold live IKEA search takes 10-20 s, more when several are queued; the server answers after about 20 s with what it has read. */
  private providerTimeoutMs(): number {
    return Math.max(this.config.requestTimeoutMs, 90_000);
  }

  getScene() {
    return this.call<SceneResponse>('GET', '/api/scene');
  }
  postCommand(envelope: CommandEnvelope, opts: WriteOptions = {}) {
    return this.call<PostCommandResponse>('POST', '/api/commands', opts.ifRev !== undefined ? { ...envelope, ifRev: opts.ifRev } : envelope, true);
  }
  history() {
    return this.call<HistoryResponse>('GET', '/api/history');
  }
  undo(body: StepBody = {}) {
    return this.call<PostCommandResponse>('POST', '/api/undo', { ...body, id: body.id ?? ulid() }, true);
  }
  redo(body: StepBody = {}) {
    return this.call<PostCommandResponse>('POST', '/api/redo', { ...body, id: body.id ?? ulid() }, true);
  }
  checkpoint(body: PostCheckpointBody) {
    return this.call<PostCheckpointResponse>('POST', '/api/checkpoints', body);
  }
  listCheckpoints() {
    return this.call<CheckpointsResponse>('GET', '/api/checkpoints');
  }
  undoTo(body: UndoToBody) {
    return this.call<UndoToResponse>('POST', '/api/undo-to', { ...body, id: body.id ?? ulid() }, true);
  }
  postView(body: PostViewBody) {
    return this.call<PostViewResponse>('POST', '/api/view', body);
  }
  materials() {
    return this.call<unknown>('GET', '/api/materials');
  }
  listProviders() {
    return this.call<ProvidersResponse>('GET', '/api/providers');
  }
  searchProducts(params: ProductSearchParamsInput) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
    return this.call<ProductSearchResponse>('GET', `/api/products/search?${qs}`, undefined, false, this.providerTimeoutMs());
  }
  getProduct(productId: string) {
    return this.call<GetProductResponse>('GET', `/api/products/${encodeURIComponent(productId)}`, undefined, false, this.providerTimeoutMs());
  }
  resolveProductUrl(url: string) {
    return this.call<GetProductResponse>('POST', '/api/products/resolve', { url }, false, this.providerTimeoutMs());
  }
  markProductsSeen(session: string, productIds: readonly string[]) {
    return this.call<MarkSeenResponse>('POST', '/api/products/seen', { session, productIds }, true);
  }
  isProductSeen(session: string, productId: string) {
    return this.call<IsSeenResponse>('GET', `/api/products/seen?${new URLSearchParams({ session, id: productId })}`);
  }
  async fetchAsset(url: string): Promise<FlatResult<FetchedAsset>> {
    // The URL is normalised first (`..` segments resolved) so the prefix test below is about where the request really goes.
    let target: URL | undefined;
    try {
      target = new URL(url);
    } catch {
      target = undefined;
    }
    if (!target || target.origin !== new URL(this.config.serverUrl).origin || !target.pathname.startsWith(ASSET_PATH_PREFIX)) {
      return { ok: false, kind: 'http', status: 403, errors: [{ code: 'forbidden', path: '', message: "only the scene server's /api/assets/ can be fetched" }] };
    }
    try {
      const res = await this.fetchImpl(target.href, {
        headers: this.config.token ? { authorization: `Bearer ${this.config.token}` } : {},
        // A model may wait behind other polite downloads (one per 1.5 s): the render decides how long to wait, not this request.
        signal: AbortSignal.timeout(Math.max(this.config.requestTimeoutMs, 120_000)),
      });
      return { ok: true, data: { status: res.status, contentType: res.headers.get('content-type') ?? 'application/octet-stream', body: new Uint8Array(await res.arrayBuffer()) } };
    } catch (e) {
      return { ok: false, kind: 'unreachable', message: `${url}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  assetUrl(ref: AssetRef): string {
    // The URL builders of @flat/assets (the same ones as the web viewer); the server declares these routes from ASSET_ROUTES.
    if (ref.kind === 'mesh') return serverMeshUrl(this.config.serverUrl, ref.assetId);
    const url = providerModelUrl(this.config.serverUrl, ref.productId);
    if (!url) throw new RangeError(`invalid product id "${ref.productId}"`);
    return url;
  }
}
