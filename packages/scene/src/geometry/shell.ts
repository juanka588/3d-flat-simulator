import { buildItems } from '../assets/build-items';
import type { Scene } from '../schema';
import { buildFittings } from './fittings';
import { buildCeilings, buildFloors } from './floors';
import type { MeshData, ShellMeshes } from './types';
import { buildWalls } from './walls';

/**
 * Builds every static mesh of a flat. Pure and deterministic; safe to run in node.
 * `opts.items` builds the item meshes; it defaults to today's `buildItems` (step A1), and becomes an empty mesh once the
 * item builders move out of scene (step A4), when callers pass `buildItems` themselves.
 */
export function buildShell(scene: Scene, opts: { items?: (s: Pick<Scene, 'items'>) => MeshData } = {}): ShellMeshes {
  return {
    walls: buildWalls(scene),
    floors: buildFloors(scene),
    ceilings: buildCeilings(scene),
    ...buildFittings(scene),
    items: (opts.items ?? buildItems)(scene),
  };
}
