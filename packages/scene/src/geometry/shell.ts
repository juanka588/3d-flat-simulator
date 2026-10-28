import type { Scene } from '../schema';
import { emptyMesh } from './builder';
import { buildFittings } from './fittings';
import { buildCeilings, buildFloors } from './floors';
import type { MeshData, ShellMeshes } from './types';
import { buildWalls } from './walls';

/**
 * Builds every static mesh of a flat. Pure and deterministic; safe to run in node.
 * `opts.items` builds the item meshes; it defaults to an empty mesh because the item builders live in @flat/assets
 * (step A4): callers that want items pass `buildItems` from there.
 */
export function buildShell(scene: Scene, opts: { items?: (s: Pick<Scene, 'items'>) => MeshData } = {}): ShellMeshes {
  return {
    walls: buildWalls(scene),
    floors: buildFloors(scene),
    ceilings: buildCeilings(scene),
    ...buildFittings(scene),
    items: (opts.items ?? emptyMesh)(scene),
  };
}
