import type { Scene } from '@flat/scene';
import type { Selection } from './view-types';

/** Resolves a scene entity id (wall, opening or room) to a selection; null for unpickable ids. */
export function selectionForId(scene: Scene, id: string): Selection | null {
  if (scene.walls.some((w) => w.id === id)) return { kind: 'wall', entityId: id };
  if (scene.openings.some((o) => o.id === id)) return { kind: 'opening', entityId: id };
  if (scene.rooms.some((r) => r.id === id)) return { kind: 'floor', entityId: id };
  return null;
}
