import { isStructural } from '../structural';
import type { Scene } from '../schema';
import { err, unknownIdHint, type CommandError } from './util';

export type GuardResult = { ok: true } | ({ ok: false } & CommandError);

function guard(scene: Scene, wallId: string, action: string): GuardResult {
  const wall = scene.walls.find((w) => w.id === wallId);
  if (!wall) {
    return { ok: false, ...err('unknown_entity', 'wallId', `unknown wall "${wallId}"`, unknownIdHint(wallId, scene.walls.map((w) => w.id), 'wall')) };
  }
  if (isStructural(scene, wall)) {
    return { ok: false, ...err('precondition_failed', 'wallId', `wall "${wallId}" is structural and cannot ${action}`, 'structural wall') };
  }
  return { ok: true };
}

/**
 * Reserved rule for the future `wall.remove` command (M6): structural walls can never be removed.
 * Returns `{ok:false, code:'precondition_failed', hint:'structural wall'}` for them.
 */
export function canRemoveWall(scene: Scene, wallId: string): GuardResult {
  return guard(scene, wallId, 'be removed');
}

/** Reserved rule for the future `opening.add` command: no new openings in structural walls. */
export function canCutOpening(scene: Scene, wallId: string): GuardResult {
  return guard(scene, wallId, 'be cut by a new opening');
}
