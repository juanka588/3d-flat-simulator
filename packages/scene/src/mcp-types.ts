import { z } from 'zod';
import { PROVIDER_ERROR_CODES, PROVIDER_ERROR_HINTS } from './products';
import { CameraPose, LightingView, PresetName } from './view';

/**
 * Contracts of the MCP server (M4): the shapes shared by the pure describers (lane A), the web
 * viewer (lane B), the server (lane C), the MCP core (lane D) and the renderer (lane E).
 * zod schemas are the source of truth; the types are inferred. Everything is plain JSON.
 * Units: metres, square metres, degrees, hours. Plan y grows down; see `schema.ts`.
 */

// ---------------------------------------------------------------------------------------------
// Shared small types
// ---------------------------------------------------------------------------------------------

/** True-compass direction (after `site.northAngle`). */
export const CompassPoint = z.enum(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
export type CompassPoint = z.infer<typeof CompassPoint>;

/** `[x, y]` on the plan, metres. */
const Plan2 = z.tuple([z.number(), z.number()]);

// ---------------------------------------------------------------------------------------------
// RenderSpec / RenderResult  (render_view tool; the render service of lane E)
// ---------------------------------------------------------------------------------------------

export const RENDER_LIMITS = {
  /** Longest image edge in pixels. */
  maxEdgePx: 1568,
  defaultWidth: 1024,
  defaultHeight: 768,
  /** Hard render timeout (ms). */
  timeoutMs: 20_000,
} as const;

/**
 * What to render. A render is a pure function of `(Scene@rev, RenderSpec)`: the same spec on the
 * same scene revision yields the same pixels. Unset lighting fields fall back to the MCP session's
 * lighting view (`set_sun_time`), then to `DEFAULT_LIGHTING`.
 */
export const RenderSpec = z.strictObject({
  /** `room`: orbit overview of `roomId`; `walk`: eye level in `roomId`; `top`: plan view; `orbit`: whole flat. */
  view: z.enum(['room', 'walk', 'top', 'orbit']).default('room'),
  /** Required for `room` and `walk`; optional for `top` / `orbit` (fits that room). */
  roomId: z.string().min(1).max(64).optional(),
  /** `walk` only: compass point (true north) or plan heading in degrees clockwise from plan-up. */
  facing: z.union([CompassPoint, z.number().min(-360).max(360)]).optional(),
  /** Explicit camera; overrides `view`/`roomId`/`facing` for placement (advanced). */
  pose: CameraPose.optional(),
  /** Local date `YYYY-MM-DD` at the site. */
  date: LightingView.shape.date.optional(),
  /** Local time `HH:mm` at the site. */
  time: LightingView.shape.time.optional(),
  /** Lighting preset applied before `lamps` (day / evening / night). */
  preset: PresetName.optional(),
  /** Per-lamp overrides keyed by light id. */
  lamps: LightingView.shape.lamps.optional(),
  exposureEV: LightingView.shape.exposureEV.optional(),
  /** Image size in pixels; the long edge is clamped to `RENDER_LIMITS.maxEdgePx`. */
  size: z.strictObject({ width: z.number().int().min(64).max(4096), height: z.number().int().min(64).max(4096) }).optional(),
  /** `before_after`: also render the scene as of the session's checkpoint / previous revision and return both images. */
  compare: z.enum(['before_after']).optional(),
  /** Render this uncommitted scene state (preview) instead of the server's: set by the MCP core, never by the model. */
  previewOf: z.number().int().nonnegative().optional(),
});
export type RenderSpec = z.infer<typeof RenderSpec>;
/** Input form (defaults not yet applied). */
export type RenderSpecInput = z.input<typeof RenderSpec>;

/** Metadata returned next to the image(s) of a render (the pixels travel as MCP image content). */
export const RenderResult = z.strictObject({
  mimeType: z.literal('image/png'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Scene identity the image was drawn from. */
  epoch: z.string(),
  rev: z.number().int().nonnegative(),
  /** Resolved spec (defaults applied) and the camera actually used. */
  view: RenderSpec.shape.view,
  roomId: z.string().optional(),
  pose: CameraPose,
  /** Resolved lighting view that was drawn. */
  lighting: LightingView,
  /** Wall-clock time of the render in ms, and whether the warm page was reused. */
  renderMs: z.number().nonnegative(),
  warm: z.boolean(),
  /** Present with `compare`: the revision of the "before" image (the second image in the result). */
  compare: z.strictObject({ beforeRev: z.number().int().nonnegative() }).optional(),
});
export type RenderResult = z.infer<typeof RenderResult>;

// ---------------------------------------------------------------------------------------------
// RoomDescription / RoomSummary  (describe_room, list_rooms; pure: lane A)
// ---------------------------------------------------------------------------------------------

/** Cheap per-room line for `list_rooms`. */
export const RoomSummary = z.strictObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  areaM2: z.number(),
  /** Room paint / floor / ceiling material ids (null = scene default or none). */
  wallFinish: z.string().nullable(),
  floor: z.string().nullable(),
  ceiling: z.string().nullable(),
  /** Counts, so the model knows what describe_room will show. */
  windows: z.number().int().nonnegative(),
  doors: z.number().int().nonnegative(),
  lights: z.number().int().nonnegative(),
});
export type RoomSummary = z.infer<typeof RoomSummary>;

