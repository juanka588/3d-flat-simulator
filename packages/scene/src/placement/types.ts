import { z } from 'zod';
import type { Scene } from '../schema';
import { Clearance, Dims, EntityId, ItemMount, Vec2 } from '../primitives';

/**
 * Placement contracts (M5.0, implemented by lane B / story M5.9 and consumed by the MCP tools of
 * lane E and the UI drag of lane F). Units: metres and degrees; plan y grows down; item frame and
 * rotation as in `assets/builtin.ts` (front = local +z, at rotation 0 it faces plan +y).
 *
 * A `Relation` states WHERE an item goes in words a designer uses ("against the north wall", "in the
 * corner", "facing the bed"). It is stored on the item (`Item.relation`) so the intent survives, and
 * the solver turns it into a concrete `Placement` (position, rotation, elevation) or explains why not.
 */

const Id = EntityId;
const Gap = z.number().min(0).max(2).describe('Free gap in metres between the item and what it touches (default 0).');

/** Item flush with a wall: the back (local -z) towards the wall face, facing into the room. */
const AgainstWall = z.strictObject({
  kind: z.literal('against_wall'),
  wallId: Id.describe('Wall to stand against (walls[].wallId from describe_room).'),
  roomId: Id.optional().describe('Room on the wall side to use when a wall borders two rooms (rooms[].id).'),
  align: z.enum(['start', 'center', 'end']).default('center').describe('Where along the wall, seen from the room: its start end, its middle, or its end.'),
  offset: z.number().min(0).default(0).describe('Metres from the aligned end of the wall to the nearest edge of the item (ignored for "center").'),
  gap: Gap.default(0),
});

/** Item tucked into a room corner (two walls), back to the longer wall unless `faceWall` says otherwise. */
const InCorner = z.strictObject({
  kind: z.literal('in_corner'),
  roomId: Id.describe('Room whose corner to use (rooms[].id).'),
  corner: z.number().int().min(0).describe('Index of the room polygon vertex (rooms[].polygon order); 0 is the first vertex.'),
  gap: Gap.default(0),
});

/** Item centred in a room (or on one plan axis of it); the front faces `facing` when given. */
const CenteredIn = z.strictObject({
  kind: z.literal('centered_in'),
  roomId: Id.describe('Room to centre in (rooms[].id).'),
  axis: z.enum(['both', 'x', 'y']).default('both').describe('Centre on both plan axes, or only on x / y (the other coordinate is then kept).'),
});

/** Item turned to face another entity (its front points at that entity's centre). Rotation only. */
const Facing = z.strictObject({
  kind: z.literal('facing'),
  targetId: Id.describe('Entity to face: an item id, an opening id, a wall id or a room id.'),
});

/** Item beside another item, in the other item's frame (a bedside table left of the bed). */
const NextTo = z.strictObject({
  kind: z.literal('next_to'),
  itemId: Id.describe('The existing item to stand next to (items[].id).'),
  side: z.enum(['left', 'right', 'front', 'back']).describe('Side of that item, as seen from its front.'),
  gap: Gap.default(0.02),
  align: z.enum(['start', 'center', 'end']).default('center').describe('Alignment along that side: start, middle or end.'),
});

/** Item under a window, against the same wall; only items lower than the sill are allowed. */
const UnderWindow = z.strictObject({
  kind: z.literal('under_window'),
  openingId: Id.describe('Window (openings[].id) to stand under.'),
  gap: Gap.default(0),
});

/** Explicit position (the user's drag, or a solver result being stored). */
const AtPosition = z.strictObject({
  kind: z.literal('at'),
  position: Vec2.describe('Plan position [x, y] of the item origin (footprint centre).'),
  rotation: z.number().default(0).describe('Degrees counter-clockwise seen from above.'),
  elevation: z.number().min(0).default(0).describe('Height of the item bottom above the floor, in metres.'),
});

export const Relation = z.discriminatedUnion('kind', [AgainstWall, InCorner, CenteredIn, Facing, NextTo, UnderWindow, AtPosition]);
export type Relation = z.infer<typeof Relation>;
export type RelationInput = z.input<typeof Relation>;
export type RelationKind = Relation['kind'];

/** What to place. The item is either new or an existing one being moved (`itemId`). */
export const PlacementRequest = z.strictObject({
  roomId: Id.describe('Room to place in (rooms[].id from list_rooms).'),
  /** Existing item to move; its own footprint is not an obstacle to itself. Absent for a new item. */
  itemId: Id.optional(),
  dims: Dims.describe('Exact outer dimensions of the item (from the product record).'),
  mount: ItemMount.default('floor'),
  /** Wall / ceiling mounts: height of the item bottom above the floor. Floor items are always at 0. */
  elevation: z.number().min(0).max(10).optional(),
  weightKg: z.number().positive().max(2000).optional().describe('Weight; wall mounts above 15 kg are only allowed on structural walls.'),
  clearance: Clearance.optional(),
  relation: Relation,
  /** Extra rotation applied after the relation, in degrees (usually 0: relations already set the facing). */
  rotation: z.number().optional(),
  /** Acknowledge a `heavy_mount_partition` warning (heavy wall mount on a non-structural wall). */
  acknowledgeHeavyPartition: z.boolean().default(false),
  /** How many alternative placements to return when the request fails. */
  maxCandidates: z.number().int().min(0).max(10).default(3),
});
export type PlacementRequest = z.infer<typeof PlacementRequest>;
export type PlacementRequestInput = z.input<typeof PlacementRequest>;

