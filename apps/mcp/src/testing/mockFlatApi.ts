import {
  applyCommand,
  canRedo,
  canUndo,
  createHistory,
  loadSceneText,
  matchProducts,
  parseProductId,
  ProductRecord,
  summarizeProduct,
  parseCommand,
  recordCommand,
  describeCommand,
  redo as redoStep,
  undo as undoStep,
  type Author,
  type Checkpoint,
  type CheckpointsResponse,
  type CommandEnvelope,
  type GetProductResponse,
  type History,
  type HistoryResponse,
  type IsSeenResponse,
  type LogEntry,
  type MarkSeenResponse,
  type PostCheckpointBody,
  type PostCheckpointResponse,
  type PostCommandResponse,
  type PostViewBody,
  type PostViewResponse,
  type ProductSearchParamsInput,
  type ProductSearchResponse,
  type ProviderInfo,
  type ProvidersResponse,
  type Scene,
  type SceneResponse,
  type UndoToBody,
  type UndoToResponse,
} from '@flat/scene';
import charme from '@flat/scene/fixtures/charme-3205.flat.json';
import productsFixture from '@flat/scene/fixtures/products.json';
import type { AssetRef, FlatApi, FlatApiFailure, FlatResult, StepBody, WriteOptions } from '../flatApi';

/** The Charme 3205 fixture, parsed and validated. */
export function charmeScene(): Scene {
  const loaded = loadSceneText(JSON.stringify(charme));
  if (!loaded.ok) throw new Error(`fixture invalid: ${loaded.errors.join('; ')}`);
  return loaded.scene;
}

/** The fixture products (`packages/scene/fixtures/products.json`, provider `mock`), validated. */
export function mockProductRecords(): ProductRecord[] {
  return (productsFixture as unknown[]).map((p) => ProductRecord.parse(p));
}

export interface MockOptions {
  /** Products of the `mock` provider (default: the fixture products). */
  products?: ProductRecord[];
  scene?: Scene;
  /** Clock for step envelopes (default `Date.now`). */
  now?: () => number;
  epoch?: string;
  /** Returned by `materials()`. */
  materials?: unknown;
}

/**
 * In-memory `FlatApi` for lane tests: no server, no network. It runs the REAL `applyCommand`,
 * `recordCommand`, `undo` and `redo` from `@flat/scene` with the server's semantics (one shared
 * history, `ifRev` -> 409, parse/apply errors -> 422, retries with the same id return the first
 * response, checkpoints keyed by undo depth). It does not persist.
 *
 * Test controls: `down` (every call fails as `unreachable`), `failNext(failure)`, `calls`
 * (method names in order), `views` (relayed `postView` bodies), `log` (applied entries).
 */
export class MockFlatApi implements FlatApi {
  epoch: string;
  rev = 0;
  seq = 0;
  scene: Scene;
  hist: History = createHistory();
  readonly log: LogEntry[] = [];
  readonly views: PostViewBody[] = [];
  readonly calls: string[] = [];
  checkpoints: Checkpoint[] = [];
  /** Id of the history top when each checkpoint was taken (mirrors the server's divergence check). */
  private readonly cpTop = new Map<string, string | undefined>();
  /** When true every call resolves `unreachable`. */
  down = false;
  private nextFailure: FlatApiFailure | undefined;
  private readonly seen = new Map<string, { hash: string; response: PostCommandResponse }>();
  private readonly now: () => number;
  private readonly catalog: unknown;
  private stepCounter = 0;
  /** Products served by `searchProducts` / `getProduct` / `resolveProductUrl`. */
  products: ProductRecord[];
  /** Provider list returned by `listProviders` (default: one enabled `mock` provider). */
  providers: ProviderInfo[];
  /** Per MCP session: ids returned by searches (or marked with `markProductsSeen`). */
  readonly seenProducts = new Map<string, Set<string>>();

  constructor(options: MockOptions = {}) {
    this.scene = options.scene ?? charmeScene();
    this.now = options.now ?? Date.now;
    this.epoch = options.epoch ?? 'mock-epoch';
    this.catalog = options.materials ?? { materials: [] };
    this.products = options.products ?? mockProductRecords();
    this.providers = [
      {
        id: 'mock',
        label: 'Mock catalog (offline fixtures)',
        capabilities: { search: true, model3d: false, dims: 'structured', resolveUrl: true },
        enabled: true,
        circuit: 'closed',
        personalUseOnly: false,
      },
    ];
  }

