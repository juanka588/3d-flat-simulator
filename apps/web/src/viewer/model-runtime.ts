import { resolveMesh } from '@flat/scene';
import type { Item } from '@flat/scene';
import { ModelController } from './model-controller';
import type { ControllerDeps, ModelStats } from './model-controller';
import { createModelCache } from './model-cache';
import { createCatalogLoader, modelOrigin, modelsBase } from './model-env';
import type { ModelTemplate } from './model-loader';
import type { Front } from './model-math';

/** The app-wide model cache (like the texture cache): 24 models / about 64 MB, idle ones evicted least recently used first. */
export const modelCache = createModelCache<ModelTemplate>({
  dispose: (t) => t.dispose(),
  restore: (t) => t.restore(),
});

const catalog = createCatalogLoader();

let resolverOverride: ControllerDeps<ModelTemplate>['resolve'] | null = null;
let providerFront: ((item: Item) => Front | undefined) | undefined;

/** Test hook: replaces `resolveMesh` for the viewer (null restores it). */
export function setMeshResolverOverride(fn: ControllerDeps<ModelTemplate>['resolve'] | null): void {
  resolverOverride = fn;
}

/**
 * Per-item override of the front axis of provider models, which are assumed to face +z (retailer models
 * have no declared front). Return undefined to keep the default.
 */
export function setProviderFrontOverride(fn: ((item: Item) => Front | undefined) | undefined): void {
  providerFront = fn;
}

export function createViewerModelController(): ModelController<ModelTemplate> {
  return new ModelController<ModelTemplate>({
    cache: modelCache,
    // The loader (GLTFLoader, decoders) is a lazy chunk: a flat without models never downloads it.
    load: async (url) => (await import('./model-loader')).loadGlb(url),
    resolve: (item, ctx) => (resolverOverride ?? resolveMesh)(item, ctx),
    catalog,
    origin: modelOrigin,
    base: modelsBase,
    providerFront: (item) => providerFront?.(item),
  });
}

let active: ModelController<ModelTemplate> | null = null;

/** The controller of the mounted viewer (for the test hook), or null. */
export function setActiveModelController(c: ModelController<ModelTemplate> | null): void {
  active = c;
}
export function activeModelController(): ModelController<ModelTemplate> | null {
  return active;
}

const NO_STATS: ModelStats = { loaded: 0, pending: 0, failed: 0, sources: {}, offline: [], warnings: [], requests: [], cache: { models: 0, inUse: 0, bytes: 0, evictions: 0 } };

export function modelStats(): ModelStats {
  return active?.stats() ?? NO_STATS;
}

/** Resolves when no item is waiting for a model. */
export function modelsSettled(): Promise<void> {
  return active?.settled() ?? Promise.resolve();
}
