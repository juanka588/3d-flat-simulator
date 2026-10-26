import type { Scene } from '../schema';
import { emptyMesh } from './builder';
import type { MeshData } from './types';

/** Wall solids with openings cut out and junctions resolved. (M1.2/M1.3 — stub) */
export function buildWalls(_scene: Scene): MeshData {
  return emptyMesh();
}
