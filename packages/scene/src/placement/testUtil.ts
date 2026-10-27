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

/**
 * Three rooms in a row, "a" (west), "r" (a 5 x 3 m room, the one measured) and "b" (east), joined by two PASSAGES
 * (no entry door, so the minimum walkway is 0.8 m) `opening` wide, centred at y = `westY` on the west wall and
 * `eastY` on the east wall of "r".
 */
export function channelScene(westY = 1.5, eastY = 1.5, opening = 1): Scene {
  const input: SceneInput = {
    version: 1,
    name: 'channel',
    site: { latitude: 0, longitude: 0 },
    walls: [
      { id: 'n', start: [-2.15, -0.05], end: [7.15, -0.05], thickness: 0.1 },
      { id: 's', start: [7.15, 3.05], end: [-2.15, 3.05], thickness: 0.1 },
      { id: 'ww', start: [-2.15, -0.05], end: [-2.15, 3.05], thickness: 0.1 },
      { id: 'wa', start: [-0.05, -0.05], end: [-0.05, 3.05], thickness: 0.1 },
      { id: 'wb', start: [5.05, -0.05], end: [5.05, 3.05], thickness: 0.1 },
      { id: 'we', start: [7.15, -0.05], end: [7.15, 3.05], thickness: 0.1 },
    ],
    openings: [
      { id: 'p-west', wallId: 'wa', type: 'passage', offset: westY + 0.05, width: opening, height: 2.1 },
      { id: 'p-east', wallId: 'wb', type: 'passage', offset: eastY + 0.05, width: opening, height: 2.1 },
    ],
    rooms: [
      { id: 'a', name: 'West', type: 'living', polygon: [[-2.1, 0], [0, 0], [0, 3], [-2.1, 3]] },
      { id: 'r', name: 'Room', type: 'living', polygon: [[0, 0], [5, 0], [5, 3], [0, 3]] },
      { id: 'b', name: 'East', type: 'living', polygon: [[5.1, 0], [7.1, 0], [7.1, 3], [5.1, 3]] },
    ],
  };
  const r = parseScene(input);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.scene;
}

/**
 * Two huge boxes that leave a straight channel `gap` wide between the access points of the two passages of
 * `channelScene(westY, eastY)`; `shift` slides the channel sideways (to try every raster phase).
 */
export function channelItems(westY: number, eastY: number, gap: number, shift = 0): Item[] {
  const from: [number, number] = [0.45, westY];
  const to: [number, number] = [4.55, eastY];
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const rotation = (((Math.atan2(-(to[1] - from[1]), to[0] - from[0]) * 180) / Math.PI) + 360) % 360;
  const r = (rotation * Math.PI) / 180;
  const n: [number, number] = [Math.sin(r), Math.cos(r)];
  const mid: [number, number] = [(from[0] + to[0]) / 2 + n[0] * shift, (from[1] + to[1]) / 2 + n[1] * shift];
  void len;
  const half = gap / 2 + 3;
  const box = (id: string, sign: number): Item =>
    mkItem(id, { position: [mid[0] + sign * n[0] * half, mid[1] + sign * n[1] * half], rotation, roomId: 'r', dims: { w: 14, d: 6, h: 0.8 } });
  return [box('box-a', -1), box('box-b', 1)];
}
