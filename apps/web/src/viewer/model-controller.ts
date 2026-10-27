import { GENERATORS, isBuiltinAsset } from '@flat/scene';
import type { Item, MeshAsset, MeshCatalog, MeshResolveContext, MeshSource, ResolvedMesh } from '@flat/scene';
import type { Loaded, ModelCache, ModelHandle } from './model-cache';
import { catalogWithout, libraryModelUrl, providerModelUrl } from './model-env';
import { HARD_DIMS_LIMIT, checkDims, rotateBoxY, boxSize, frontRotationY } from './model-math';
import type { Box, Dims, Front, ModelKind } from './model-math';
import type { DimsWarning, ModelSource, ModelStats } from './model-types';

export type { DimsWarning, ModelSource, ModelStats } from './model-types';

/**
 * Decides, per item, which model to draw and keeps the state of the chain (M5.12, D2):
 *   provider GLB (server mode only) -> CC0 / local lookalike -> parametric -> placeholder.
 * It never changes the scene: a failed load only moves the item down the chain. No React and no WebGL in
 * here (the loader and the cache are injected), so the chain is unit-tested with a mock loader.
 */


export interface ModelLike {
  /** Native bounding box of the model, in its own coordinates. */
  box: Box;
}


export interface ItemModel<T extends ModelLike> {
  itemId: string;
  /** `loading`: a model is being fetched (a placeholder box is drawn); `ready`: drawn from the model; `settled`: no model, the item uses its mesh data. */
  status: 'loading' | 'ready' | 'settled';
  source: ModelSource;
  url?: string;
  front: Front;
  dims: Dims;
  model?: T;
  warning?: DimsWarning;
  /** The item wants a provider / local-only model and there is no server (Pages or Local mode): the UI shows an "offline" badge. */
  offline: boolean;
  /** URLs that failed to load on the way down the chain. */
  failures: string[];
  /** A settled item whose chain ended at a generator the item does not carry itself (its provider model failed): drawn with this shape. */
  fallbackMesh?: Extract<MeshSource, { kind: 'parametric' }>;
  /** Why this source won (from the resolver, or the failure that moved it). */
  reason: string;
}

export interface ControllerDeps<T extends ModelLike> {
  cache: ModelCache<T>;
  /** Fetches and decodes a model. */
  load: (url: string) => Promise<Loaded<T>>;
  resolve: (item: Pick<Item, 'assetId' | 'dims' | 'product' | 'productRef' | 'mesh'>, ctx: MeshResolveContext) => ResolvedMesh;
  catalog: () => Promise<MeshCatalog>;
  /** Origin of the connected server, or null (Local / Pages mode). */
  origin: () => string | null;
  base?: () => string;
  /** Per-item override of the front axis of a PROVIDER model (they are assumed to face +z). */
  providerFront?: (item: Item) => Front | undefined;
  /** Schedules a retry of a failed provider load; returns its cancel function (default `setTimeout`). Injected by tests. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/** Waits (ms) before the 1st, 2nd... retry of a provider model that failed to load (a retry also happens at once when the origin changes). */
export const PROVIDER_RETRY_MS: readonly number[] = [15_000, 60_000];


/**
 * Item fields that decide which model is used; moves and rotations do not re-resolve. The server `origin` is part
 * of it: an item resolved offline (lookalike) is resolved again when the server connects, and a provider model that
 * failed against one server is tried again against another.
 */
export function resolveSignature(item: Item, origin: string | null = null): string {
  return JSON.stringify([item.assetId, item.mesh ?? null, item.productRef ?? null, item.product?.dims ?? null, item.product?.category ?? null, item.dims ?? null, origin]);
}

/**
 * True for items that can never use a model file: legacy built-ins and items whose stored source is a
 * generator. They cost no request (not even the catalog) and are drawn by `buildItems`.
 */
export function isPlainBuiltin(item: Pick<Item, 'assetId' | 'mesh' | 'productRef'>): boolean {
  return (isBuiltinAsset(item.assetId) && !item.mesh && !item.productRef) || item.mesh?.kind === 'parametric';
}

/** Whether the item asks for a model that only the local server can supply. */
function wantsProvider(item: Pick<Item, 'mesh' | 'productRef'>): boolean {
  return item.mesh?.kind === 'provider' || (item.mesh === undefined && item.productRef !== undefined);
}

const MAX_ATTEMPTS = 8;

interface Record_<T extends ModelLike> {
  sig: string;
  state: ItemModel<T>;
  handle?: ModelHandle<T>;
  /** Retries of a failed provider load already made / the pending one. */
  retries: number;
  cancelRetry?: () => void;
}

export class ModelController<T extends ModelLike> {
  private readonly records = new Map<string, Record_<T>>();
  /** Items that never use a model (see `isPlainBuiltin`), by id. */
  private plain = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private settleWaiters: (() => void)[] = [];
  private version = 0;
  private failedFiles = 0;
  private readonly requested: string[] = [];
  private disposed = false;

