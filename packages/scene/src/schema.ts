import { z } from 'zod';
import { checkParametricMesh, MeshSource } from './assets/catalog';
import { isSimplePolygon, polygonArea } from './measure';
import { Clearance, Dims, EntityId, ItemMount, NAME_MAX, NameString, Sku, stripControlChars, Vec2 } from './primitives';
import { ProductRef, ProductSnapshot } from './products';
import { Relation } from './placement/types';
import { zoneProblems } from './geometry/zones';

export { EntityId, NAME_MAX, stripControlChars, Vec2 };

/**
 * Scene JSON: the single source of truth for a flat.
 *
 * Conventions:
 * - Units are metres; angles are degrees.
 * - Plan coordinates are 2D `[x, y]` as drawn on a blueprint (y grows "down" the page).
 *   World mapping: X = x, Z = y, Y = up. This is not mirrored: looking down from +Y the
 *   plan reads exactly like the blueprint.
 * - Rotations are counter-clockwise seen from above, which equals three.js `rotation.y`.
 * - Walls are defined by their centreline. Room polygons should follow the inner faces of
 *   the surrounding walls, so room areas are net (habitable) like the areas listed on
 *   French plans. Centreline polygons are tolerated but then report gross areas.
 * - `site.northAngle` is the clockwise angle from plan "up" (-y) to true north.
 * - Unknown keys are rejected so typos (from humans or LLMs) surface as errors.
 */

/** Tolerance for floating-point comparisons on plan geometry, in metres. */
export const EPSILON = 1e-6;

/** Upper bounds on collection sizes, so a hostile or broken file cannot cause unbounded work. */
export const LIMITS = {
  walls: 2000,
  openings: 4000,
  rooms: 500,
  polygonVertices: 500,
  items: 5000,
  lights: 1000,
  materials: 1000,
  /** Floor zones in one room. */
  floorZonesPerRoom: 32,
} as const;

const Id = EntityId;
/** Maximum length of the postal address. */
export const ADDRESS_MAX = 300;
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a hex colour like #a1b2c3');
const TimeZone = z.string().refine(isTimeZone, 'unknown IANA time zone');

export const Material = z
  .strictObject({
    id: Id.describe('Material id (1-64 characters), unique across all entities. Reference it from finishes and defaults.'),
    name: NameString('Human-readable name, at most 120 characters.'),
    kind: z.enum(['paint', 'texture']).describe('"paint" is a flat colour; "texture" adds a PBR texture set (needs textureUrl). Cannot change once defined.'),
    color: HexColor.describe('Base colour as #rrggbb. For textures it is the fallback and tint colour.'),
    roughness: z.number().min(0).max(1).default(0.9).describe('Surface roughness from 0 (mirror) to 1 (matte). Defaults to 0.9.'),
    /** Texture set reference (M3+). Required when `kind` is "texture". Only the "lib:<slug>" scheme exists. */
    textureUrl: z
      .string()
      .refine(isTextureUrl, 'expected "lib:<slug>" (see materials://list)')
      .describe('Texture set as "lib:<slug>"; read materials://list for the available slugs. Required when kind is "texture".')
      .optional(),
    /** Texture tile size in metres. */
    textureScale: z.number().positive().describe('Size in metres of one texture tile. Optional.').optional(),
  })
  .refine((m) => m.kind !== 'texture' || m.textureUrl !== undefined, {
    path: ['textureUrl'],
    message: 'texture materials need a textureUrl',
  });
export type Material = z.infer<typeof Material>;

export const Wall = z.strictObject({
  id: Id,
  start: Vec2,
  end: Vec2,
  thickness: z.number().positive().default(0.1),
  height: z.number().positive().default(2.6),
  /**
   * Material per side, relative to walking from `start` to `end` as seen on the plan.
   * See `wallLeftNormal` for the exact definition.
   */
  finish: z.strictObject({ left: Id.optional(), right: Id.optional() }).default({}),
  /**
   * Finishes of one room's stretch of a wall side: `roomFinishes[roomId][side]`. Stored as a record
   * keyed by room id (rooms are few per wall, and ids are unique). Resolution, most specific first:
   * `roomFinishes[room][side]`, then the whole-side `finish[side]`, then `Room.wallFinish`, then
   * `defaults.wall`, then a builtin (see `wallFaceMaterial`). Empty entries are never stored.
   */
  roomFinishes: z.record(Id, z.strictObject({ left: Id.optional(), right: Id.optional() })).optional(),
  /**
   * Whether the wall is structural (load-bearing, facade, party wall) and so can never be
   * removed. When absent it is resolved by `isStructural` (exterior/party or >= 15 cm thick).
   */
  structural: z.boolean().optional(),
});
export type Wall = z.infer<typeof Wall>;

