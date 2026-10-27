import type { ModelKind } from './model-math';

// Plain types shared by the model controller and the test hook (no runtime imports: the e2e type-check reads this file).

/** Where an item's shape came from, as reported by `modelStats()`. Legacy `builtin:*` items count as `parametric`. */
export type ModelSource = 'provider' | 'lookalike' | 'parametric' | 'placeholder';

export interface DimsWarning {
  code: 'dims_mismatch';
  kind: ModelKind;
  /** Aspect distortion that scaling the model to the item's dims would cause (see `scaleDistortion`). */
  distortion: number;
  limit: number;
}

export interface ModelStats {
  /** Items drawn from a loaded model. */
  loaded: number;
  /** Items whose model is still loading. */
  pending: number;
  /** Model files that failed to load (each moved an item down the chain). */
  failed: number;
  /** Final source per item (`placeholder` while loading). */
  sources: Record<string, ModelSource>;
  /** Items that want a provider / local-only model but there is no server. */
  offline: string[];
  warnings: { itemId: string; warning: DimsWarning }[];
  /** Every model URL actually fetched so far (a cached or shared model is fetched once). */
  requests: string[];
  cache: { models: number; inUse: number; bytes: number; evictions: number };
}