  constructor(private readonly deps: ControllerDeps<T>) {}

  // ---- observation ----------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Changes whenever any item state changes (for `useSyncExternalStore`). */
  getVersion = (): number => this.version;

  state(itemId: string): ItemModel<T> | undefined {
    return this.records.get(itemId)?.state;
  }

  /** Items whose model could not be used and that fall back to a generator: the shape to draw them with (`buildItems` only knows the item's own `mesh`). */
  fallbacks(): Map<string, Extract<MeshSource, { kind: 'parametric' }>> {
    const out = new Map<string, Extract<MeshSource, { kind: 'parametric' }>>();
    for (const [id, r] of this.records) if (r.state.status === 'settled' && r.state.fallbackMesh) out.set(id, r.state.fallbackMesh);
    return out;
  }

  /** Ids of items the controller draws (loading placeholder or model); the rest come from `buildItems`. */
  claimed(): Set<string> {
    const out = new Set<string>();
    for (const [id, r] of this.records) if (r.state.status !== 'settled') out.add(id);
    return out;
  }

  pending(): number {
    let n = 0;
    for (const r of this.records.values()) if (r.state.status === 'loading') n++;
    return n;
  }

  /** Resolves when no item is loading (immediately when none is). */
  settled(): Promise<void> {
    if (this.pending() === 0) return Promise.resolve();
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  stats(): ModelStats {
    const sources: Record<string, ModelSource> = {};
    const offline: string[] = [];
    const loading: string[] = [];
    const reasons: Record<string, string> = {};
    const warnings: ModelStats['warnings'] = [];
    let loaded = 0;
    for (const id of this.plain) sources[id] = 'parametric';
    for (const [id, r] of this.records) {
      sources[id] = r.state.status === 'loading' ? 'placeholder' : r.state.source;
      if (r.state.status === 'ready') loaded++;
      if (r.state.status === 'loading') loading.push(id);
      reasons[id] = r.state.failures.length > 0 && !r.state.reason.includes('failed') ? `${r.state.reason} (failed: ${r.state.failures.join(', ')})` : r.state.reason;
      if (r.state.offline) offline.push(id);
      if (r.state.warning) warnings.push({ itemId: id, warning: r.state.warning });
    }
    const c = this.deps.cache.stats();
    return {
      loaded,
      pending: this.pending(),
      failed: this.failedFiles,
      sources,
      loading,
      reasons,
      offline,
      warnings,
      requests: [...this.requested],
      cache: { models: c.models, inUse: c.inUse, bytes: c.bytes, evictions: c.evictions },
    };
  }

  // ---- driving ---------------------------------------------------------------------------------

  /**
   * Brings the controller in step with the scene's items: new or changed items start resolving, removed ones
   * give their model back. Idempotent and silent (listeners are only told later, from async work), so it is
   * safe to call while rendering.
   */
  update(items: readonly Item[]): void {
    if (this.disposed) return;
    const seen = new Set<string>();
    this.plain = new Set();
    for (const item of items) {
      seen.add(item.id);
      if (isPlainBuiltin(item)) {
        this.plain.add(item.id);
        this.drop(item.id);
        continue;
      }
      const sig = resolveSignature(item, this.deps.origin());
      if (this.records.get(item.id)?.sig === sig) continue;
      this.drop(item.id);
      this.start(item, sig, 0);
    }
    for (const id of [...this.records.keys()]) if (!seen.has(id)) this.drop(id);
  }

  /** The WebGL context was restored: cached models re-upload. */
  restore(): void {
    this.deps.cache.restore();
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.records.keys()]) this.drop(id);
    this.listeners.clear();
    this.flushSettled();
  }

