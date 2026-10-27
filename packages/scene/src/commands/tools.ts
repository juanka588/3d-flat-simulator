import { z } from 'zod';
import { COMMAND_TYPES, LEAF_SCHEMA_BY_TYPE, Batch } from './schema';

/**
 * LLM tool schemas for the command layer (the M4 MCP contract): one tool per leaf command plus
 * `batch`. They are an outward-facing VIEW of the zod command schemas; `parseCommand` stays the
 * single validator. A tool call `{name, arguments}` becomes a command with `toolCallToCommand`.
 *
 * Shape decisions (chosen for Anthropic tool use and OpenAI function calling):
 *  - the root is always `type: 'object'` with `properties`, `required` and `additionalProperties: false`;
 *    there is no `oneOf` / `anyOf` / `prefixItems` at the root;
 *  - the command `type` discriminator is NOT a parameter of the leaf tools (the tool name carries it);
 *    inside `batch` the items are full commands, referenced as `{$ref: '#/$defs/<tool name>'}`;
 *  - nullable fields are written as `{ "type": ["string", "null"] }` (not `anyOf`): both providers accept
 *    it and it is the shortest form; the description of every such field says what `null` means
 *    ("clear to default"). OpenAI strict mode additionally wants every property listed in `required`;
 *    an adapter can do that by widening the type to nullable, since `null` already means "unset" here;
 *  - 2D points are `{type: 'array', items: {type: 'number'}, minItems: 2, maxItems: 2}` (no `prefixItems`);
 *  - nested unions (the `light` of `light_add`) use `anyOf` (never `oneOf`), which both providers support;
 *  - internal `index` fields (insert positions used by undo) are hidden.
 */
export interface CommandToolSchema {
  /** MCP tool name, e.g. `wall_set_finish`. */
  name: string;
  /** Command type the tool maps to, e.g. `wall.setFinish`. */
  commandType: string;
  description: string;
  /** JSON Schema of the tool arguments. */
  inputSchema: Record<string, unknown>;
  /** A valid argument object, for docs and tests. */
  example: Record<string, unknown>;
}

const DESCRIPTIONS: Record<string, { description: string; example: Record<string, unknown> }> = {
  'material.define': {
    description:
      'Create a material, or fully replace an existing one with the same id (upsert, FULL REPLACE: omitted optional fields are cleared and roughness resets to 0.9, so send every field you want to keep). ' +
      'A material kind ("paint" or "texture") can never change; use a new id for a different kind. For a library texture use kind "texture" with textureUrl "lib:<slug>" (slugs: library[].slug from list_materials). Define a material before using it in a finish.',
    example: { material: { id: 'paint-sage', name: 'Sage green', kind: 'paint', color: '#9caf88', roughness: 0.9 } },
  },
  'material.remove': {
    description: 'Delete a material. Fails with precondition_failed (naming the users) while a wall, a room (floor, ceiling or wall finish) or a default still uses it; reassign those first.',
    example: { id: 'paint-sage' },
  },
  'wall.setFinish': {
    description:
      'Paint one or both faces of a wall (wall ids: walls[].wallId from describe_room, which also says which side faces the room). Pass roomId (strongly recommended) to paint only that room\'s stretch of the face: the alcove and the sejour can share a wall and get different colours. ' +
      'Without roomId the whole face is painted for every room on it. Precedence on a stretch of face, most specific first: the room-scoped finish (roomId), the whole-face finish, the room\'s paint-all-walls (room_set_wall_finish), the scene default. ' +
      'Left and right follow the walking direction from wall start to end on the plan (plan y grows down). materialId null clears the finish.',
    example: { wallId: 'w-west', side: 'right', materialId: 'paint-sage', roomId: 'sejour' },
  },
  'wall.setStructural': {
    description:
      'Mark a wall structural (never removable) or removable, or clear the mark. Walls that are exterior or at least 15 cm thick are structural by default; only a user may mark such a wall removable (an LLM gets precondition_failed).',
    example: { wallId: 'w-alcove', structural: true },
  },
  'room.setWallFinish': {
    description:
      'Paint all the walls of a room with one material (the room\'s own stretches only: neighbouring rooms keep their look, even on shared wall faces). It replaces any earlier per-wall paint of that room; a later wall_set_finish on one of its walls wins again. ' +
      'materialId null removes the room paint. Fails with no_wall_sides when none of the room\'s edges run along a wall face (an unwalled room).',
    example: { roomId: 'sejour', materialId: 'paint-sage' },
  },
  'room.setFloor': { description: 'Set the floor material of a room (null clears it so the scene default applies).', example: { roomId: 'sejour', materialId: 'floor-oak' } },
  'room.setCeiling': { description: 'Set the ceiling material of a room (null clears it so the scene default applies).', example: { roomId: 'sejour', materialId: 'ceiling-white' } },
  'scene.setDefaults': {
    description: 'Set the scene-wide default materials used where a wall face, floor or ceiling has none. Omitted fields stay unchanged; null clears one.',
    example: { wall: 'paint-white', floor: null },
  },
  'site.set': {
    description: 'Change site fields (location, orientation, time zone, floor elevation, address). Omitted fields stay unchanged; address null clears it.',
    example: { site: { northAngle: 35, timezone: 'Europe/Paris' } },
  },
  'light.add': {
    description: 'Add a light (point, spot or area). The id is derived (light-N) when omitted.',
    example: { light: { type: 'point', position: [2.5, 1.8], elevation: 2.4, lumens: 800, kelvin: 2700, on: true } },
  },
  'light.update': {
    description: 'Change fields of an existing light. Omitted fields stay unchanged; name and roomId accept null to clear. A light cannot take fields of another light type.',
    example: { id: 'light-1', patch: { on: false, lumens: 600 } },
  },
  'light.remove': { description: 'Remove a light by id. Undo restores it at the same position in the list.', example: { id: 'light-1' } },
  batch: {
    description:
      'Apply several commands atomically as one undo step: if any fails nothing is applied and the error path says which (commands/N/...). Prefer it for multi-step edits. Batches cannot nest. Each item is a tool\'s arguments plus its "type" (the command type of that tool, e.g. "room.setFloor" for room_set_floor). The server limits the number of commands per batch.',
    example: {
      label: 'Paint the sejour sage',
      commands: [
        { type: 'material.define', material: { id: 'paint-sage', name: 'Sage green', kind: 'paint', color: '#9caf88', roughness: 0.9 } },
        { type: 'room.setWallFinish', roomId: 'sejour', materialId: 'paint-sage' },
      ],
    },
  },
};