export const VIOLATION_CODES = [
  'outside_room',
  'overlap',
  'door_swing_blocked',
  'window_blocked',
  'glazing_blocked',
  'walkway_too_narrow',
  'heavy_mount_partition',
  'locked_item',
  'invalid_relation',
  'dims_mismatch',
] as const;
export const ViolationCode = z.enum(VIOLATION_CODES);
export type ViolationCode = z.infer<typeof ViolationCode>;

/** A broken rule, with the entities involved and what to try instead. */
export const Violation = z.strictObject({
  code: ViolationCode,
  message: z.string(),
  /** Scene entities in the way (items, walls, openings, rooms). */
  entityIds: z.array(z.string()),
  /** What to change: "move it 0.3 m east", "pick a narrower product", ... */
  hint: z.string(),
});
export type Violation = z.infer<typeof Violation>;

/** Default hint per code, for implementations that have nothing more specific. */
export const VIOLATION_HINTS: Readonly<Record<ViolationCode, string>> = {
  outside_room: 'Keep the whole footprint inside the room; pick another wall, a smaller product or call get_placement_options.',
  overlap: 'The footprint overlaps another item or a wall; move it clear of the entities listed.',
  door_swing_blocked: 'The item would block a door from opening; keep the quarter-circle swung by the door leaf clear.',
  window_blocked: 'The item is taller than the window sill; use a lower product or another wall.',
  glazing_blocked: 'Wall-mounted items cannot hang on a glazed opening; choose a solid stretch of wall.',
  walkway_too_narrow: 'Leave at least 0.8 m free for walking (0.9 m at the entry); move the item or remove another.',
  heavy_mount_partition: 'Heavy wall mounts (over 15 kg) belong on structural walls; pick one, or set acknowledgeHeavyPartition to accept the risk.',
  locked_item: 'The item is locked (existing furniture); plan around it instead of moving it.',
  invalid_relation: 'The relation refers to something that does not exist or cannot hold; check the ids and the side.',
  dims_mismatch: 'The item dimensions differ from the product / generator dimensions by more than 2%; use the product dimensions.',
};

/** A concrete spot for the item. */
export const Placement = z.strictObject({
  roomId: Id,
  position: Vec2,
  /** Degrees counter-clockwise seen from above. */
  rotation: z.number(),
  elevation: z.number().min(0),
  /** The relation that produced it (re-stored on the item so the intent survives). */
  relation: Relation,
});
export type Placement = z.infer<typeof Placement>;

export type PlacementResult =
  | {
      ok: true;
      placement: Placement;
      /** Why this spot, in order, one short sentence each ("against the north wall", "centred on the bed"). */
      rationale: string[];
      /** Soft problems that did not block the placement (e.g. an acknowledged `heavy_mount_partition`). */
      warnings: Violation[];
    }
  | {
      ok: false;
      violations: Violation[];
      /** Up to `maxCandidates` alternative valid placements, best first (may be empty). */
      candidates: Placement[];
    };

/** Result of `validateLayout`: every rule checked over the placed items of a room (or all rooms). */
export interface LayoutReport {
  /** The room checked; absent = every room. */
  roomId?: string;
  /** No violations (warnings are allowed). */
  ok: boolean;
  violations: Violation[];
  warnings: Violation[];
  /** Items considered. */
  itemCount: number;
  /** Smallest free walking width found in metres, when measurable. */
  minWalkwayM?: number;
  /** Free floor area in m2 after items, when measurable. */
  freeFloorM2?: number;
}

/** Minimum free walking width, in metres (D7). */
export const WALKWAY_MIN_M = 0.8;
/** Minimum free width at the flat entry, in metres (D7). */
export const WALKWAY_MIN_ENTRY_M = 0.9;

const NOT_IMPLEMENTED = 'not implemented: M5 lane B (story M5.9)';

/**
 * Resolves a placement request against the scene: hard constraints from D7 (inside the room, no
 * overlap, door swings, window clearance, glazing, heavy mounts, walkways, locked items). Pure and
 * deterministic. STUB until lane B: throws.
 */
export function solvePlacement(scene: Scene, request: PlacementRequestInput): PlacementResult {
  void scene;
  void request;
  throw new Error(NOT_IMPLEMENTED);
}

/** Checks every placed item of `roomId` (or of all rooms) against the same rules. STUB until lane B: throws. */
export function validateLayout(scene: Scene, options: { roomId?: string } = {}): LayoutReport {
  void scene;
  void options;
  throw new Error(NOT_IMPLEMENTED);
}
