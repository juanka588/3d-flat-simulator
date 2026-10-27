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
    description:
      'Add a light: point (bulb), spot (downward cone), area (panel) or grid: rows x cols identical LED downlights as ONE light (rows, cols, lumensEach, kelvin, angle; fitToRoom + roomId, or position + width + depth). ' +
      'Size a grid by the lighting plan of describe_room. Only about 9 lights cast shadows: light_remove the ceiling light a grid replaces. The id is derived (light-N) when omitted.',
    example: { light: { type: 'grid', roomId: 'sejour', fitToRoom: true, rows: 3, cols: 4, lumensEach: 450, kelvin: 2700, angle: 100 } },
  },
  'light.update': {
    description:
      'Change fields of a light (not fields of another light type). ' +
      'Grid: rows, cols, lumensEach, kelvin, angle, on, or fitToRoom: true. A lamp item\'s light (describe_room lights[].itemId) follows its item: only on, lumens, kelvin, name change; move the item instead.',
    example: { id: 'light-1', patch: { on: false, lumens: 600 } },
  },
  'light.remove': {
    description: 'Remove a light by id. Undo restores it at the same position in the list. A lamp item\'s own light cannot be removed alone: light_update {on: false}, or remove the item.',
    example: { id: 'light-1' },
  },
  'item.place': {
    description:
      'Put a real, purchasable product into a room. Only products returned by search_products may be placed; an item without productRef or product is refused with precondition_failed ("search_products first"). ' +
      'Normally use place_item, which finds a valid position and rotation and fills in the product facts (price, dims, link) from the server\'s record; never type those yourself. ' +
      'The item is refused with placement_invalid when it would stand outside its room, overlap a wall or another item, or block a door swing (the message and hint say which and what to try). Windows, glazing, heavy wall mounts and walkways are checked by place_item and validate_layout. ' +
      'Item frame: the front faces plan +y at rotation 0; rotation is degrees counter-clockwise seen from above; a floor item has elevation 0. The id is derived (item-N) when omitted. At most 60 items per room. A lamp (product category lamp) gets a light that moves with it: lumens from the product page when stated (lights[].lumensSource "product"), else an estimate (floor 800, table 400, pendant 1000, wall 400 lm at 2700 K; "estimated"); autoLight false places it unlit. Undo removes the item and its light.',
    example: {
      item: {
        assetId: 'ikea-fr:80275887',
        position: [8.48, 1.1],
        rotation: 0,
        roomId: 'ch1',
        dims: { w: 1.6, d: 2, h: 0.9 },
        mount: 'floor',
        productRef: { provider: 'ikea-fr', sku: '80275887' },
        product: {
          provider: 'ikea-fr',
          sku: '80275887',
          name: 'MALM bed frame 160x200',
          url: 'https://shop.example/p/bed-frame-160x200/',
          price: 199,
          currency: 'EUR',
          dims: { w: 1.6, d: 2, h: 0.9 },
          category: 'bed',
          snapshotAt: '2026-10-27T10:00:00.000Z',
        },
        mesh: { kind: 'lookalike', assetId: 'polyhaven:bed_01' },
        relation: { kind: 'against_wall', wallId: 'w-north', roomId: 'ch1', align: 'start' },
      },
    },
  },
  'item.move': {
    description:
      'Move a placed item (items[].id from describe_room) to a new plan position, optionally with a new rotation, height, room or placement relation. Omitted fields stay as they are; roomId and relation accept null to clear. ' +
      'Refused with placement_invalid when the new spot is outside the room, over a wall or another item, or in a door swing, and with precondition_failed for a locked item (existing furniture such as a built-in wardrobe; only the user may move it). ' +
      'Call validate_layout afterwards to check windows and walkways. Undo moves it back.',
    example: { id: 'item-1', position: [8.2, 1.1], rotation: 0 },
  },
  'item.rotate': {
    description:
      'Turn a placed item to an absolute rotation in degrees, counter-clockwise seen from above (the front faces plan +y at 0, +x at 90, -y at 180, -x at 270). The footprint turns about the item origin and is checked like item_move (placement_invalid when it no longer fits). Locked items cannot be rotated by an LLM. Undo restores the previous rotation.',
    example: { id: 'item-1', rotation: 90 },
  },
  'item.setVariant': {
    description:
      'Switch a placed product to another variant (variants[].sku of the product record): a colour or size, usually another article with its own price and dimensions. Pass the variant SKU and the product snapshot and dims the server resolved for it; variant null clears the choice, dims null returns to the product dimensions. ' +
      'The new dimensions are checked like item_move (placement_invalid when the item no longer fits). Undo restores the previous variant, price and dimensions.',
    example: { id: 'item-1', variant: 'white' },
  },
  'item.remove': {
    description: 'Remove a placed item by id (items[].id from describe_room). A locked item (existing furniture) can only be removed by the user. Undo puts it back at the same position in the list.',
    example: { id: 'item-1' },
  },
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
/** Internal fields used by undo; never shown to a model. */
const HIDDEN_FIELDS = ['index', 'restoreLight'] as const;
function visible(schema: z.ZodType): z.ZodType {
  const s = schema as unknown as Omittable;
  const mask = Object.fromEntries(HIDDEN_FIELDS.filter((k) => k in s.shape).map((k) => [k, true as const]));
  return Object.keys(mask).length ? s.omit(mask) : schema;
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
