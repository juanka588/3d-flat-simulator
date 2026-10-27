import { FIXTURES } from '../commands/testUtil';
import { parseScene } from '../parse';
import type { Item, Scene, SceneInput } from '../schema';

/** Charme 3205 without any placed item: robust against fixture items (placards, TV) other lanes add. */
export const BARE_CHARME: Scene = { ...FIXTURES.charme!, items: [] };

/** An item with the required fields; everything else overridable. */
export function mkItem(id: string, over: Partial<Item> = {}): Item {
  return { id, assetId: `param:test`, position: [0, 0], elevation: 0, rotation: 0, ...over } as Item;
}

export const withItems = (scene: Scene, items: Item[]): Scene => ({ ...scene, items: [...scene.items, ...items] });

/**
 * A 5 x 3 m room "r" (inner faces) with a west ENTRY door (opens outward, the flat has nothing beyond),
 * an east passage into room "s", and 0.1 m walls.
 */
export function corridorScene(): Scene {
  const input: SceneInput = {
    version: 1,
    name: 'corridor',
    site: { latitude: 0, longitude: 0 },
    walls: [
      { id: 'n', start: [-0.05, -0.05], end: [8.05, -0.05], thickness: 0.1 },
      { id: 's', start: [8.05, 3.05], end: [-0.05, 3.05], thickness: 0.1 },
      { id: 'w', start: [-0.05, -0.05], end: [-0.05, 3.05], thickness: 0.1 },
      { id: 'mid', start: [5.05, -0.05], end: [5.05, 3.05], thickness: 0.1 },
      { id: 'e', start: [8.05, -0.05], end: [8.05, 3.05], thickness: 0.1 },
    ],
    openings: [
      { id: 'd-in', wallId: 'w', type: 'door', offset: 1.5, width: 0.9, height: 2.04, hinge: 'start', swing: 'right' },
      { id: 'p-out', wallId: 'mid', type: 'passage', offset: 1.5, width: 1, height: 2.1 },
    ],
    rooms: [
      { id: 'r', name: 'Room', type: 'living', polygon: [[0, 0], [5, 0], [5, 3], [0, 3]] },
      { id: 'b', name: 'Next', type: 'living', polygon: [[5.1, 0], [8, 0], [8, 3], [5.1, 3]] },
    ],
  };
  const r = parseScene(input);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.scene;
}
