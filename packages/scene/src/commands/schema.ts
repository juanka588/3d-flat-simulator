import { z } from 'zod';
import { Light, Material, Site } from '../schema';

const Id = z.string().min(1).max(200);
const MaterialRef = Id.nullable();

/** Light as sent to `light.add`: the id is optional and derived (`light-N`) when absent. */
const LightInput = z.discriminatedUnion('type', [
  Light.options[0].extend({ id: Id.optional() }),
  Light.options[1].extend({ id: Id.optional() }),
  Light.options[2].extend({ id: Id.optional() }),
]);

/** Site fields without schema defaults, so omitted keys are left untouched. */
const SitePatch = z.strictObject({
  latitude: Site.shape.latitude.optional(),
  longitude: Site.shape.longitude.optional(),
  northAngle: z.number().optional(),
  timezone: Site.shape.timezone.unwrap().optional(),
  floorElevation: z.number().optional(),
  /** `null` clears the address. */
  address: z.string().nullable().optional(),
});

/** Light fields that can change; `null` clears the optional ones (`name`, `roomId`). */
const LightPatch = z.strictObject({
  name: z.string().nullable().optional(),
  roomId: Id.nullable().optional(),
  position: Light.options[0].shape.position.optional(),
  elevation: z.number().nonnegative().optional(),
  lumens: z.number().nonnegative().optional(),
  kelvin: z.number().min(1000).max(12000).optional(),
  on: z.boolean().optional(),
  angle: z.number().min(1).max(179).optional(),
  width: z.number().positive().optional(),
  depth: z.number().positive().optional(),
  rotation: z.number().optional(),
});

const t = <T extends string>(type: T) => z.literal(type);

export const MaterialDefine = z.strictObject({
  type: t('material.define'),
  material: Material,
  /** Insert position when the material is new (used by inverses); ignored on update. */
  index: z.number().int().nonnegative().optional(),
});
export const MaterialRemove = z.strictObject({ type: t('material.remove'), id: Id });
export const WallSetFinish = z.strictObject({
  type: t('wall.setFinish'),
  wallId: Id,
  side: z.enum(['left', 'right', 'both']),
  materialId: MaterialRef,
});
export const WallSetStructural = z.strictObject({
  type: t('wall.setStructural'),
  wallId: Id,
  /** `null` clears the explicit value so `isStructural` falls back to its defaults. */
  structural: z.boolean().nullable(),
});
export const RoomSetWallFinish = z.strictObject({ type: t('room.setWallFinish'), roomId: Id, materialId: MaterialRef });
export const RoomSetFloor = z.strictObject({ type: t('room.setFloor'), roomId: Id, materialId: MaterialRef });
export const RoomSetCeiling = z.strictObject({ type: t('room.setCeiling'), roomId: Id, materialId: MaterialRef });
export const SceneSetDefaults = z.strictObject({
  type: t('scene.setDefaults'),
  /** Omitted = unchanged, `null` = clear. */
  wall: MaterialRef.optional(),
  floor: MaterialRef.optional(),
  ceiling: MaterialRef.optional(),
});
export const SiteSet = z.strictObject({ type: t('site.set'), site: SitePatch });
export const LightAdd = z.strictObject({
  type: t('light.add'),
  light: LightInput,
  /** Insert position (used by inverses); defaults to the end. */
  index: z.number().int().nonnegative().optional(),
});
export const LightUpdate = z.strictObject({ type: t('light.update'), id: Id, patch: LightPatch });
export const LightRemove = z.strictObject({ type: t('light.remove'), id: Id });

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
  const batch = z.strictObject({
    type: t('batch'),
    label: z.string().min(1).max(200),
    /** Depth 1: batches cannot nest. An empty batch is a valid no-op. */
    commands: z.array(leaf).max(500),
  });
  const command = z.discriminatedUnion('type', [...(leaves as unknown as LeafSchema[]), batch] as unknown as [LeafSchema, ...LeafSchema[]]);
  return { leaf, batch, command, leaves: leaves as readonly LeafSchema[] };
}

const built = createCommandSchema(LEAF_COMMAND_SCHEMAS as unknown as [LeafSchema, ...LeafSchema[]]);

export const LeafCommand = built.leaf as unknown as z.ZodType<LeafCommand>;
export const Batch = built.batch;
export const Command = built.command as unknown as z.ZodType<Command>;

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
  'item.add': 'item commands are planned for M5',
  'item.update': 'item commands are planned for M5',
  'item.remove': 'item commands are planned for M5',
  'item.move': 'item commands are planned for M5',
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
  id: z.string().min(1).max(64),
  ts: z.number().int().nonnegative(),
  author: Author,
  coalesceKey: z.string().min(1).max(200).optional(),
  /** Expected scene revision; the command fails with `precondition_failed` on mismatch. */
  ifRev: z.number().int().nonnegative().optional(),
  /** Id of the envelope this command undoes / redoes (set by history). */
  undoOf: z.string().optional(),
  redoOf: z.string().optional(),
  cmd: z.unknown(),
});

export const CommandEnvelope = EnvelopeShell.extend({ cmd: Command });
export type CommandEnvelope = Omit<z.infer<typeof EnvelopeShell>, 'cmd'> & { cmd: Command };
