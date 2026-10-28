import type { Item, Vec2 } from '../schema';
import { BUILTIN_ASSETS } from './builtin-assets';

/**
 * Minimal built-in assets: a precursor of the M5 furniture catalog, used to give the flat a
 * sense of scale (a 55" TV) without any asset loading.
 *
 * ITEM-LOCAL FRAME (right-handed, metres), matching the world mapping of the scene format:
 * - origin: centre of the item's footprint, at its lowest point (`dims.h` is measured up from it);
 * - +x: the item's right as seen from the front (width `w` spans x in [-w/2, w/2]);
 * - +y: up (height `h` spans y in [0, h]); the item's bottom sits at `Item.elevation`;
 * - +z: the FRONT. The front face is at z = +d/2 and the back (the wall side of a wall-mounted
 *   item) at z = -d/2 (depth `d` spans z in [-d/2, d/2]).
 *
 * Placement: `Item.position` is the plan `[x, y]` of the origin, `Item.rotation` turns the item
 * about the vertical axis, degrees counter-clockwise seen from above (= three.js `rotation.y`).
 * With world X = plan x and Z = plan y, local +z maps to the plan direction
 * `[sin(rotation), cos(rotation)]`, so at rotation 0 the front faces plan +y ("down the page",
 * south on the blueprint), at 90 it faces plan +x, at 180 plan -y and at 270 plan -x.
 * Example: a TV hung on the south face (y = f) of a partition at rotation 0 has
 * `position.y = f + d/2`.
 *
 * COLLISION: items are not walking obstacles yet. When they become so, a wall-mounted item
 * whose bottom is above `WALK_CLEARANCE_M` does not block walking (see `itemBlocksWalking`).
 */

/** Edge length of the placeholder box drawn for unknown assets, in metres. */
export const PLACEHOLDER_SIZE_M = 0.3;
/** Items whose bottom is above this height (m) and that hang on a wall do not block walking. */
export const WALK_CLEARANCE_M = 0.6;

/** Plan direction (unit vector `[x, y]`) the front of the item faces; see the frame above. */
export function itemFrontDirection(item: Pick<Item, 'rotation'>): Vec2 {
  const r = (item.rotation * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
}

/** Whether an item is an obstacle when walking (reserved for when items join the collision set). */
export function itemBlocksWalking(item: Pick<Item, 'assetId' | 'elevation'>): boolean {
  const asset = BUILTIN_ASSETS[item.assetId];
  if (asset?.mount === 'wall' && item.elevation > WALK_CLEARANCE_M) return false;
  return true;
}

/** Human-readable label such as `TV 55″ – 1.23 × 0.71 m` (width x height). */
export function itemLabel(item: Pick<Item, 'assetId'>): string {
  const asset = BUILTIN_ASSETS[item.assetId];
  if (!asset) return `Unknown asset (${item.assetId})`;
  return `${asset.name} – ${asset.dims.w.toFixed(2)} × ${asset.dims.h.toFixed(2)} m`;
}
