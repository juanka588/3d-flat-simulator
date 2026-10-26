import { buildItems } from '../assets/builtin';
import type { Scene } from '../schema';
import { buildFittings } from './fittings';
import { buildCeilings, buildFloors } from './floors';
import type { ShellMeshes } from './types';
import { buildWalls } from './walls';

/** Builds every static mesh of a flat. Pure and deterministic; safe to run in node. */
export function buildShell(scene: Scene): ShellMeshes {
  return {
    walls: buildWalls(scene),
    floors: buildFloors(scene),
    ceilings: buildCeilings(scene),
    ...buildFittings(scene),
    items: buildItems(scene),
  };
}
