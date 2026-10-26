import type { Scene } from '../schema';
import { emptyMesh } from './builder';
import type { MeshData } from './types';

/** Frames and door leaves (opaque) and glass panes (transparent). (M1.5 — stub) */
export function buildFittings(_scene: Scene): { fittings: MeshData; glass: MeshData } {
  return { fittings: emptyMesh(), glass: emptyMesh() };
}
