import { emptyMesh } from '../geometry/builder';
import type { MeshData } from '../geometry/types';
import type { SiteContext } from './schema';

/** Extruded context buildings plus a ground plane; owners `{kind:'context', entityId}`. (M2.11 — stub) */
export function buildContextMeshes(_context: SiteContext): MeshData {
  return emptyMesh();
}
