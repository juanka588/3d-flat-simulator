import type { Room, Scene, Wall } from '../schema';
import { BUILTIN_MATERIALS } from './types';

/** Material id for one side of a wall: its own finish, else the scene default, else a builtin. */
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