export const Opening = z.strictObject({
  id: Id,
  wallId: Id,
  /** `passage` is a doorless opening (archway, open plan). */
  type: z.enum(['door', 'window', 'passage']),
  /** Distance along the wall from `start` to the opening's centre. */
  offset: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
  /** Height of the opening's bottom edge above the floor (0 for doors). */
  sill: z.number().nonnegative().default(0),
  /** Whether the opening lets light through. Defaults to true for windows, false for doors. */
  glazed: z.boolean().optional(),
  /** Door leaf: which end of the opening is hinged, and which wall side it swings into. */
  hinge: z.enum(['start', 'end']).optional(),
  swing: z.enum(['left', 'right']).optional(),
});
export type Opening = z.infer<typeof Opening>;

export const RoomType = z.enum([
  'living',
  'kitchen',
  'dining',
  'bedroom',
  'bathroom',
  'hallway',
  'office',
  'storage',
  'balcony',
  'other',
]);
export type RoomType = z.infer<typeof RoomType>;

/**
 * A part of a room's floor with its own material (tiles in the kitchen corner of an open-plan room, a rug
 * area). The polygon is a simple polygon inside the room polygon (1 cm tolerance); zones of one room do not
 * overlap. Inside the polygon `material` replaces the room's floor material. The id is unique within the room.
 */
export const FloorZone = z.strictObject({
  id: Id.describe('Zone id, unique within its room.'),
  name: NameString('Label.').optional(),
  polygon: z.array(Vec2).min(3).max(LIMITS.polygonVertices, `too many polygon vertices (max ${LIMITS.polygonVertices})`).describe('Outline: [x, y] plan points in metres.'),
  material: Id.describe('Defined material id (list_materials).'),
});
export type FloorZone = z.infer<typeof FloorZone>;

export const Room = z.strictObject({
  id: Id,
  name: NameString(),
  type: RoomType,
  polygon: z.array(Vec2).min(3).max(LIMITS.polygonVertices, `too many polygon vertices (max ${LIMITS.polygonVertices})`),
  /**
   * Finish of this room's wall faces. Applies to the stretches of wall faces that border this room
   * unless the wall has a room-scoped or whole-side `finish` for that side (see `wallFaceMaterial`).
   */
  wallFinish: Id.optional(),
  floorMaterial: Id.optional(),
  /** Parts of the floor with their own material (see `FloorZone`); the rest of the floor uses `floorMaterial`. */
  floorZones: z.array(FloorZone).max(LIMITS.floorZonesPerRoom, `too many floor zones (max ${LIMITS.floorZonesPerRoom})`).optional(),
  ceilingMaterial: Id.optional(),
  /** Floor-to-ceiling height; defaults to the lowest wall bounding the room. */
  ceilingHeight: z.number().positive().optional(),
});
export type Room = z.infer<typeof Room>;

/**
 * A placed object. Pre-M5 items carry only the first five fields (`builtin:*` assets); M5 adds the
 * product-grounded fields below, all optional so existing files stay valid and byte-stable.
 *
 * `assetId` is the id of the shape: `builtin:*` (legacy), `product:<provider>` (real provider model),
 * the library asset id (lookalike) or `param:<generator>` (parametric); see `meshAssetId`.
 *
 * Cross-field rules enforced when parsing (`checkItemRules` on the item, `Scene.superRefine` for generators):
 *  - `mount: 'floor'` with `elevation` other than 0 is INVALID (not normalised: a silent fix would hide
 *    a wrong value); wall and ceiling mounts take any elevation >= 0 (negative is invalid for them too);
 *  - `product.provider/sku` must equal `productRef` when both are present;
 *  - a `provider` mesh needs a `productRef` (or `product`);
 *  - a `parametric` mesh whose generator is REGISTERED (`GENERATORS`) must accept its params, and
 *    `dims ?? product.dims` must match `describeParams(params).dims` within 2% (min 1 mm); an UNKNOWN
 *    generator is skipped here and reported as the `unknown_generator` warning by `validateScene`.
 * Legacy items (`builtin:*`, no product) stay valid; `validateScene` warns `missing_product` for the others.
 */
