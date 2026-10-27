import type { Scene } from '../schema';
import {
  checkInside,
  checkZones,
  itemsOverlapping,
  layoutContext,
  roomOfBox,
  violation,
  wallsOverlapping,
  type RoomInfo,
  type Subject,
} from './constraints';
import type { ItemBox } from './footprint';
import { walkwayVerdict } from './walkways';
import type { LayoutReport, Violation } from './types';

/**
 * Checks every placed item of `roomId` (or of all rooms) against the D7 rules that need no weight data:
 * inside the room (and under the ceiling), no overlap (walls, other items, height-aware), door swings and
 * landing, window sills, glazing, and the walkways. Locked items (existing furniture) are obstacles for
 * everyone else but are not judged themselves. A pair of overlapping items is reported once, on the item
 * that comes later in `scene.items` (or on the unlocked one of a pair). Pure and deterministic.
 */
export function validateLayout(scene: Scene, options: { roomId?: string } = {}): LayoutReport {
  const ctx = layoutContext(scene);
  let infos: RoomInfo[];
  if (options.roomId !== undefined) {
    const info = ctx.rooms.get(options.roomId);
    if (!info) {
      return {
        roomId: options.roomId,
        ok: false,
        violations: [violation('invalid_relation', `unknown room "${options.roomId}"`, [options.roomId], 'Use a room id from list_rooms.')],
        warnings: [],
        itemCount: 0,
      };
    }
    infos = [info];
  } else {
    infos = [...ctx.rooms.values()];
  }

  const violations: Violation[] = [];
  const warnings: Violation[] = [];
  let itemCount = 0;
  let minWalkway: number | undefined;
  let freeFloor: number | undefined;
  const wanted = new Set(infos.map((i) => i.room.id));
  const owner = new Map<ItemBox, RoomInfo | undefined>();
  for (const box of ctx.boxes) owner.set(box, roomOfBox(ctx, box));

  // items that belong to no room at all
  if (options.roomId === undefined) {
    for (const box of ctx.boxes) {
      if (owner.get(box) === undefined && !box.locked) {
        violations.push(violation('outside_room', `item "${box.id}" is not inside any room`, [box.id], 'Move it into a room (item_move).'));
        itemCount++;
      }
    }
  }

  for (const info of infos) {
    const mine = ctx.boxes.filter((b) => owner.get(b)?.room.id === info.room.id && wanted.has(info.room.id));
    itemCount += mine.length;
    for (const box of mine) {
      if (box.locked) continue;
      const s: Subject = { id: box.id, roomId: info.room.id, position: box.position, rotation: box.rotation, elevation: box.elevation, dims: box.dims, mount: box.mount };
      violations.push(...checkInside(ctx, s, box.footprint).map((v) => ({ ...v, entityIds: [box.id, ...v.entityIds] })));
      const walls = wallsOverlapping(ctx, box.footprint, box.bounds, box.bottom);
      const items = itemsOverlapping(ctx, box, box.id, (o) => o.locked || o.index < box.index);
      if (walls.length || items.length) {
        const parts = [...walls.map((w) => `wall "${w}"`), ...items.map((i) => `item "${i}"`)];
        violations.push(violation('overlap', `"${box.id}" overlaps ${parts.join(', ')}`, [box.id, ...walls, ...items]));
      }
      violations.push(...checkZones(ctx, s, box).map((v) => ({ ...v, entityIds: [box.id, ...v.entityIds] })));
    }
    const verdict = walkwayVerdict(ctx, info, { baselineSkip: (b) => !b.locked });
    if (verdict.minWidthM !== undefined) minWalkway = minWalkway === undefined ? verdict.minWidthM : Math.min(minWalkway, verdict.minWidthM);
    freeFloor = (freeFloor ?? 0) + verdict.freeAreaM2;
    if (verdict.violation && mine.some((b) => !b.locked)) violations.push(verdict.violation);
  }

  return {
    ...(options.roomId !== undefined ? { roomId: options.roomId } : {}),
    ok: violations.length === 0,
    violations,
    warnings,
    itemCount,
    ...(minWalkway !== undefined ? { minWalkwayM: minWalkway } : {}),
    ...(freeFloor !== undefined ? { freeFloorM2: Math.round(freeFloor * 100) / 100 } : {}),
  };
}
