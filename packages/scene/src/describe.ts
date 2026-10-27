import type { Scene } from './schema';
import type { RoomDescription, RoomSummary } from './mcp-types';
import type { LightingView } from './view';

/**
 * Pure read-model of the flat for the MCP read tools (M4.3, lane A). No clock, no I/O: the lighting
 * view (date) is passed in. Deterministic order: scene order for rooms, wall id then side for walls,
 * opening offset for openings.
 */

/** `list_rooms`: one cheap line per room, in scene order. */
export function listRooms(_scene: Scene): RoomSummary[] {
  throw new Error('not implemented');
}

/**
 * `describe_room`: area, the wall faces that border the room (structural flag, effective finish and
 * where it comes from, compass facing, shared faces), openings with compass direction, lights,
 * daylight factor and sunlight hours for `lighting.date`, items (always `[]` until M5).
 * Returns `undefined` for an unknown room (the tool maps that to `unknown_room` with
 * `nearestIds` in the hint).
 */
export function describeRoom(_scene: Scene, _roomId: string, _lighting: Pick<LightingView, 'date'> & Partial<LightingView>): RoomDescription | undefined {
  throw new Error('not implemented');
}
