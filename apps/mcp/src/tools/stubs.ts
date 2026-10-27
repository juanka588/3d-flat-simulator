import { RenderSpec } from '@flat/scene';
import { z } from 'zod';
import { toolError } from '../errors';
import type { ToolAnnotationsDef, ToolDef, ToolGroup } from './registry';

/**
 * Placeholders for the read, view, history and render tools. They are LISTED with their final names
 * and argument schemas (the tools/list snapshot is the contract) and answer `not_implemented`.
 * Each lane replaces its stubs in place: keep `name` and `inputSchema` unless the contract changes
 * (then update the snapshot on purpose).
 *
 *   read:    get_scene_summary, list_rooms, describe_room, list_materials     (lane D, M4.4; pure parts: lane A)
 *   view:    set_sun_time, render_view                                        (lane D M4.11, lane E M4.10)
 *   history: list_history, undo, redo, checkpoint, restore_checkpoint         (lane D, M4.7)
 */

const READ: ToolAnnotationsDef = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const HISTORY_WRITE: ToolAnnotationsDef = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const roomId = { type: 'string', description: 'Room id (see list_rooms).' };
const date = { type: 'string', description: 'Local date YYYY-MM-DD at the flat.' };

function stub(name: string, group: ToolGroup, description: string, inputSchema: Record<string, unknown>, annotations: ToolAnnotationsDef, mutatesScene = false): ToolDef {
  return {
    name,
    description,
    inputSchema,
    group,
    mutatesScene,
    annotations,
    handler: async () => toolError('not_implemented', `${name} is not implemented yet in this build`),
  };
}

/** Portable JSON Schema for `render_view` derived from `RenderSpec` (no explicit pose, no preview hook: those are internal). */
function renderViewSchema(): Record<string, unknown> {
  const raw = z.toJSONSchema(RenderSpec.omit({ pose: true, previewOf: true }), { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = raw;
  void _drop;
  return rest;
}

export function stubTools(): ToolDef[] {
  return [
    stub('get_scene_summary', 'read', 'Overview of the flat: name, rev, rooms (id, name, area), materials in use, defaults, site, lights count, history position. Start here.', obj({}), READ),
    stub('list_rooms', 'read', 'List the rooms: id, name, type, area, finishes, counts of windows, doors and lights.', obj({}), READ),
    stub('describe_room', 'read', 'Describe one room: area, walls facing it (structural flag, finish, compass facing), openings with compass direction, lights, daylight factor, sunlight hours for a date.', obj({ roomId, date }, ['roomId']), READ),
    stub('list_materials', 'read', 'List the material library and the flat\'s own materials (ids, names, colours, texture slugs).', obj({}), READ),
    stub('set_sun_time', 'view', 'Set the session\'s date, time or lighting preset used by later renders (does not change the flat).', obj({ date, time: { type: 'string', description: 'Local time HH:mm.' }, preset: { type: 'string', enum: ['day', 'evening', 'night'] } }), { ...READ, idempotentHint: true }),
    stub('render_view', 'render', 'Render the flat to an image to verify a change: a room overview, a walk-through view, a plan or an orbit view, with chosen date, time or lamps.', renderViewSchema(), READ),
    stub('list_history', 'history', 'List the undo and redo stacks (who changed what, newest last) and the named checkpoints. The stack is shared with the user.', obj({}), READ),
    stub('undo', 'history', 'Undo the latest change in the shared history, whoever made it.', obj({}), HISTORY_WRITE, true),
    stub('redo', 'history', 'Redo the most recently undone change.', obj({}), HISTORY_WRITE, true),
    stub('checkpoint', 'history', 'Name the current state so you can return to it with restore_checkpoint.', obj({ name: { type: 'string', minLength: 1, maxLength: 80, description: 'Checkpoint name.' } }, ['name']), HISTORY_WRITE),
    stub('restore_checkpoint', 'history', 'Undo back to a named checkpoint (the undone steps stay redoable).', obj({ name: { type: 'string', minLength: 1, maxLength: 80, description: 'Checkpoint name.' } }, ['name']), HISTORY_WRITE, true),
  ];
}
