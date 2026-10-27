import { z } from 'zod';
import { ADDRESS_MAX, EntityId, Light, Material, NAME_MAX, Site, stripControlChars } from '../schema';

const Id = EntityId;
const WallId = Id.describe('Id of the wall (walls[].wallId from describe_room).');
const RoomId = Id.describe('Id of the room (rooms[].id from list_rooms).');
const MaterialRef = Id.nullable().describe(
  'Id of a defined material (sceneMaterials[].id from list_materials, or materials[].id from get_scene_summary with detail "full"), or null to clear back to the default. ' +
    'To use a library texture first call material_define with textureUrl "lib:<slug>" (library[].slug from list_materials).',
);

/** Light as sent to `light.add`: the id is optional and derived (`light-N`) when absent. */
const LightInput = z.discriminatedUnion('type', [
  Light.options[0].extend({ id: Id.describe('Optional light id; derived as "light-N" when omitted.').optional() }),
  Light.options[1].extend({ id: Id.describe('Optional light id; derived as "light-N" when omitted.').optional() }),
  Light.options[2].extend({ id: Id.describe('Optional light id; derived as "light-N" when omitted.').optional() }),
]);

/** Site fields without schema defaults, so omitted keys are left untouched. */
const SitePatch = z.strictObject({
  latitude: Site.shape.latitude.describe('Latitude in degrees, -90 to 90 (north positive).').optional(),
  longitude: Site.shape.longitude.describe('Longitude in degrees, -180 to 180 (east positive).').optional(),
  northAngle: z.number().describe('Clockwise angle in degrees from plan "up" (-y) to true north.').optional(),
  timezone: Site.shape.timezone.unwrap().describe('IANA time zone such as "Europe/Paris".').optional(),
  floorElevation: z.number().describe('Height of the flat floor above street level, in metres.').optional(),
  /** `null` clears the address. */
  address: z.string().max(ADDRESS_MAX).transform(stripControlChars).nullable().describe('Postal address (at most 300 characters); null clears it.').optional(),
});

/** Light fields that can change; `null` clears the optional ones (`name`, `roomId`). */
const LightPatch = z.strictObject({
  name: z.string().max(NAME_MAX).transform(stripControlChars).nullable().describe('Label (at most 120 characters); null clears it.').optional(),
  roomId: Id.nullable().describe('Room the light belongs to (rooms[].id from list_rooms); null clears it.').optional(),
  position: Light.options[0].shape.position.optional(),
  elevation: z.number().nonnegative().describe('Height of the light source above the floor, in metres.').optional(),
  lumens: z.number().nonnegative().describe('Luminous flux in lumens.').optional(),
  kelvin: z.number().min(1000).max(12000).describe('Colour temperature in kelvin, 1000-12000.').optional(),
  on: z.boolean().describe('Whether the light is switched on.').optional(),
  angle: z.number().min(1).max(179).describe('Spot lights only: cone angle in degrees (1-179).').optional(),
  width: z.number().positive().describe('Area lights only: width in metres.').optional(),
  depth: z.number().positive().describe('Area lights only: depth in metres.').optional(),
  rotation: z.number().describe('Area lights only: rotation in degrees, counter-clockwise seen from above.').optional(),
});

const t = <T extends string>(type: T) => z.literal(type).describe(`Command discriminator, always "${type}".`);
const INDEX_DESC = 'Internal (used by undo): insert position. Do not send.';

/**
 * `material.define` is an upsert with FULL-REPLACE semantics: a new id inserts the material; an
 * existing id replaces it entirely (omitted optional fields are cleared, `roughness` resets to its
 * default), so send every field you want to keep. A material's `kind` can never change.
 */