/** `wall.setFinish` -> `wall_set_finish`. */
export function toolNameOf(commandType: string): string {
  return commandType.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/\./g, '_').toLowerCase();
}

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Rewrites zod's JSON Schema into the portable subset described above. */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (!isObj(node)) return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties' && isObj(v)) out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, normalize(pv)]));
    else out[k === 'oneOf' ? 'anyOf' : k] = normalize(v);
  }
  // integer safe-range bounds are zod noise
  if (out.maximum === Number.MAX_SAFE_INTEGER) delete out.maximum;
  if (out.minimum === Number.MIN_SAFE_INTEGER) delete out.minimum;
  // [x, y] tuple -> plain array with fixed length
  if (Array.isArray(out.prefixItems)) {
    const items = out.prefixItems as Json[];
    if (items.length > 0 && items.every((i) => i.type === 'number')) {
      delete out.prefixItems;
      out.items = { type: 'number' };
      out.minItems = items.length;
      out.maxItems = items.length;
    }
  }
  // anyOf [X, null] -> type: [X.type, 'null']
  const any = out.anyOf;
  if (Array.isArray(any) && any.length === 2) {
    const nul = any.find((a) => isObj(a) && a.type === 'null' && Object.keys(a).length === 1);
    const other = any.find((a) => a !== nul) as Json | undefined;
    if (nul && other && typeof other.type === 'string' && other.anyOf === undefined) {
      const { anyOf: _drop, ...rest } = out;
      void _drop;
      const merged: Json = { ...other, ...rest, type: [other.type, 'null'] };
      if (Array.isArray(other.enum)) merged.enum = [...other.enum, null];
      return merged;
    }
  }
  return out;
}

function toJson(schema: z.ZodType): Json {
  const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  const { $schema: _drop, ...rest } = raw;
  void _drop;
  return normalize(rest) as Json;
}

/** Drops the internal `index` field (insert position used by undo). */
type Omittable = { omit: (mask: Record<string, true>) => z.ZodType; shape: Record<string, unknown> };
function visible(schema: z.ZodType): z.ZodType {
  const s = schema as unknown as Omittable;
  return 'index' in s.shape ? s.omit({ index: true }) : schema;
}

let cache: CommandToolSchema[] | undefined;

/**
 * One tool schema per leaf command type (in `COMMAND_TYPES` order) plus `batch` last.
 * Returns a fresh deep copy each call.
 */
export function commandToolSchemas(): CommandToolSchema[] {
  if (!cache) {
    const leafDefs: Json = {};
    const tools: CommandToolSchema[] = [];
    for (const type of COMMAND_TYPES) {
      if (type === 'batch') continue;
      const name = toolNameOf(type);
      const full = toJson(visible(LEAF_SCHEMA_BY_TYPE.get(type)!));
      leafDefs[name] = full;
      const { type: _t, ...properties } = full.properties as Json;
      void _t;
      const required = (full.required as string[]).filter((r) => r !== 'type');
      tools.push({
        name,
        commandType: type,
        ...DESCRIPTIONS[type]!,
        inputSchema: { type: 'object', properties, required, additionalProperties: false },
      });
    }
    const batch = toJson(Batch) as { properties: Json; required: string[] };
    const commands = batch.properties.commands as Json;
    tools.push({
      name: 'batch',
      commandType: 'batch',
      ...DESCRIPTIONS.batch!,
      inputSchema: {
        type: 'object',
        properties: {
          label: batch.properties.label,
          commands: { ...commands, items: { anyOf: Object.keys(leafDefs).map((n) => ({ $ref: `#/$defs/${n}` })) } },
        },
        required: batch.required.filter((r) => r !== 'type'),
        additionalProperties: false,
        $defs: leafDefs,
      },
    });
    cache = tools;
  }
  return structuredClone(cache);
}

/**
 * Turns a tool call into the command it stands for (not validated: pass it through `parseCommand`).
 * `undefined` for an unknown tool name.
 */
export function toolCallToCommand(name: string, args: unknown): Record<string, unknown> | undefined {
  const tool = commandToolSchemas().find((t) => t.name === name);
  if (!tool || !isObj(args)) return undefined;
  return { type: tool.commandType, ...args };
}
