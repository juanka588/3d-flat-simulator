import type { Scene } from './schema';
import type { SceneDiff } from './mcp-types';

/**
 * Structural diff of two scenes (M4.3, lane A), used for `preview` results, write summaries and
 * `compare`. Deterministic (entities sorted by kind then id; fields sorted), `diffScenes(a, a)` has
 * no changes, and applying a command to `a` to get `b` yields the same diff whether `b` came from a
 * preview or from the committed scene. Covers materials, walls (incl. finish / roomFinishes /
 * structural), openings, rooms, items, lights, site and defaults.
 */
export function diffScenes(_before: Scene, _after: Scene): SceneDiff {
  throw new Error('not implemented');
}