/** Where the effective finish of a wall stretch comes from (see `wall.setFinish` precedence). */
export const FinishSource = z.enum(['room_scoped', 'whole_face', 'room_wall_finish', 'scene_default', 'none']);
export type FinishSource = z.infer<typeof FinishSource>;

export const RoomWallDescription = z.strictObject({
  wallId: z.string(),
  /** Which face of the wall borders this room, per the wall's walking direction (start to end, plan y down). */
  side: z.enum(['left', 'right']),
  /**
   * Where the wall is relative to the room: the compass direction from the room's inside towards this
   * wall (the outward normal). `W` is the room's west wall. It agrees with `compass` of the openings
   * on that wall, which is the direction you look through them.
   */
  wallOn: CompassPoint,
  lengthM: z.number(),
  thicknessM: z.number(),
  /** Never removable. */
  structural: z.boolean(),
  /** Why (`structuralInfo().source`): explicit flag, exterior wall, thickness, or plain partition. */
  structuralSource: z.enum(['explicit', 'exterior', 'thickness', 'partition']).optional(),
  /** Effective material id on this room's stretch (null when none) and why. */
  finish: z.strictObject({ materialId: z.string().nullable(), source: FinishSource }),
  /** Other rooms that see the same face (a whole-face finish would show there too). */
  sharedWith: z.array(z.string()),
});
export type RoomWallDescription = z.infer<typeof RoomWallDescription>;

export const RoomOpeningDescription = z.strictObject({
  id: z.string(),
  type: z.enum(['door', 'window', 'passage']),
  wallId: z.string(),
  /** Compass direction you look through the opening from inside the room (towards the outside / next room); equals `wallOn` of its wall. */
  compass: CompassPoint,
  widthM: z.number(),
  heightM: z.number(),
  sillM: z.number(),
  /** For doors: the room on the other side, when there is one. */
  leadsTo: z.string().nullable(),
  /** Whether it lets light through. */
  glazed: z.boolean().optional(),
  /** Doors only: `into this room`, `into <roomId>` (the other room) or `outward` (out of the flat). */
  swing: z.string().optional(),
});
export type RoomOpeningDescription = z.infer<typeof RoomOpeningDescription>;

export const RoomLightDescription = z.strictObject({
  id: z.string(),
  type: z.enum(['point', 'spot', 'area', 'grid']),
  on: z.boolean(),
  /** Total flux in lumens (a grid: rows x cols x lumensEach). */
  lumens: z.number(),
  kelvin: z.number(),
  /** Grids only: the layout and the flux of each fixture. */
  rows: z.number().int().optional(),
  cols: z.number().int().optional(),
  lumensEach: z.number().optional(),
  /** Grids only: where it sits, so a model can resize it. */
  grid: z.strictObject({ position: Plan2, widthM: z.number(), depthM: z.number(), elevationM: z.number() }).optional(),
  /** Lamp items: the item this light belongs to (it moves with it). */
  itemId: z.string().optional(),
  /** Lamp items: where the lumen figure comes from (`product`: the retailer page, `estimated`: category default, `user`). */
  lumensSource: z.enum(['product', 'estimated', 'user']).optional(),
});