  // ---- internals ---------------------------------------------------------------------------------

  private start(item: Item, sig: string, retries: number): void {
    const rec: Record_<T> = {
      sig,
      retries,
      state: {
        itemId: item.id,
        status: 'loading',
        source: 'placeholder',
        front: '+z',
        dims: item.dims ?? item.product?.dims ?? { w: 0.3, d: 0.3, h: 0.3 },
        offline: false,
        failures: [],
        reason: 'resolving',
      },
    };
    this.records.set(item.id, rec);
    void this.run(item, rec);
  }

  /** A provider model failed: ask again after a backoff (a failed file is not a verdict; the server may have been busy). */
  private scheduleRetry(item: Item, rec: Record_<T>): void {
    const ms = PROVIDER_RETRY_MS[rec.retries];
    if (ms === undefined || this.disposed) return;
    const schedule = this.deps.schedule ?? ((fn, delay) => {
      const t = setTimeout(fn, delay);
      return () => clearTimeout(t);
    });
    rec.cancelRetry = schedule(() => {
      rec.cancelRetry = undefined;
      if (!this.current(item, rec)) return;
      this.drop(item.id);
      this.start(item, rec.sig, rec.retries + 1);
      this.notify();
    }, ms);
  }

  private drop(id: string): void {
    const rec = this.records.get(id);
    if (!rec) return;
    this.records.delete(id);
    rec.cancelRetry?.();
    rec.cancelRetry = undefined;
    rec.handle?.release();
    rec.handle = undefined;
  }

  private notify(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
    this.flushSettled();
  }

