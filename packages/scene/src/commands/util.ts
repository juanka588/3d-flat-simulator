import type { Violation } from '../placement/types';

/**
 * - `invalid_command`: the envelope or command is malformed (unknown type, bad field, too long).
 * - `unknown_entity` / `unknown_material`: an id does not exist; the hint lists the nearest ids.
 * - `limit_exceeded`: a collection would exceed its `LIMITS` bound.
 * - `precondition_failed`: valid command, but the scene state or the author forbids it (stale
 *   `ifRev`, material still in use, room does not border the wall side, structural wall rules).
 * - `not_supported`: a command reserved for a later milestone.
 * - `scene_invalid`: the result would not be a valid scene.
 * - `placement_invalid`: an item command would put the item outside its room, over a wall or another item, or in
 *   a door swing; `violation` says which rule and `hint` what to try.
 * - `no_wall_sides`: `room.setWallFinish` on a room none of whose edges run along a wall face
 *   (an unwalled room); there is nothing to paint. Paint the floor/ceiling instead, or fix the room
 *   polygon so its edges follow wall faces.
 */
export type ErrorCode =
  | 'invalid_command'
  | 'unknown_entity'
  | 'unknown_material'
  | 'limit_exceeded'
  | 'precondition_failed'
  | 'not_supported'
  | 'scene_invalid'
  | 'no_wall_sides'
  | 'placement_invalid';

export interface CommandError {
  code: ErrorCode;
  /** Slash-separated location, e.g. `cmd/commands/2/materialId` (parse) or `commands/2/materialId` (apply). */
  path: string;
  message: string;
  hint?: string;
  /** `placement_invalid`: the broken placement rule. */
  violation?: Violation;
}

export function err(code: ErrorCode, path: string, message: string, hint?: string): CommandError {
  return hint === undefined ? { code, path, message } : { code, path, message, hint };
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Up to `n` candidates closest to `id` (substring matches first, then edit distance). */
export function nearestIds(id: string, candidates: readonly string[], n = 3): string[] {
  const lower = id.toLowerCase();
  return [...candidates]
    .map((c) => {
      const cl = c.toLowerCase();
      const sub = cl.includes(lower) || lower.includes(cl) ? -1000 : 0;
      return { c, score: sub + distance(lower, cl) };
    })
    .sort((a, b) => a.score - b.score || (a.c < b.c ? -1 : 1))
    .slice(0, n)
    .map((x) => x.c);
}

export function unknownIdHint(id: string, candidates: readonly string[], kind: string): string {
  if (candidates.length === 0) return `the scene has no ${kind}s`;
  const near = nearestIds(id, candidates);
  return `did you mean ${near.map((x) => `"${x}"`).join(', ')}? (${candidates.length} ${kind}s in scene)`;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