/** Lighting hint of `describe_room`: the target illuminance for the room type and what the lights give now (lumen method). */
export const RoomLightingPlan = z.strictObject({
  /** Recommended average illuminance on the floor / work plane, lux. */
  targetLux: z.strictObject({ min: z.number(), max: z.number() }),
  note: z.string(),
  /** Lumens of the lights that are on / of all the lights of the room. */
  litLumens: z.number(),
  installedLumens: z.number(),
  /** Estimated mean illuminance of the lit lights: lumens x 0.5 / area. */
  estimatedLux: z.number(),
  status: z.enum(['dark', 'below', 'within', 'above']),
  /** A downlight grid for the middle of the target; send it to light_add with fitToRoom. */
  suggestedGrid: z
    .strictObject({ rows: z.number().int(), cols: z.number().int(), lumensEach: z.number() })
    .nullable(),
});
export type RoomLightingPlan = z.infer<typeof RoomLightingPlan>;

/** One placed item as `describe_room` lists it (M5.16). Compact: the LLM reads a dozen of these per room. */
export const RoomItemDescription = z.strictObject({
  id: z.string(),
  /** Product name, else the builtin asset's name, else the id. */
  name: z.string(),
  assetId: z.string(),
  /** `"<provider>:<sku>"` when the item is backed by a product, else null. */
  productId: z.string().nullable(),
  /** Snapshot price (TTC) when the item has a product, else null. */
  price: z.strictObject({ amount: z.number(), currency: z.string() }).nullable(),
  /** Exact outer dimensions in metres. */
  dims: z.strictObject({ w: z.number(), d: z.number(), h: z.number() }),
  mount: z.enum(['floor', 'wall', 'ceiling']),
  /** Existing furniture the designer plans around. */
  locked: z.boolean(),
  /** Where the shape comes from: the provider's model, a library lookalike, a parametric generator, a builtin asset or a placeholder box. */
  mesh: z.enum(['provider', 'lookalike', 'parametric', 'builtin', 'placeholder']),
  /** Plan position [x, y] of the item origin (footprint centre). */
  position: Plan2,
  /** Degrees counter-clockwise seen from above; the front faces plan +y at 0. */
  rotationDeg: z.number(),
  /** Height of the item bottom above the floor in metres. */
  elevationM: z.number(),
  /** Position in room terms, e.g. "against the north wall, 0.4 m from the east corner". */
  where: z.string(),
  /** Something to know about how the item is drawn or sold, e.g. a bed frame drawn with a mattress that is not part of the product. */
  note: z.string().optional(),
});
export type RoomItemDescription = z.infer<typeof RoomItemDescription>;