export const ItemBase = z.strictObject({
  id: Id,
  assetId: Id,
  position: Vec2,
  elevation: z.number().default(0),
  /** Rotation around the vertical axis, degrees counter-clockwise seen from above. */
  rotation: z.number().default(0),
  roomId: Id.optional(),
  /** The real product this item stands for: provider and SKU. */
  productRef: ProductRef.optional(),
  /** Facts about the product when it was placed (price TTC, dims, link, date). No photos or 3D. */
  product: ProductSnapshot.optional(),
  /** Where the item is fixed. Absent = derived (the builtin asset's mount, else floor). */
  mount: ItemMount.optional(),
  /** Exact outer dimensions in metres; absent = `product.dims`, else the builtin asset's. */
  dims: Dims.optional(),
  /** Chosen variant: the variant SKU (or colour name) of the product. */
  variant: Sku.optional(),
  /** How the shape is obtained (provider model, library lookalike, parametric generator). */
  mesh: MeshSource.optional(),
  /** Free space wanted around the item (overrides the generator / category default). */
  clearance: Clearance.optional(),
  /**
   * Visual dressing the viewer draws with the product but that is not bought with it: a mattress, duvet and pillows on a
   * bed FRAME (shops sell frames without a mattress). Absent or true = dressed when the product is a bed frame; false = bare.
   * Never in the bill of materials.
   */
  dressing: z.boolean().optional(),
  /** Existing furniture the designer must plan around; only a user may move or remove it. */
  locked: z.boolean().optional(),
  /** The placement intent that put the item here (re-solved or validated when the room changes). */
  relation: Relation.optional(),
});

type ItemFields = Omit<z.infer<typeof ItemBase>, 'id'>;

/** Cross-field rules shared by `Item` and the `item.place` draft (where the id is optional). */
export function checkItemRules(item: ItemFields, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (item.mount === 'floor' && item.elevation !== 0) {
    issue(['elevation'], `a floor-mounted item must have elevation 0 (got ${item.elevation}); use mount "wall" or "ceiling" for raised items`);
  } else if ((item.mount === 'wall' || item.mount === 'ceiling') && item.elevation < 0) {
    issue(['elevation'], `a ${item.mount}-mounted item cannot have a negative elevation (${item.elevation})`);
  }
  if (item.productRef && item.product && (item.productRef.provider !== item.product.provider || item.productRef.sku !== item.product.sku)) {
    issue(['productRef'], `productRef ${item.productRef.provider}:${item.productRef.sku} does not match product ${item.product.provider}:${item.product.sku}`);
  }
  if (item.mesh?.kind === 'provider' && !item.productRef && !item.product) {
    issue(['mesh'], 'a "provider" mesh needs the productRef whose model to use');
  }
}

export const Item = ItemBase.superRefine(checkItemRules);
export type Item = z.infer<typeof Item>;

/** Most fixtures one `grid` light may stand for (a 10 x 10 grid); the limit keeps a hostile file cheap to draw. */
export const GRID_MAX_FIXTURES = 100;
/** Most rows (or columns) of a grid. */
export const GRID_MAX_SIDE = 20;

/** Where a light's lumen figure comes from: the retailer's product data, a category default, or typed by a user. */
export const LumensSource = z.enum(['product', 'estimated', 'user']);
export type LumensSource = z.infer<typeof LumensSource>;

