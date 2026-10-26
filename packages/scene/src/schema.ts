import { z } from 'zod';

/**
 * Scene JSON: the single source of truth for a flat.
 *
 * Conventions:
 * - Units are metres; angles are degrees.
 * - Plan coordinates are 2D `[x, y]` as drawn on a blueprint (y grows "down" the page).
 *   World mapping: X = x, Z = y, Y = up.
 * - Walls are defined by their centreline; room polygons follow wall centrelines too.
 * - `site.northAngle` is the clockwise angle from plan "up" (-y) to true north.
 */

export const Vec2 = z.tuple([z.number(), z.number()]);
export type Vec2 = z.infer<typeof Vec2>;

const Id = z.string().min(1);
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a hex colour like #a1b2c3');

export const Material = z.object({
  id: Id,
  name: z.string(),
  kind: z.enum(['paint', 'texture']),
  color: HexColor,
  roughness: z.number().min(0).max(1).default(0.9),
  /** Base URL of a PBR texture set (M3+). */
  textureUrl: z.string().optional(),
  /** Texture tile size in metres. */
  textureScale: z.number().positive().optional(),
});
export type Material = z.infer<typeof Material>;

export const Wall = z.object({
  id: Id,
  start: Vec2,
  end: Vec2,
  thickness: z.number().positive().default(0.1),
  height: z.number().positive().default(2.6),
  /** Material per side. `left`/`right` are relative to walking from start to end. */
  finish: z
    .object({ left: Id.optional(), right: Id.optional() })
    .default({}),
});
export type Wall = z.infer<typeof Wall>;

export const Opening = z.object({
  id: Id,
  wallId: Id,
  type: z.enum(['door', 'window']),
  /** Distance along the wall from `start` to the opening's centre. */
  offset: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
  /** Height of the opening's bottom edge above the floor (0 for doors). */
  sill: z.number().nonnegative().default(0),
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

export const Room = z.object({
  id: Id,
  name: z.string(),
  type: RoomType,
  polygon: z.array(Vec2).min(3),
  floorMaterial: Id.optional(),
  ceilingMaterial: Id.optional(),
});
export type Room = z.infer<typeof Room>;

export const Item = z.object({
  id: Id,
  assetId: Id,
  position: Vec2,
  elevation: z.number().default(0),
  /** Rotation around the vertical axis, degrees counter-clockwise seen from above. */
  rotation: z.number().default(0),
  roomId: Id.optional(),
});
export type Item = z.infer<typeof Item>;

const LightBase = z.object({
  id: Id,
  name: z.string().optional(),
  roomId: Id.optional(),
  position: Vec2,
  /** Height of the light source above the floor. */
  elevation: z.number(),
  lumens: z.number().nonnegative(),
  kelvin: z.number().min(1000).max(12000).default(2700),
  on: z.boolean().default(true),
});

export const Light = z.discriminatedUnion('type', [
  LightBase.extend({ type: z.literal('point') }),
  LightBase.extend({
    type: z.literal('spot'),
    /** Full cone angle in degrees. Spots point straight down. */
    angle: z.number().min(1).max(179).default(60),
  }),
  LightBase.extend({
    type: z.literal('area'),
    width: z.number().positive(),
    depth: z.number().positive(),
  }),
]);
export type Light = z.infer<typeof Light>;

export const Site = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  northAngle: z.number().default(0),
  /** IANA time zone used to interpret local date/time, e.g. "Europe/Paris". */
  timezone: z.string().default('UTC'),
});
export type Site = z.infer<typeof Site>;

export const SceneBase = z.object({
  version: z.literal(1),
  name: z.string(),
  units: z.literal('m').default('m'),
  site: Site,
  materials: z.array(Material).default([]),
  walls: z.array(Wall),
  openings: z.array(Opening).default([]),
  rooms: z.array(Room).default([]),
  items: z.array(Item).default([]),
  lights: z.array(Light).default([]),
});

export const Scene = SceneBase.superRefine((scene, ctx) => {
  const ids = new Map<string, string>();
  const collections = ['materials', 'walls', 'openings', 'rooms', 'items', 'lights'] as const;
  for (const key of collections) {
    scene[key].forEach((entity, index) => {
      const seen = ids.get(entity.id);
      if (seen) {
        ctx.addIssue({
          code: 'custom',
          path: [key, index, 'id'],
          message: `duplicate id "${entity.id}" (already used in ${seen})`,
        });
      } else {
        ids.set(entity.id, key);
      }
    });
  }

  const materialIds = new Set(scene.materials.map((m) => m.id));
  const roomIds = new Set(scene.rooms.map((r) => r.id));
  const walls = new Map(scene.walls.map((w) => [w.id, w]));

  const checkMaterial = (id: string | undefined, path: (string | number)[]) => {
    if (id !== undefined && !materialIds.has(id)) {
      ctx.addIssue({ code: 'custom', path, message: `unknown material "${id}"` });
    }
  };
  const checkRoom = (id: string | undefined, path: (string | number)[]) => {
    if (id !== undefined && !roomIds.has(id)) {
      ctx.addIssue({ code: 'custom', path, message: `unknown room "${id}"` });
    }
  };

  scene.walls.forEach((wall, i) => {
    if (wallLength(wall) === 0) {
      ctx.addIssue({ code: 'custom', path: ['walls', i], message: 'wall has zero length' });
    }
    checkMaterial(wall.finish.left, ['walls', i, 'finish', 'left']);
    checkMaterial(wall.finish.right, ['walls', i, 'finish', 'right']);
  });

  scene.openings.forEach((opening, i) => {
    const wall = walls.get(opening.wallId);
    if (!wall) {
      ctx.addIssue({
        code: 'custom',
        path: ['openings', i, 'wallId'],
        message: `unknown wall "${opening.wallId}"`,
      });
      return;
    }
    const length = wallLength(wall);
    const from = opening.offset - opening.width / 2;
    const to = opening.offset + opening.width / 2;
    if (from < 0 || to > length) {
      ctx.addIssue({
        code: 'custom',
        path: ['openings', i, 'offset'],
        message: `opening spans ${from.toFixed(2)}–${to.toFixed(2)} m but wall "${wall.id}" is ${length.toFixed(2)} m long`,
      });
    }
    if (opening.sill + opening.height > wall.height) {
      ctx.addIssue({
        code: 'custom',
        path: ['openings', i, 'height'],
        message: `opening top (${(opening.sill + opening.height).toFixed(2)} m) is above wall height (${wall.height} m)`,
      });
    }
  });

  scene.rooms.forEach((room, i) => {
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