/** Full answer of `describe_room`. Budget: JSON <= ~1.5k tokens for the Charme fixture rooms. */
export const RoomDescription = z.strictObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  /** Scene revision it was computed from. */
  rev: z.number().int().nonnegative().optional(),
  areaM2: z.number(),
  /** Length of the room outline in metres. */
  perimeterM: z.number().optional(),
  ceilingHeightM: z.number(),
  /** Bounding box of the polygon, plan metres: [minX, minY, maxX, maxY]. */
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  floor: z.strictObject({
    materialId: z.string().nullable(),
    /** Floor zones (parts of the floor with their own material); absent when the room has none. */
    zones: z.array(z.strictObject({ id: z.string(), name: z.string(), areaM2: z.number(), materialId: z.string() })).optional(),
  }),
  ceiling: z.strictObject({ materialId: z.string().nullable() }),
  walls: z.array(RoomWallDescription),
  openings: z.array(RoomOpeningDescription),
  lights: z.array(RoomLightDescription),
  /** Target illuminance for the room type vs what the lights give now, and a grid that would reach it. */
  lighting_plan: RoomLightingPlan,
  /** Daylight for `date` (default: the session lighting date). Null fields: not computable (e.g. no windows). */
  daylight: z.strictObject({
    date: z.string(),
    /** `context` when neighbouring buildings (site context) were taken into account for the sun hours. */
    obstruction: z.enum(['none', 'context']).optional(),
    /** Average daylight factor in percent (indirect sky light), null when unavailable. */
    daylightFactorPct: z.number().nullable(),
    /** Hours of direct sun reaching the floor through the openings on `date`. */
    sunlightHours: z.number().nullable(),
    firstSun: z.string().nullable(),
    lastSun: z.string().nullable(),
  }),
  /** Placed items of the room, in scene order. */
  items: z.array(RoomItemDescription),
});
export type RoomDescription = z.infer<typeof RoomDescription>;

// ---------------------------------------------------------------------------------------------
// SceneDiff  (preview result, write-tool summary, compare; pure: lane A)
// ---------------------------------------------------------------------------------------------

