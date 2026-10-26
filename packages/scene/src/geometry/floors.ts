import type { Scene } from '../schema';
import { emptyMesh } from './builder';
import type { MeshData } from './types';

/** Floor per room, facing up at y = 0. (M1.4 — stub) */
export function buildFloors(_scene: Scene): MeshData {
  return emptyMesh();
}

/** Ceiling per room, facing down at the room's ceiling height. (M1.4 — stub) */
export function buildCeilings(_scene: Scene): MeshData {
  return emptyMesh();
}
