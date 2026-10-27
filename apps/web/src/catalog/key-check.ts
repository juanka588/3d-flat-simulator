import { itemDims, itemMountOf } from '@flat/scene';
import type { Item, Scene } from '@flat/scene';
import { fullGhostCheck } from './ghost';
import type { GhostPose, GhostVerdict } from './ghost';
import { nudged } from './place';
import type { ItemKeyAction } from './place';

/** The pose an item would have after a key action (null for Delete: nothing to check). */
export function poseAfterKey(item: Pick<Item, 'position' | 'rotation' | 'elevation'>, action: ItemKeyAction): GhostPose | null {
  switch (action.kind) {
    case 'remove':
      return null;
    case 'rotate':
      return { position: item.position, rotation: (((item.rotation + action.deltaDeg) % 360) + 360) % 360, elevation: item.elevation };
    case 'nudge':
      return { position: nudged(item.position, action.dx, action.dy), rotation: item.rotation, elevation: item.elevation };
  }
}

/**
 * The verdict for a keyboard nudge or rotation, from the SAME full check the drag ghost uses (`ALL_RULES` plus the
 * walkway analysis). The command reducer only enforces the cheap rules, so without this an arrow key or R could
 * commit a pose the ghost would show red (a window, glazing clearance or a narrowed walkway). Null for Delete.
 * A key press that the check refuses is not applied: the caller shows the message instead.
 */
export function keyVerdict(scene: Scene, item: Item, action: ItemKeyAction): GhostVerdict | null {
  const pose = poseAfterKey(item, action);
  if (!pose) return null;
  return fullGhostCheck(scene, { id: item.id, dims: itemDims(item), mount: itemMountOf(item) }, pose, { assetId: item.assetId });
}
