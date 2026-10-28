import { MEMORY_CACHE_ENTRY_BYTES, MEMORY_CACHE_TOTAL_BYTES } from '@flat/assets';

// The cache itself lives in `@flat/assets` (generic LRU + TTL with an injected clock). This file keeps the server's
// policy: the TTLs and the caps of D3.
export { MemoryCache } from '@flat/assets';
export type { MemoryCacheOptions } from '@flat/assets';

/** TTLs and caps of D3. */
export const TTL_SEARCH_MS = 60 * 60_000;
export const TTL_PRODUCT_MS = 24 * 60 * 60_000;
/** Models stay for the server's lifetime (memory only, never on disk); the 200 MB LRU bounds them. */
export const TTL_MODEL_MS = Infinity;
export const CACHE_TOTAL_BYTES = MEMORY_CACHE_TOTAL_BYTES;
export const CACHE_ENTRY_BYTES = MEMORY_CACHE_ENTRY_BYTES;