/** One changed field of one entity. `before`/`after` are JSON values (undefined = absent). */
export const FieldChange = z.strictObject({
  field: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type FieldChange = z.infer<typeof FieldChange>;

export const EntityDiff = z.strictObject({
  kind: z.enum(['material', 'wall', 'opening', 'room', 'item', 'light', 'site', 'defaults']),
  /** Entity id (`site` / `defaults` use their kind). */
  id: z.string(),
  change: z.enum(['added', 'removed', 'modified']),
  /** For `modified`: the changed fields (dotted paths, e.g. `finish.left`, `roomFinishes.sejour.right`). */
  fields: z.array(FieldChange),
  /** Human label, e.g. the room name, for the model's summary. */
  label: z.string().optional(),
});
export type EntityDiff = z.infer<typeof EntityDiff>;

/** Most entries `diffScenes` lists. */
export const DIFF_MAX_ENTRIES = 50;

/**
 * Structural difference between two scenes: deterministic order (kind, then id), no entry for
 * unchanged entities, and `diffScenes(a, a)` is empty. The preview diff and the committed diff of
 * the same command are equal (property test, M4.6).
 */
export const SceneDiff = z.strictObject({
  changes: z.array(EntityDiff),
  /** True when `changes` was cut at `DIFF_MAX_ENTRIES`; `summary` still counts every change. */
  truncated: z.boolean().optional(),
  /** Totals by change type. */
  summary: z.strictObject({ added: z.number().int(), removed: z.number().int(), modified: z.number().int() }),
  /** One-line text for the model, e.g. "2 rooms repainted, 1 material added". */
  text: z.string(),
});
export type SceneDiff = z.infer<typeof SceneDiff>;

// ---------------------------------------------------------------------------------------------
// MCP tool errors
// ---------------------------------------------------------------------------------------------

/** Codes produced by the command reducer (`@flat/scene` `ErrorCode`). */
export const REDUCER_ERROR_CODES = [
  'invalid_command',
  'unknown_entity',
  'unknown_material',
  'limit_exceeded',
  'precondition_failed',
  'not_supported',
  'scene_invalid',
  'no_wall_sides',
  // Added by M5.10: item commands refused by a placement rule (`violation` + `hint` explain which).
  'placement_invalid',
] as const;

/** Codes added by the MCP layer / the scene server. */
export const MCP_ONLY_ERROR_CODES = [
  'server_unreachable',
  'stale_scene',
  'rate_limited',
  'batch_too_large',
  'read_only',
  'render_unavailable',
  'render_timeout',
  'render_failed',
  'unknown_room',
  'unknown_checkpoint',
  'nothing_to_undo',
  'nothing_to_redo',
  'unauthorized',
  'not_implemented',
  'internal_error',
  // Added by M5.11 (lane E): `place_item` refusals.
  'unknown_product',
  'dims_mismatch',
  // Added by M5.0: product providers (hints in `PROVIDER_ERROR_HINTS`).
  ...PROVIDER_ERROR_CODES,
] as const;

export const MCP_ERROR_CODES = [...REDUCER_ERROR_CODES, ...MCP_ONLY_ERROR_CODES] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

/** "What to call next" for every code: the default hint when the failure itself offers none. */
export const MCP_ERROR_HINTS: Readonly<Record<McpErrorCode, string>> = {
  invalid_command: 'Fix the arguments named in errors[].path and call again; the tool schema lists the allowed fields.',
  unknown_entity: 'The id does not exist; use one of the nearest ids in the hint, or call list_rooms / get_scene_summary.',
  unknown_material: 'Define the material first with material_define, or pick an id from list_materials.',
  limit_exceeded: 'The flat already holds the maximum of this kind; remove something first.',
  precondition_failed: 'The scene state forbids this change (see the message); change the preconditions or pick another target.',
  not_supported: 'This command is not available yet; use a supported tool.',
  scene_invalid: 'The change would break the scene; adjust the values.',
  no_wall_sides: 'The room has no wall faces to paint; paint its floor or ceiling instead.',
  placement_invalid: 'The item cannot stand there (outside the room, over a wall or another item, or in a door swing); follow the hint or call get_placement_options for valid spots.',
  server_unreachable: 'Start the scene server (pnpm server, or pnpm dev:all) and retry; check FLAT_SERVER_URL.',
  stale_scene: 'The scene changed since you read it; call get_scene_summary and retry.',
  rate_limited: 'Too many calls; wait retryAfterMs and retry.',
  batch_too_large: 'Split the batch into smaller batches (limit in the message).',
  read_only: 'This MCP server is read-only (FLAT_MCP_READONLY); only read and view tools work.',
  render_unavailable: 'Rendering is not available (no web build or no browser); run pnpm mcp:setup in the repo, or use describe_room.',
  render_timeout: 'The render timed out; retry with a smaller size.',
  render_failed: 'The viewer drew nothing readable (a blank image was not returned); the hint carries the page log. Retry once, or rebuild the viewer with pnpm mcp:setup.',
  unknown_room: 'No such room; call list_rooms for the ids.',
  unknown_checkpoint: 'No such checkpoint; call list_history to see the checkpoint names.',
  nothing_to_undo: 'The history is empty; nothing to undo.',
  nothing_to_redo: 'Nothing was undone; nothing to redo.',
  unauthorized: 'The scene server needs a token; set FLAT_TOKEN to the server token.',
  not_implemented: 'This tool is not implemented yet in this build.',
  internal_error: 'Unexpected failure; retry once, then report it with the message.',
  unknown_product: 'Only products returned by search_products or get_product in this session can be placed; call search_products first and use a productId it returned.',
  dims_mismatch: 'A parametric mesh must match the product dimensions within 2%; use the dims in the hint, omit mesh to get the default shape, or call search_assets for generator parameters.',
  ...PROVIDER_ERROR_HINTS,
};

/** One located problem inside an error (a reducer error or a server error item). */
export const McpErrorItem = z.strictObject({
  code: z.string(),
  path: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});
export type McpErrorItem = z.infer<typeof McpErrorItem>;

/** `structuredContent` (and the JSON text) of every failed tool call (`isError: true`). */
export const McpToolError = z.strictObject({
  ok: z.literal(false),
  code: z.enum(MCP_ERROR_CODES),
  message: z.string(),
  /** What to call next. */
  hint: z.string(),
  /** Located problems, e.g. one per invalid field (path as in `parseCommand`: `cmd/commands/2/materialId`). */
  errors: z.array(McpErrorItem).optional(),
  /** `rate_limited`: when to retry. */
  retryAfterMs: z.number().int().nonnegative().optional(),
  /** `stale_scene` / `precondition_failed`: the current revision. */
  rev: z.number().int().nonnegative().optional(),
});
export type McpToolError = z.infer<typeof McpToolError>;