  private flushSettled(): void {
    if (this.pending() > 0 && !this.disposed) return;
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) w();
  }

  private current(item: Item, rec: Record_<T>): boolean {
    return !this.disposed && this.records.get(item.id) === rec;
  }

  private async run(item: Item, rec: Record_<T>): Promise<void> {
    const dims = item.dims ?? item.product?.dims;
    let catalog: MeshCatalog;
    try {
      catalog = await this.deps.catalog();
    } catch {
      catalog = { list: () => [], get: () => undefined, search: () => [] };
    }
    if (!this.current(item, rec)) return;
    const failedAssets = new Set<string>();
    let providerUsable = true;
    let providerFailed = false;
    /** Why the last model on the way down was given up (shown by the badge when the item ends on a fallback). */
    let why: string | undefined;
    const state = rec.state;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const origin = this.deps.origin();
      const resolved = this.deps.resolve(item, {
        catalog: catalogWithout(catalog, failedAssets),
        generators: GENERATORS,
        providerModelAvailable: () => providerUsable && origin !== null,
      });
      const target = this.targetOf(resolved, origin);
      state.offline = state.offline || (origin === null && (wantsProvider(item) || target.offlineOnly === true));
      state.dims = dims ?? resolved.dims;
      if (!target.url) {
        if (target.skip) {
          // The resolver offered a model we may not (or cannot) fetch: take it off the table and ask again.
          if (target.skip.kind === 'provider') providerUsable = false;
          else failedAssets.add(target.skip.assetId);
          state.reason = target.reason;
          continue;
        }
        state.status = 'settled';
        state.source = resolved.source === 'builtin' ? 'parametric' : resolved.source === 'provider' || resolved.source === 'lookalike' ? 'placeholder' : resolved.source;
        state.reason = providerFailed || state.failures.length > 0 ? `${resolved.reason}; the model fell back because: ${why ?? 'its file could not be used'}` : resolved.reason;
        if (resolved.source === 'parametric' && resolved.generator && item.mesh?.kind !== 'parametric') {
          state.fallbackMesh = { kind: 'parametric', generator: resolved.generator.id, params: resolved.generator.params as Record<string, number | string | boolean> };
        }
        if (providerFailed) this.scheduleRetry(item, rec);
        this.notify();
        return;
      }
      const url = target.url;
      try {
        const handle = await this.deps.cache.acquire(url, () => {
          this.requested.push(url);
          return this.deps.load(url);
        });
        if (!this.current(item, rec)) {
          handle.release();
          return;
        }
        // The front used to CHECK the proportions is the one used to DRAW the model (provider models may be overridden).
        const forced = target.kind === 'provider' ? this.deps.providerFront?.(item) : undefined;
        let front = forced ?? target.front;
        let check = checkDims(target.kind, boxSize(rotateBoxY(handle.value.box, frontRotationY(front))), state.dims);
        let turned = false;
        if (target.kind === 'provider' && forced === undefined && check.mismatch) {
          // Shops disagree with their own models about which side is the width: IKEA lists an island as "Largeur 77, Longueur 126"
          // (stored as w 0.77, d 1.26) while its model is 1.26 along x. Try the model turned a quarter; keep it when it fits clearly better.
          const alt: Front = '+x';
          const other = checkDims(target.kind, boxSize(rotateBoxY(handle.value.box, frontRotationY(alt))), state.dims);
          if (other.distortion + 0.05 < check.distortion) {
            front = alt;
            check = other;
            turned = true;
          }
        }
        if (check.distortion > HARD_DIMS_LIMIT) {
          // Far too different from the product's size: stretching it would misrepresent the product. Fall down the chain.
          handle.release();
          this.failedFiles++;
          state.failures.push(url);
          why = `${target.kind} model does not fit the item's size (${Math.round(check.distortion * 100)}% distortion > ${HARD_DIMS_LIMIT * 100}%)`;
          state.reason = `${why}; falling back`;
          if (target.kind === 'provider') {
            providerUsable = false;
            providerFailed = true;
          } else failedAssets.add(target.assetId!);
          continue;
        }
        rec.handle = handle;
        state.status = 'ready';
        state.source = target.kind;
        state.url = url;
        state.model = handle.value;
        state.front = front;
        state.reason = turned ? `${resolved.reason}; the model was turned a quarter turn because its long side runs along the other axis than the shop's width and depth` : resolved.reason;
        state.warning = check.mismatch ? { code: 'dims_mismatch', kind: target.kind, distortion: check.distortion, limit: check.limit } : undefined;
        if (providerFailed) this.scheduleRetry(item, rec);
        this.notify();
        return;
      } catch (error) {
        if (!this.current(item, rec)) return;
        this.failedFiles++;
        state.failures.push(url);
        why = `${target.kind} model failed (${error instanceof Error ? error.message : String(error)})`;
        state.reason = `${why}; falling back`;
        if (target.kind === 'provider') {
          providerUsable = false;
          providerFailed = true;
        } else failedAssets.add(target.assetId!);
      }
    }
    // Pathological resolver that keeps offering models: stop at a placeholder.
    state.status = 'settled';
    state.source = 'placeholder';
    state.reason = `no model could be loaded${state.failures.length ? ` (${state.failures.length} failed)` : ''}; a plain box at the exact size is drawn`;
    this.notify();
  }

  /** The URL for what the resolver picked, or why there is none. */
  private targetOf(
    r: ResolvedMesh,
    origin: string | null,
  ):
    | { url: string; kind: ModelKind; front: Front; assetId?: string; skip?: undefined; reason: string; offlineOnly?: undefined }
    | { url?: undefined; skip?: { kind: 'provider' } | { kind: 'lookalike'; assetId: string }; reason: string; offlineOnly?: boolean } {
    if (r.source === 'provider') {
      const url = origin && r.product ? providerModelUrl(origin, r.product) : undefined;
      if (!url) return { skip: { kind: 'provider' }, reason: 'provider model needs the local server', offlineOnly: false };
      return { url, kind: 'provider', front: '+z', reason: r.reason };
    }
    if (r.source === 'lookalike' && r.asset) {
      const asset: MeshAsset = r.asset;
      const url = libraryModelUrl(asset, origin, this.deps.base?.());
      if (!url) return { skip: { kind: 'lookalike', assetId: asset.id }, reason: `${asset.id} is not available here`, offlineOnly: asset.source === '3dfuture' };
      return { url, kind: 'lookalike', front: asset.front, assetId: asset.id, reason: r.reason };
    }
    return { reason: r.reason };
  }
}