  /** Makes the next call fail with `failure`. */
  failNext(failure: FlatApiFailure): void {
    this.nextFailure = failure;
  }

  private gate<T>(name: string): FlatResult<T> | undefined {
    this.calls.push(name);
    if (this.down) return { ok: false, kind: 'unreachable', message: 'mock server is down' };
    if (this.nextFailure) {
      const f = this.nextFailure;
      this.nextFailure = undefined;
      return f;
    }
    return undefined;
  }

  private http(status: number, code: string, message: string, path = '', extra: { rev?: number; epoch?: string } = {}): FlatApiFailure {
    return { ok: false, kind: 'http', status, errors: [{ code, path, message }], ...extra };
  }

  async getScene(): Promise<FlatResult<SceneResponse>> {
    return this.gate<SceneResponse>('getScene') ?? { ok: true, data: { epoch: this.epoch, rev: this.rev, scene: this.scene } };
  }

  async postCommand(envelope: CommandEnvelope, opts: WriteOptions = {}): Promise<FlatResult<PostCommandResponse>> {
    const g = this.gate<PostCommandResponse>('postCommand');
    if (g) return g;
    const input = opts.ifRev !== undefined ? { ...envelope, ifRev: opts.ifRev } : envelope;
    const parsed = parseCommand(input);
    if (!parsed.ok) return { ok: false, kind: 'http', status: 422, errors: parsed.errors };
    const env = parsed.envelope;
    const hash = JSON.stringify({ ...env, ts: 0 });
    const dup = this.seen.get(env.id);
    if (dup) {
      return dup.hash === hash ? { ok: true, data: dup.response } : this.http(409, 'idempotency_conflict', `id ${env.id} was already used with a different command`, 'id', { rev: this.rev, epoch: this.epoch });
    }
    const r = applyCommand(this.scene, env, { rev: this.rev });
    if (!r.ok) {
      const stale = r.errors.some((e) => e.code === 'precondition_failed' && e.path === 'ifRev');
      return { ok: false, kind: 'http', status: stale ? 409 : 422, errors: r.errors, ...(stale ? { rev: this.rev, epoch: this.epoch } : {}) };
    }
    const outcome = { changed: r.changed, warnings: r.warnings, ...(r.noop ? { noop: true as const } : {}) };
    if (r.noop) {
      const response: PostCommandResponse = { ok: true, epoch: this.epoch, rev: this.rev, seq: this.seq, result: outcome };
      this.seen.set(env.id, { hash, response });
      return { ok: true, data: response };
    }
    this.hist = recordCommand(this.hist, env, r, env.ts, describeCommand(env.cmd, this.scene));
    return { ok: true, data: this.commit(env, r.scene, r.inverse, outcome, env.id, hash) };
  }

  private commit(env: CommandEnvelope, scene: Scene, inverse: LogEntry['inverse'], result: PostCommandResponse['result'], key: string, hash: string, link: { undoOf?: string; redoOf?: string } = {}): PostCommandResponse {
    this.scene = scene;
    this.seq += 1;
    this.rev += 1;
    this.log.push({ epoch: this.epoch, seq: this.seq, rev: this.rev, envelope: env, inverse, result, ...link });
    const response: PostCommandResponse = { ok: true, epoch: this.epoch, rev: this.rev, seq: this.seq, result };
    this.seen.set(key, { hash, response });
    return response;
  }

  private historyView(): HistoryResponse {
    const item = (e: History['past'][number]) => ({
      id: e.envelope.id,
      label: e.label ?? describeCommand(e.envelope.cmd, this.scene),
      ts: e.envelope.ts,
      author: e.envelope.author,
    });
    return { epoch: this.epoch, rev: this.rev, canUndo: canUndo(this.hist), canRedo: canRedo(this.hist), past: this.hist.past.map(item), future: this.hist.future.map(item) };
  }

  async history(): Promise<FlatResult<HistoryResponse>> {
    return this.gate<HistoryResponse>('history') ?? { ok: true, data: this.historyView() };
  }

