import { z } from 'zod';
import { isSimplePolygon, polygonArea } from './measure';

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
} as const;

export const Vec2 = z.tuple([z.number(), z.number()]);
export type Vec2 = z.infer<typeof Vec2>;

/** Entity id: 1-64 characters. The same bound applies wherever an id is defined or referenced. */
export const EntityId = z.string().min(1).max(64);
const Id = EntityId;
/** Maximum length of human-readable names. */
export const NAME_MAX = 120;
/** Maximum length of the postal address. */
export const ADDRESS_MAX = 300;
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a hex colour like #a1b2c3');
const TimeZone = z.string().refine(isTimeZone, 'unknown IANA time zone');

export const Material = z
  .strictObject({
    id: Id.describe('Material id (1-64 characters), unique across all entities. Reference it from finishes and defaults.'),
    name: z.string().max(NAME_MAX).describe('Human-readable name, at most 120 characters.'),
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

export const Room = z.strictObject({
  id: Id,
  name: z.string().max(NAME_MAX),
  type: RoomType,
  polygon: z.array(Vec2).min(3).max(LIMITS.polygonVertices, `too many polygon vertices (max ${LIMITS.polygonVertices})`),
  /**
   * Finish of this room's wall faces. Applies to the stretches of wall faces that border this room
   * unless the wall has a room-scoped or whole-side `finish` for that side (see `wallFaceMaterial`).
   */
  wallFinish: Id.optional(),
  floorMaterial: Id.optional(),
  ceilingMaterial: Id.optional(),
  /** Floor-to-ceiling height; defaults to the lowest wall bounding the room. */
  ceilingHeight: z.number().positive().optional(),
});
export type Room = z.infer<typeof Room>;

export const Item = z.strictObject({
  id: Id,
  assetId: Id,
  position: Vec2,
  elevation: z.number().default(0),
  /** Rotation around the vertical axis, degrees counter-clockwise seen from above. */
  rotation: z.number().default(0),
  roomId: Id.optional(),
});
export type Item = z.infer<typeof Item>;

const lightBase = {
  id: Id.describe('Light id (1-64 characters), unique across all entities.'),
  name: z.string().max(NAME_MAX).describe('Optional label, at most 120 characters.').optional(),
  roomId: Id.describe('Room the light belongs to (from list_rooms). Optional.').optional(),
  position: Vec2.describe('Plan position [x, y] in metres; plan y grows down the page.'),
  /** Height of the light source above the floor. */
  elevation: z.number().nonnegative().describe('Height of the light source above the floor, in metres.'),
  lumens: z.number().nonnegative().describe('Luminous flux in lumens (a 60 W-equivalent bulb is about 800).'),
  kelvin: z.number().min(1000).max(12000).default(2700).describe('Colour temperature in kelvin, 1000-12000 (2700 warm, 6500 daylight). Defaults to 2700.'),
  on: z.boolean().default(true).describe('Whether the light is switched on. Defaults to true.'),
};

export const Light = z.discriminatedUnion('type', [
  z.strictObject({ ...lightBase, type: z.literal('point').describe('A point light radiates in all directions. Discriminator: "point".') }),
  z.strictObject({
    ...lightBase,
    type: z.literal('spot').describe('A spot light shines straight down in a cone. Discriminator: "spot".'),
    /** Full cone angle in degrees. Spots point straight down. */
    angle: z.number().min(1).max(179).default(60).describe('Spot cone angle in degrees (1-179). Defaults to 60.'),
  }),
  z.strictObject({
    ...lightBase,
    type: z.literal('area').describe('A rectangular panel facing down. Discriminator: "area".'),
    /** Rectangular panel facing down; `width` runs along plan x before rotation. */
    width: z.number().positive().describe('Panel width in metres along plan x before rotation.'),
    depth: z.number().positive().describe('Panel depth in metres along plan y before rotation.'),
    rotation: z.number().default(0).describe('Panel rotation in degrees, counter-clockwise seen from above. Defaults to 0.'),
  }),
]);
export type Light = z.infer<typeof Light>;

export const Site = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  northAngle: z.number().default(0),
  /** IANA time zone used to interpret local date/time, e.g. "Europe/Paris". */
  timezone: TimeZone.default('UTC'),
  /** Height of the flat's floor above street level, in metres (e.g. 2nd floor ≈ 5.8). */
  floorElevation: z.number().default(0),
  /** Postal address, used to fetch site context such as neighbouring buildings. */
  address: z.string().max(ADDRESS_MAX).optional(),
});
export type Site = z.infer<typeof Site>;

export const SceneBase = z.strictObject({
  version: z.literal(1),
  name: z.string().max(NAME_MAX),
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
  });
  scene.items.forEach((item, i) => checkRoom(item.roomId, ['items', i, 'roomId']));
  scene.lights.forEach((light, i) => checkRoom(light.roomId, ['lights', i, 'roomId']));
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