export const MaterialDefine = z.strictObject({
  type: t('material.define'),
  material: Material.describe(
    'The complete material. An existing id is fully replaced (omitted optional fields are cleared); kind cannot change.',
  ),
  /** Insert position when the material is new (used by inverses); ignored on update. */
  index: z.number().int().nonnegative().describe(INDEX_DESC).optional(),
});
export const MaterialRemove = z.strictObject({
  type: t('material.remove'),
  id: Id.describe('Id of the material to delete (sceneMaterials[].id from list_materials). Fails with precondition_failed while any wall, room or default uses it.'),
});
export const WallSetFinish = z.strictObject({
  type: t('wall.setFinish'),
  wallId: WallId,
  side: z
    .enum(['left', 'right', 'both'])
    .describe(
      'Which face of the wall. "left" is the left of someone walking from the wall start to its end on the plan (plan y grows down; describe_room gives the side that faces each room), "right" the other face, "both" both faces. ' +
        'With roomId, "both" means every face of this wall that the room adjoins.',
    ),
  materialId: MaterialRef,
  roomId: RoomId.describe(
    'The room whose stretch of this wall side to paint (rooms[].id from list_rooms). Strongly recommended: a wall side can be shared by several rooms (e.g. the alcove and the sejour) and without roomId the whole side is painted for all of them. ' +
      'Fails with precondition_failed if the room does not border that side. A room-scoped finish beats the whole-side finish and room_set_wall_finish.',
  ).optional(),
});
export const WallSetStructural = z.strictObject({
  type: t('wall.setStructural'),
  wallId: WallId,
  /** `null` clears the explicit value so `isStructural` falls back to its defaults. */
  structural: z
    .boolean()
    .nullable()
    .describe(
      'true marks the wall structural (cannot be removed); false marks it removable; null clears the explicit mark so it is derived (exterior or at least 15 cm thick means structural). ' +
        'Only a user may set false on a wall that is structural by default.',
    ),
});
export const RoomSetWallFinish = z.strictObject({
  type: t('room.setWallFinish'),
  roomId: RoomId,
  materialId: MaterialRef,
});
export const RoomSetFloor = z.strictObject({ type: t('room.setFloor'), roomId: RoomId, materialId: MaterialRef });
export const RoomSetCeiling = z.strictObject({ type: t('room.setCeiling'), roomId: RoomId, materialId: MaterialRef });
export const SceneSetDefaults = z.strictObject({
  type: t('scene.setDefaults'),
  /** Omitted = unchanged, `null` = clear. */
  wall: MaterialRef.describe('Default wall material for faces without a finish. Omit to leave unchanged, null to clear.').optional(),
  floor: MaterialRef.describe('Default floor material. Omit to leave unchanged, null to clear.').optional(),
  ceiling: MaterialRef.describe('Default ceiling material. Omit to leave unchanged, null to clear.').optional(),
});
export const SiteSet = z.strictObject({
  type: t('site.set'),
  site: SitePatch.describe('Fields to change; omitted fields stay as they are.'),
});
export const LightAdd = z.strictObject({
  type: t('light.add'),
  light: LightInput.describe('The light to add: point, spot or area, discriminated by its "type".'),
  /** Insert position (used by inverses); defaults to the end. */
  index: z.number().int().nonnegative().describe(INDEX_DESC).optional(),
});
export const LightUpdate = z.strictObject({
  type: t('light.update'),
  id: Id.describe('Id of the light (lights[].id from describe_room, or lights[].id from get_scene_summary with detail "full").'),
  patch: LightPatch.describe('Fields to change; omitted fields stay as they are, null clears name and roomId. A light cannot take fields of another light type.'),
});
export const LightRemove = z.strictObject({ type: t('light.remove'), id: Id.describe('Id of the light to remove (lights[].id from describe_room, or lights[].id from get_scene_summary with detail "full").') });

/** Leaf (non-batch) command schemas. M5 appends item commands here or via `createCommandSchema`. */
export const LEAF_COMMAND_SCHEMAS = [
  MaterialDefine,
  MaterialRemove,
  WallSetFinish,
  WallSetStructural,
  RoomSetWallFinish,
  RoomSetFloor,
  RoomSetCeiling,
  SceneSetDefaults,
  SiteSet,
  LightAdd,
  LightUpdate,
  LightRemove,
] as const;

type LeafSchema = z.ZodObject<{ type: z.ZodLiteral<string> }, z.core.$strict>;

/** Builds the leaf and full command unions from a list of strict leaf schemas. */
export function createCommandSchema<const L extends readonly [LeafSchema, ...LeafSchema[]]>(leaves: L) {
  const leaf = z.discriminatedUnion('type', leaves as unknown as [LeafSchema, ...LeafSchema[]]);
  const label = z.string().min(1).max(200).describe('Short description of the whole change, shown in the undo history (at most 200 characters).');
  const batch = z.strictObject({
    type: t('batch'),
    label,
    /** Depth 1: batches cannot nest. An empty batch is a valid no-op. */
    commands: z.array(leaf).max(500).describe('Commands applied in order and atomically: all succeed or none apply. Batches cannot nest.'),
  });
  /** Same shape without the size cap; only for history-generated inverses (see `applyCommand` `trusted`). */
  const trustedBatch = z.strictObject({ type: t('batch'), label, commands: z.array(leaf) });
  const command = z.discriminatedUnion('type', [...(leaves as unknown as LeafSchema[]), batch] as unknown as [LeafSchema, ...LeafSchema[]]);
  const trustedCommand = z.discriminatedUnion('type', [...(leaves as unknown as LeafSchema[]), trustedBatch] as unknown as [LeafSchema, ...LeafSchema[]]);
  return { leaf, batch, trustedBatch, command, trustedCommand, leaves: leaves as readonly LeafSchema[] };
}