  private step(kind: 'undo' | 'redo', body: StepBody): FlatResult<PostCommandResponse> {
    const id = body.id ?? `mock-${++this.stepCounter}`;
    const key = `${kind}:${id}`;
    const dup = this.seen.get(key);
    if (dup) return { ok: true, data: dup.response };
    if (body.ifRev !== undefined && body.ifRev !== this.rev) {
      return this.http(409, 'precondition_failed', `scene is at revision ${this.rev}, request expected ${body.ifRev}`, 'ifRev', { rev: this.rev, epoch: this.epoch });
    }
    const target = kind === 'undo' ? this.hist.past.at(-1) : this.hist.future.at(-1);
    if (!target) return this.http(409, 'invalid_command', `nothing to ${kind}`, '', { rev: this.rev, epoch: this.epoch });
    const ctx = { id, ts: this.now(), author: body.author ?? ({ kind: 'user', name: 'server' } as Author) };
    const s = kind === 'undo' ? undoStep(this.hist, this.scene, ctx) : redoStep(this.hist, this.scene, ctx);
    if (!s.ok) return { ok: false, kind: 'http', status: 422, errors: 'errors' in s ? s.errors : [{ code: 'invalid_command', path: '', message: s.reason }] };
    this.hist = s.history;
    const result = { changed: s.result.changed, warnings: s.result.warnings, ...(s.result.noop ? { noop: true as const } : {}) };
    const link = kind === 'undo' ? { undoOf: s.envelope.undoOf! } : { redoOf: s.envelope.redoOf! };
    return { ok: true, data: this.commit(s.envelope, s.scene, s.result.inverse, result, key, 'step', link) };
  }

  async undo(body: StepBody = {}): Promise<FlatResult<PostCommandResponse>> {
    return this.gate<PostCommandResponse>('undo') ?? this.step('undo', body);
  }

  async redo(body: StepBody = {}): Promise<FlatResult<PostCommandResponse>> {
    return this.gate<PostCommandResponse>('redo') ?? this.step('redo', body);
  }

  async checkpoint(body: PostCheckpointBody): Promise<FlatResult<PostCheckpointResponse>> {
    const g = this.gate<PostCheckpointResponse>('checkpoint');
    if (g) return g;
    const exists = this.checkpoints.some((c) => c.name === body.name);
    if (exists && !body.replace) {
      return this.http(409, 'checkpoint_exists', `checkpoint "${body.name}" already exists; pick another name or send replace: true`, 'name', { rev: this.rev, epoch: this.epoch });
    }
    const cp: Checkpoint = { name: body.name, rev: this.rev, seq: this.seq, depth: this.hist.past.length, ts: this.now(), author: body.author ?? { kind: 'user' } };
    this.checkpoints = [...this.checkpoints.filter((c) => c.name !== body.name), cp].slice(-20);
    this.cpTop.set(cp.name, this.hist.past.at(-1)?.envelope.id);
    return { ok: true, data: { ok: true, epoch: this.epoch, checkpoint: cp } };
  }

  async listCheckpoints(): Promise<FlatResult<CheckpointsResponse>> {
    return this.gate<CheckpointsResponse>('listCheckpoints') ?? { ok: true, data: { epoch: this.epoch, rev: this.rev, checkpoints: this.checkpoints } };
  }

  async undoTo(body: UndoToBody): Promise<FlatResult<UndoToResponse>> {
    const g = this.gate<UndoToResponse>('undoTo');
    if (g) return g;
    const cp = this.checkpoints.find((c) => c.name === body.checkpoint);
    if (!cp) return this.http(404, 'not_found', `no checkpoint named "${body.checkpoint}"`, 'checkpoint');
    if (body.ifRev !== undefined && body.ifRev !== this.rev) {
      return this.http(409, 'precondition_failed', `scene is at revision ${this.rev}, request expected ${body.ifRev}`, 'ifRev', { rev: this.rev, epoch: this.epoch });
    }
    const past = this.hist.past;
    const gone = (why: string) => this.http(409, 'checkpoint_unreachable', `checkpoint "${cp.name}" ${why}`, 'checkpoint', { rev: this.rev, epoch: this.epoch });
    if (past.length < cp.depth) return gone(`is at undo depth ${cp.depth} but the history is only ${past.length} deep (it was undone past the checkpoint)`);
    const top = this.cpTop.get(cp.name);
    if (cp.depth > 0 && top !== undefined && past[cp.depth - 1]?.envelope.id !== top) return gone('is no longer on the undo stack (the history diverged after it was taken)');
    const steps = past.length - cp.depth;
    if (steps === 0) {
      const result = { changed: { materials: [], walls: [], rooms: [], lights: [], site: false, defaults: false }, warnings: [], noop: true as const };
      return { ok: true, data: { ok: true, epoch: this.epoch, rev: this.rev, seq: this.seq, result, steps: 0 } };
    }
    let last: PostCommandResponse | undefined;
    for (let i = 0; i < steps; i++) {
      const r = this.step('undo', { ...(body.id ? { id: `${body.id}~${i}` } : {}), ...(body.author ? { author: body.author } : {}) });
      if (!r.ok) return r;
      last = r.data;
    }
    return { ok: true, data: { ...last!, steps } };
  }