const lightCommon = {
  id: Id.describe('Light id (1-64 chars), unique across all entities.'),
  name: NameString('Label.').optional(),
  roomId: Id.describe('Room id.').optional(),
  position: Vec2.describe('Plan [x, y] in metres (y down); a grid: its centre.'),
  /** Height of the light source above the floor. */
  elevation: z.number().nonnegative().describe('Height above the floor (m).'),
  kelvin: z.number().min(1000).max(12000).default(2700).describe('2700 warm, 6500 daylight.'),
  on: z.boolean().default(true).describe('Switched on.'),
  /**
   * Set on the light of a lamp item (floor lamp, pendant...): it follows that item. The pose is DERIVED from the item
   * (`linkedLightPose`) and kept in step by the item commands; never edit `position` / `elevation` / `roomId` of a linked light.
   */
  itemId: Id.describe('Lamp item this light follows. Set by the editor, not by you.').optional(),
  /** Offset of the bulb from the item origin: `[dx, dy]` in the item frame (metres, rotated with the item), `dz` above the item bottom. */
  offset: z.tuple([z.number(), z.number(), z.number()]).describe('Linked lights: [dx, dy, dz] of the bulb from the item origin (m).').optional(),
  lumensSource: LumensSource.describe('Origin of the lumens: product, estimated or user. Optional.').optional(),
};
const lumensField = z.number().nonnegative().describe('Lumens (60 W bulb about 800).');

export const Light = z.discriminatedUnion('type', [
  z.strictObject({ ...lightCommon, lumens: lumensField, type: z.literal('point').describe('Bulb.') }),
  z.strictObject({
    ...lightCommon,
    lumens: lumensField,
    type: z.literal('spot').describe('Downward cone.'),
    /** Full cone angle in degrees. Spots point straight down. */
    angle: z.number().min(1).max(179).default(60).describe('Cone angle, degrees. Default 60.'),
  }),
  z.strictObject({
    ...lightCommon,
    lumens: lumensField,
    type: z.literal('area').describe('Downward panel.'),
    /** Rectangular panel facing down; `width` runs along plan x before rotation. */
    width: z.number().positive().describe('Width (m, plan x).'),
    depth: z.number().positive().describe('Depth (m, plan y).'),
    rotation: z.number().default(0).describe('Degrees, counter-clockwise. Default 0.'),
  }),
  z.strictObject({
    ...lightCommon,
    type: z.literal('grid').describe('rows x cols identical LED downlights, edited as ONE light.'),
    rows: z.number().int().min(1).max(GRID_MAX_SIDE).describe('Rows, 1-20.'),
    cols: z.number().int().min(1).max(GRID_MAX_SIDE).describe('Columns, 1-20 (rows x cols at most 100).'),
    width: z.number().positive().describe('Width (m, plan x) the grid covers.'),
    depth: z.number().positive().describe('Depth (m, plan y) the grid covers.'),
    rotation: z.number().default(0).describe('Degrees, counter-clockwise. Default 0.'),
    lumensEach: z.number().nonnegative().describe('Lumens of EACH fixture (6 W LED about 450); total = rows x cols x lumensEach.'),
    angle: z.number().min(1).max(179).default(100).describe('Beam angle, degrees. Default 100.'),
  }),
]);
export type Light = z.infer<typeof Light>;
export type GridLight = Extract<Light, { type: 'grid' }>;
export type LinkableLight = Extract<Light, { type: 'point' | 'spot' }>;

/** Problems of one light that the field schemas cannot express (grid size). Empty when fine. */
export function lightIssues(light: Light): string[] {
  const out: string[] = [];
  if (light.type === 'grid' && light.rows * light.cols > GRID_MAX_FIXTURES) out.push(`a grid holds at most ${GRID_MAX_FIXTURES} fixtures (${light.rows} x ${light.cols} = ${light.rows * light.cols})`);
  if (light.itemId === undefined && light.offset !== undefined) out.push('offset needs itemId');
  if (light.itemId !== undefined && light.type !== 'point' && light.type !== 'spot') out.push('only point and spot lights can belong to an item');
  return out;
}


export const Site = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  northAngle: z.number().default(0),
  /** IANA time zone used to interpret local date/time, e.g. "Europe/Paris". */
  timezone: TimeZone.default('UTC'),
  /** Height of the flat's floor above street level, in metres (e.g. 2nd floor ≈ 5.8). */
  floorElevation: z.number().default(0),
  /** Postal address, used to fetch site context such as neighbouring buildings. */
  address: z.string().max(ADDRESS_MAX).transform(stripControlChars).optional(),
});
export type Site = z.infer<typeof Site>;

