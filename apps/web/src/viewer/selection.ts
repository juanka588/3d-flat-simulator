import { wallLength, wallSideRooms } from '@flat/scene';
import type { Scene } from '@flat/scene';
import type { Selection } from './view-types';

const ZONE_PREFIX = 'zone:';

/** `zone:<roomId>/<zoneId>` of a floor zone selection (the id `__flat.select` and the UI use). */
export const zoneSelectionId = (roomId: string, zoneId: string): string => `${ZONE_PREFIX}${roomId}/${zoneId}`;

/** Room and zone id of a `zone:<roomId>/<zoneId>` id (the zone id is everything after the first slash). */
function splitZoneId(id: string): [string, string] | null {
  const rest = id.slice(ZONE_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash > 0 && slash < rest.length - 1 ? [rest.slice(0, slash), rest.slice(slash + 1)] : null;
}

/** Resolves a scene entity id (wall, opening, item or room) to a selection; null for unpickable ids. */
export function selectionForId(scene: Scene, id: string): Selection | null {
  // A floor zone is `zone:<roomId>/<zoneId>`; it selects the room's floor restricted to that zone.
  if (id.startsWith(ZONE_PREFIX)) {
    const [roomId, zoneId] = splitZoneId(id) ?? [];
    return roomId && zoneId && scene.rooms.find((r) => r.id === roomId)?.floorZones?.some((z) => z.id === zoneId) ? { kind: 'floor', entityId: roomId, zoneId } : null;
  }
  if (scene.walls.some((w) => w.id === id)) return { kind: 'wall', entityId: id };
  if (scene.openings.some((o) => o.id === id)) return { kind: 'opening', entityId: id };
  if (scene.items.some((i) => i.id === id)) return { kind: 'item', entityId: id };
  if (scene.rooms.some((r) => r.id === id)) return { kind: 'floor', entityId: id };
  return null;
}

/** Rooms on the two faces of a wall at `along` metres from its start (the stretch containing it, else the nearest). */
export function wallRoomsAt(scene: Scene, wallId: string, along: number): { left?: string; right?: string } {
  const segments = wallSideRooms(scene)[wallId]?.segments ?? [];
  let best: (typeof segments)[number] | undefined;
  let bestDist = Infinity;
  for (const seg of segments) {
    const dist = along < seg.from ? seg.from - along : along > seg.to ? along - seg.to : 0;
    if (dist < bestDist) {
      best = seg;
      bestDist = dist;
    }
  }
  return { ...(best?.left ? { left: best.left } : {}), ...(best?.right ? { right: best.right } : {}) };
}

/**
 * A wall-face click with its context: the room on the clicked face at the hit point (plan x, plan y),
 * so a finish can be scoped to that room's stretch of a wall shared by several rooms.
 * Other selections, and wall hits that are not a left/right face, pass through unchanged.
 */
export function withHitContext(scene: Scene, selection: Selection, planPoint: [number, number] | null): Selection {
  if (selection.kind !== 'wall' || (selection.face !== 'left' && selection.face !== 'right') || !planPoint) return selection;
  const wall = scene.walls.find((w) => w.id === selection.entityId);
  const len = wall ? wallLength(wall) : 0;
  if (!wall || len < 1e-9) return selection;
  const dx = (wall.end[0] - wall.start[0]) / len;
  const dy = (wall.end[1] - wall.start[1]) / len;
  const along = Math.min(len, Math.max(0, (planPoint[0] - wall.start[0]) * dx + (planPoint[1] - wall.start[1]) * dy));
  const roomId = wallRoomsAt(scene, wall.id, along)[selection.face];
  return { ...selection, along, ...(roomId ? { roomId } : {}) };
}

/** What `__flat.select` accepts besides an id: a wall face, optionally in one room (the stretch of that room is clicked). */
export interface WallFaceTarget {
  wallId: string;
  side: 'left' | 'right';
  roomId?: string;
}

/** Selection for a wall face as if clicked inside `roomId` (mid-stretch), or at mid-wall without a room. */
export function selectionForWallFace(scene: Scene, target: WallFaceTarget): Selection | null {
  const wall = scene.walls.find((w) => w.id === target.wallId);
  if (!wall) return null;
  const segments = wallSideRooms(scene)[wall.id]?.segments ?? [];
  const mine = target.roomId ? segments.filter((s) => s[target.side] === target.roomId) : [];
  if (target.roomId && mine.length === 0) return null;
  const seg = mine.reduce<(typeof mine)[number] | undefined>((a, b) => (!a || b.to - b.from > a.to - a.from ? b : a), undefined);
  const along = seg ? (seg.from + seg.to) / 2 : wallLength(wall) / 2;
  return { kind: 'wall', entityId: wall.id, face: target.side, along, ...(target.roomId ? { roomId: target.roomId } : {}) };
}