const built = createCommandSchema(LEAF_COMMAND_SCHEMAS as unknown as [LeafSchema, ...LeafSchema[]]);

export const LeafCommand = built.leaf as unknown as z.ZodType<LeafCommand>;
export const Batch = built.batch;
export const Command = built.command as unknown as z.ZodType<Command>;
/** `Command` without the 500-command batch cap. Only for inverses generated by history (trusted). */
export const TrustedCommand = built.trustedCommand as unknown as z.ZodType<Command>;
export const TRUSTED_BATCH: z.ZodType = built.trustedBatch;

export type LeafCommand =
  | z.input<typeof MaterialDefine>
  | z.input<typeof MaterialRemove>
  | z.input<typeof WallSetFinish>
  | z.input<typeof WallSetStructural>
  | z.input<typeof RoomSetWallFinish>
  | z.input<typeof RoomSetFloor>
  | z.input<typeof RoomSetCeiling>
  | z.input<typeof SceneSetDefaults>
  | z.input<typeof SiteSet>
  | z.input<typeof LightAdd>
  | z.input<typeof LightUpdate>
  | z.input<typeof LightRemove>;
export type BatchCommand = { type: 'batch'; label: string; commands: LeafCommand[] };
export type Command = LeafCommand | BatchCommand;
export type CommandType = Command['type'];

export const COMMAND_TYPES: readonly string[] = [...built.leaves.map((s) => s.shape.type.value), 'batch'];
/** Leaf schemas keyed by command type, for tool-schema generation. */
export const LEAF_SCHEMA_BY_TYPE: ReadonlyMap<string, LeafSchema> = new Map(built.leaves.map((s) => [s.shape.type.value, s] as [string, LeafSchema]));
export const COMMAND_SCHEMA_BY_TYPE: ReadonlyMap<string, z.ZodType> = new Map([
  ...built.leaves.map((s) => [s.shape.type.value, s] as [string, z.ZodType]),
  ['batch', built.batch as z.ZodType],
]);

/** Command types reserved for later milestones; they answer `not_supported` with a hint. */
export const RESERVED_COMMAND_TYPES: Readonly<Record<string, string>> = {
  'wall.add': 'wall geometry editing is planned for M6',
  'wall.move': 'moving walls is planned for M6 (room polygons must be reconciled)',
  'wall.remove': 'removing walls is planned for M6; structural walls can never be removed',
  'wall.split': 'wall geometry editing is planned for M6',
  'wall.setThickness': 'wall geometry editing is planned for M6',
  'opening.add': 'opening commands are planned for M6',
  'opening.update': 'opening commands are planned for M6',
  'opening.remove': 'opening commands are planned for M6',
  'room.add': 'room geometry editing is planned for M6',
  'room.remove': 'room geometry editing is planned for M6',
  'room.setPolygon': 'room geometry editing is planned for M6',
  'item.add': 'M5 lane B',
  'item.update': 'M5 lane B',
  'item.remove': 'M5 lane B',
  'item.move': 'M5 lane B',
  'item.place': 'M5 lane B',
  'item.rotate': 'M5 lane B',
  'item.setVariant': 'M5 lane B',
};

const Author = z.strictObject({
  kind: z.enum(['user', 'llm', 'planner']),
  name: z.string().max(200).optional(),
  clientId: z.string().max(200).optional(),
});
export type Author = z.infer<typeof Author>;

/** Envelope with the command left unvalidated (`parseCommand` validates it with better errors). */
export const EnvelopeShell = z.strictObject({
  v: z.literal(1),
  id: EntityId,
  ts: z.number().int().nonnegative(),
  author: Author,
  coalesceKey: z.string().min(1).max(200).optional(),
  /** Expected scene revision; the command fails with `precondition_failed` on mismatch. */
  ifRev: z.number().int().nonnegative().optional(),
  /** Id of the envelope this command undoes / redoes (set by history). */
  undoOf: z.string().min(1).max(64).optional(),
  redoOf: z.string().min(1).max(64).optional(),
  cmd: z.unknown(),
});

export const CommandEnvelope = EnvelopeShell.extend({ cmd: Command });
export const TrustedCommandEnvelope = EnvelopeShell.extend({ cmd: TrustedCommand });
export type CommandEnvelope = Omit<z.infer<typeof EnvelopeShell>, 'cmd'> & { cmd: Command };