export const SceneBase = z.strictObject({
  version: z.literal(1),
  name: NameString(),
  units: z.literal('m').default('m'),
  site: Site,
  materials: z.array(Material).max(LIMITS.materials, `too many materials (max ${LIMITS.materials})`).default([]),
  /** Materials used when a wall side, floor or ceiling has none assigned. */
  defaults: z
    .strictObject({ wall: Id.optional(), floor: Id.optional(), ceiling: Id.optional() })
    .default({}),
  walls: z.array(Wall).min(1).max(LIMITS.walls, `too many walls (max ${LIMITS.walls})`),
  openings: z.array(Opening).max(LIMITS.openings, `too many openings (max ${LIMITS.openings})`).default([]),
  rooms: z.array(Room).max(LIMITS.rooms, `too many rooms (max ${LIMITS.rooms})`).default([]),
  items: z.array(Item).max(LIMITS.items, `too many items (max ${LIMITS.items})`).default([]),
  lights: z.array(Light).max(LIMITS.lights, `too many lights (max ${LIMITS.lights})`).default([]),
});

/**
 * Cross-reference checks run only once the structure is valid (Zod skips refinements
 * after structural errors), so a file may reveal reference errors after a first fix.
 */
export const Scene = SceneBase.superRefine((scene, ctx) => {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });

  const ids = new Map<string, string>();
  const collections = ['materials', 'walls', 'openings', 'rooms', 'items', 'lights'] as const;
  for (const key of collections) {
    scene[key].forEach((entity, index) => {
      const seen = ids.get(entity.id);
      if (seen) issue([key, index, 'id'], `duplicate id "${entity.id}" (already used in ${seen})`);
      else ids.set(entity.id, key);
    });
  }

  const materialIds = new Set(scene.materials.map((m) => m.id));
  const roomIds = new Set(scene.rooms.map((r) => r.id));
  const walls = new Map(scene.walls.map((w) => [w.id, w]));

  const checkMaterial = (id: string | undefined, path: (string | number)[]) => {
    if (id !== undefined && !materialIds.has(id)) issue(path, `unknown material "${id}"`);
  };
  const checkRoom = (id: string | undefined, path: (string | number)[]) => {
    if (id !== undefined && !roomIds.has(id)) issue(path, `unknown room "${id}"`);
  };

  scene.walls.forEach((wall, i) => {
    if (wallLength(wall) < EPSILON) issue(['walls', i], 'wall has zero length');
    checkMaterial(wall.finish.left, ['walls', i, 'finish', 'left']);
    checkMaterial(wall.finish.right, ['walls', i, 'finish', 'right']);
    for (const [roomId, sides] of Object.entries(wall.roomFinishes ?? {})) {
      checkRoom(roomId, ['walls', i, 'roomFinishes', roomId]);
      checkMaterial(sides.left, ['walls', i, 'roomFinishes', roomId, 'left']);
      checkMaterial(sides.right, ['walls', i, 'roomFinishes', roomId, 'right']);
    }
  });

  const spansByWall = new Map<string, { index: number; from: number; to: number }[]>();
  scene.openings.forEach((opening, i) => {
    const wall = walls.get(opening.wallId);
    if (!wall) {
      issue(['openings', i, 'wallId'], `unknown wall "${opening.wallId}"`);
      return;
    }
    const length = wallLength(wall);
    const from = opening.offset - opening.width / 2;
    const to = opening.offset + opening.width / 2;
    if (from < -EPSILON || to > length + EPSILON) {
      issue(
        ['openings', i, 'offset'],
        `opening spans ${from.toFixed(2)}–${to.toFixed(2)} m but wall "${wall.id}" is ${length.toFixed(2)} m long`,
      );
    }
    if (opening.sill + opening.height > wall.height + EPSILON) {
      issue(
        ['openings', i, 'height'],
        `opening top (${(opening.sill + opening.height).toFixed(2)} m) is above wall height (${wall.height} m)`,
      );
    }
    const spans = spansByWall.get(wall.id) ?? [];
    spans.push({ index: i, from, to });
    spansByWall.set(wall.id, spans);
  });
  for (const spans of spansByWall.values()) {
    spans.sort((a, b) => a.from - b.from);
    for (let k = 1; k < spans.length; k++) {
      const prev = spans[k - 1]!;
      const cur = spans[k]!;
      if (cur.from < prev.to - EPSILON) {
        issue(
          ['openings', cur.index, 'offset'],
          `overlaps opening "${scene.openings[prev.index]!.id}" on the same wall`,
        );
      }
    }
  }

  checkMaterial(scene.defaults.wall, ['defaults', 'wall']);
  checkMaterial(scene.defaults.floor, ['defaults', 'floor']);
  checkMaterial(scene.defaults.ceiling, ['defaults', 'ceiling']);

  scene.rooms.forEach((room, i) => {
    if (polygonArea(room.polygon) < EPSILON) issue(['rooms', i, 'polygon'], 'room polygon has zero area');
    else if (!isSimplePolygon(room.polygon)) issue(['rooms', i, 'polygon'], 'room polygon intersects itself');
    checkMaterial(room.wallFinish, ['rooms', i, 'wallFinish']);
    checkMaterial(room.floorMaterial, ['rooms', i, 'floorMaterial']);
    checkMaterial(room.ceilingMaterial, ['rooms', i, 'ceilingMaterial']);
    room.floorZones?.forEach((zone, k) => checkMaterial(zone.material, ['rooms', i, 'floorZones', k, 'material']));
    if (room.floorZones?.length && polygonArea(room.polygon) >= EPSILON && isSimplePolygon(room.polygon)) {
      for (const p of zoneProblems(room.polygon, room.floorZones)) issue(['rooms', i, 'floorZones', p.index, p.field], p.message);
    }
  });
  scene.items.forEach((item, i) => {
    checkRoom(item.roomId, ['items', i, 'roomId']);
    if (item.mesh?.kind === 'parametric') {
      const check = checkParametricMesh(item.mesh, item.dims ?? item.product?.dims);
      if (check.status === 'invalid_params') issue(['items', i, 'mesh', 'params'], `generator "${check.generator}" rejects the params: ${check.issues.join('; ')}`);
      else if (check.status === 'dims_mismatch') {
        const f = (d: { w: number; d: number; h: number }) => `${d.w} x ${d.d} x ${d.h} m`;
        issue(['items', i, 'dims'], `dims ${f(check.actual)} differ by more than 2% from generator "${check.generator}" (${f(check.expected)})`);
      }
    }
  });
  const itemIds = new Set(scene.items.map((it) => it.id));
  const linked = new Set<string>();
  scene.lights.forEach((light, i) => {
    checkRoom(light.roomId, ['lights', i, 'roomId']);
    for (const message of lightIssues(light)) issue(['lights', i], message);
    if (light.itemId !== undefined) {
      if (!itemIds.has(light.itemId)) issue(['lights', i, 'itemId'], `unknown item "${light.itemId}"`);
      else if (linked.has(light.itemId)) issue(['lights', i, 'itemId'], `item "${light.itemId}" already has a light`);
      linked.add(light.itemId);
    }
  });
});
export type Scene = z.infer<typeof Scene>;
/** Scene as written in a `.flat.json` file, before defaults are applied. */
export type SceneInput = z.input<typeof Scene>;

export function wallLength(wall: Pick<Wall, 'start' | 'end'>): number {
  return Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
}

/**
 * Unit normal pointing to the wall's "left" side: the left of someone walking from
 * `start` to `end` on the plan as drawn (y down), i.e. `(dy, -dx) / length`.
 * Example: a wall drawn left-to-right has its left side facing up the page (-y).
 */
export function wallLeftNormal(wall: Pick<Wall, 'start' | 'end'>): Vec2 {
  const length = wallLength(wall);
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  return [dy / length, -dx / length];
}

/** Texture set reference: a library slug, `lib:<slug>` (e.g. `lib:oak-parquet`). Nothing else is accepted. */
export function isTextureUrl(url: string): boolean {
  return /^lib:[a-z0-9][a-z0-9-]*$/.test(url);
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
