// Temporary shim (step A5a): the model cache lives in `@flat/assets` (cache/model-cache.ts). V8 removes this file.
export { MAX_MODELS, MAX_MODEL_BYTES, createModelCache } from '@flat/assets';
export type { Loaded, ModelCache, ModelCacheOptions, ModelCacheStats, ModelHandle } from '@flat/assets';