  async postView(body: PostViewBody): Promise<FlatResult<PostViewResponse>> {
    const g = this.gate<PostViewResponse>('postView');
    if (g) return g;
    this.views.push(body);
    return { ok: true, data: { ok: true, delivered: 0 } };
  }

  async materials(): Promise<FlatResult<unknown>> {
    return this.gate<unknown>('materials') ?? { ok: true, data: this.catalog };
  }

  async listProviders(): Promise<FlatResult<ProvidersResponse>> {
    return this.gate<ProvidersResponse>('listProviders') ?? { ok: true, data: { providers: this.providers } };
  }

  /** Like the real server, a search marks nothing as seen by itself: the MCP tool calls `markProductsSeen`. */
  async searchProducts(params: ProductSearchParamsInput): Promise<FlatResult<ProductSearchResponse>> {
    const g = this.gate<ProductSearchResponse>('searchProducts');
    if (g) return g;
    if (params.provider !== undefined && !this.providers.some((p) => p.id === params.provider)) {
      return this.http(404, 'unknown_provider', `no provider "${params.provider}"`, 'provider');
    }
    const { matches, truncated } = matchProducts(this.products, params);
    return { ok: true, data: { results: matches.map(summarizeProduct), providers: [{ provider: 'mock', ok: true }], truncated } };
  }

  async getProduct(productId: string): Promise<FlatResult<GetProductResponse>> {
    const g = this.gate<GetProductResponse>('getProduct');
    if (g) return g;
    const ref = parseProductId(productId);
    if (!ref) return this.http(422, 'invalid_command', `invalid product id "${productId}"`, 'productId');
    const product = this.products.find((p) => p.provider === ref.provider && p.sku === ref.sku);
    return product ? { ok: true, data: { product } } : this.http(404, 'product_not_found', `no product "${productId}"`, 'productId');
  }

  async resolveProductUrl(url: string): Promise<FlatResult<GetProductResponse>> {
    const g = this.gate<GetProductResponse>('resolveProductUrl');
    if (g) return g;
    const product = this.products.find((p) => p.url === url);
    return product ? { ok: true, data: { product } } : this.http(422, 'url_not_allowed', `cannot read ${url}`, 'url');
  }

  async markProductsSeen(session: string, productIds: readonly string[]): Promise<FlatResult<MarkSeenResponse>> {
    const g = this.gate<MarkSeenResponse>('markProductsSeen');
    if (g) return g;
    const set = this.seenProducts.get(session) ?? new Set<string>();
    for (const id of productIds) set.add(id);
    this.seenProducts.set(session, set);
    return { ok: true, data: { ok: true, seen: set.size } };
  }

  async isProductSeen(session: string, productId: string): Promise<FlatResult<IsSeenResponse>> {
    const g = this.gate<IsSeenResponse>('isProductSeen');
    if (g) return g;
    return { ok: true, data: { seen: this.seenProducts.get(session)?.has(productId) ?? false } };
  }

  assetUrl(ref: AssetRef): string {
    if (ref.kind === 'mesh') return `http://mock.flat/api/assets/meshes/${encodeURIComponent(ref.assetId)}.glb`;
    const parsed = parseProductId(ref.productId);
    if (!parsed) throw new RangeError(`invalid product id "${ref.productId}"`);
    return `http://mock.flat/api/assets/products/${encodeURIComponent(parsed.provider)}/${encodeURIComponent(parsed.sku)}.glb`;
  }
}
