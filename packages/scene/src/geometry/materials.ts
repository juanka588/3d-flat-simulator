import type { Room, Scene, Wall } from '../schema';
import { BUILTIN_MATERIALS } from './types';

/**
 * Room-agnostic material id for one side of a wall: its own finish, else the scene default, else
 * a builtin. Kept for back-compat; it ignores `Room.wallFinish`. Prefer `wallFaceMaterial`.
 */
export function wallSideMaterial(scene: Pick<Scene, 'defaults'>, wall: Wall, side: 'left' | 'right'): string {
  return wall.finish[side] ?? scene.defaults.wall ?? BUILTIN_MATERIALS.fallbackWall;
}

/** Material for wall tops, ends and jambs (no side applies): the scene default wall material. */
export function wallEdgeMaterial(scene: Pick<Scene, 'defaults'>): string {
  return scene.defaults.wall ?? BUILTIN_MATERIALS.fallbackWall;
}

export function floorMaterial(scene: Pick<Scene, 'defaults'>, room: Room): string {
  return room.floorMaterial ?? scene.defaults.floor ?? BUILTIN_MATERIALS.fallbackFloor;
}

export function ceilingMaterial(scene: Pick<Scene, 'defaults'>, room: Room): string {
  return room.ceilingMaterial ?? scene.defaults.ceiling ?? BUILTIN_MATERIALS.fallbackCeiling;
}

/** Room-scoped finish of one side of a wall (`Wall.roomFinishes`), if any. */
export function roomSideFinish(wall: Pick<Wall, 'roomFinishes'>, roomId: string | undefined, side: 'left' | 'right'): string | undefined {
  if (roomId === undefined || !wall.roomFinishes || !Object.hasOwn(wall.roomFinishes, roomId)) return undefined;
  return wall.roomFinishes[roomId]![side];
}

/**
 * Material of a stretch of wall face seen from `roomId`. Highest priority first:
 *  1. `wall.roomFinishes[roomId][side]` (that room's own paint on this wall);
 *  2. `wall.finish[side]` (legacy whole-side finish, shows in every room on that side);
 *  3. `room.wallFinish` (paint-all-walls of the room on that face);
 *  4. `scene.defaults.wall`;
 *  5. a builtin.
 * A whole-side finish beats the room's paint-all-walls so that painting one wall after the room
 * keeps working; `room.setWallFinish` clears the room's explicit finishes so that the room paint
 * wins when applied after.
 */
export function wallFaceMaterial(
  scene: Pick<Scene, 'defaults' | 'rooms'>,
  wall: Wall,
  side: 'left' | 'right',
  roomId: string | undefined,
): string {
  const room = roomId === undefined ? undefined : scene.rooms.find((r) => r.id === roomId);
  return roomSideFinish(wall, roomId, side) ?? wall.finish[side] ?? room?.wallFinish ?? scene.defaults.wall ?? BUILTIN_MATERIALS.fallbackWall;
}
