import { ALL_RULES, checkSubject, layoutContext, pointInPolygon, validateLayout } from '@flat/scene';
import type { Dims, ItemMount, LayoutContext, Scene, Vec2, Violation } from '@flat/scene';

/** What is being placed or moved, as far as the validity check cares. */
export interface GhostSubject {
  /** Existing item being moved (its own box is not an obstacle to itself). */
  id?: string;
  dims: Dims;
  mount: ItemMount;
  weightKg?: number;
}

export interface GhostPose {
  position: Vec2;
  rotation: number;
  elevation: number;
}

export interface GhostVerdict {
  valid: boolean;
  roomId?: string;
  /** The first violation, written for the user (shown next to the cursor). */
  message?: string;
  violations: Violation[];
  warnings: Violation[];
}

const ROOM_TOLERANCE = 0.003;
/** Id of the temporary item in the full check. */
export const GHOST_ID = '__ghost__';

const contexts = new WeakMap<Scene, LayoutContext>();
function contextOf(scene: Scene): LayoutContext {
  let c = contexts.get(scene);
  if (!c) contexts.set(scene, (c = layoutContext(scene)));
  return c;
}

export const roomAt = (scene: Scene, p: Vec2): string | undefined => scene.rooms.find((r) => pointInPolygon(p, r.polygon, ROOM_TOLERANCE))?.id;

/** Floor-to-ceiling height of the room at a plan point (the room's own, else the lowest wall, else 2.5 m). */
export function ceilingAt(scene: Scene, p: Vec2): number {
  const room = scene.rooms.find((r) => pointInPolygon(p, r.polygon, ROOM_TOLERANCE));
  if (room?.ceilingHeight !== undefined) return room.ceilingHeight;
  const lowest = Math.min(...scene.walls.map((w) => w.height ?? 2.5));
  return Number.isFinite(lowest) ? lowest : 2.5;
}

/** A heavy wall mount on a partition only warns (the user may accept it); everything else blocks. */
function split(all: Violation[], warnings: Violation[]): { violations: Violation[]; warnings: Violation[] } {
  return { violations: all.filter((v) => v.code !== 'heavy_mount_partition'), warnings: [...warnings, ...all.filter((v) => v.code === 'heavy_mount_partition')] };
}

function verdict(roomId: string | undefined, violations: Violation[], warnings: Violation[]): GhostVerdict {
  return {
    valid: violations.length === 0,
    ...(roomId !== undefined ? { roomId } : {}),
    ...(violations[0] ? { message: violations[0].message } : {}),
    violations,
    warnings,
  };
}

/**
 * Cheap validity of a pose, run on every pointer move: inside a room, no overlap with walls or items, door
 * swings, window and glazing clearance, heavy wall mounts (`checkSubject` with every cheap rule).
 */
export function checkGhost(scene: Scene, subject: GhostSubject, pose: GhostPose): GhostVerdict {
  const roomId = roomAt(scene, pose.position);
  if (roomId === undefined) {
    return verdict(undefined, [{ code: 'outside_room', message: 'Outside every room: drop it inside a room.', entityIds: [], hint: 'Move the pointer over a room floor.' }], []);
  }
  const r = checkSubject(
    contextOf(scene),
    { ...(subject.id !== undefined ? { id: subject.id } : {}), roomId, position: pose.position, rotation: pose.rotation, elevation: pose.elevation, dims: subject.dims, mount: subject.mount, ...(subject.weightKg !== undefined ? { weightKg: subject.weightKg } : {}) },
    ALL_RULES,
  );
  const s = split(r.violations, r.warnings);
  return verdict(roomId, s.violations, s.warnings);
}

/**
 * The full check, run when the pointer rests and on release: the cheap checks plus the room walkway analysis of
 * `validateLayout`, on the scene as it would be with the item at `pose`. Only findings that involve the item count.
 */
export function fullGhostCheck(scene: Scene, subject: GhostSubject, pose: GhostPose, draftMeta: { assetId: string }): GhostVerdict {
  const cheap = checkGhost(scene, subject, pose);
  if (!cheap.valid || cheap.roomId === undefined) return cheap;
  const id = subject.id ?? GHOST_ID;
  const item = {
    id,
    assetId: draftMeta.assetId,
    position: pose.position,
    rotation: pose.rotation,
    elevation: pose.elevation,
    roomId: cheap.roomId,
    mount: subject.mount,
    dims: subject.dims,
  };
  const items = subject.id !== undefined ? scene.items.map((i) => (i.id === subject.id ? { ...i, ...item } : i)) : [...scene.items, item];
  let report;
  let base;
  try {
    report = validateLayout({ ...scene, items }, { roomId: cheap.roomId });
    base = validateLayout(scene, { roomId: cheap.roomId });
  } catch {
    return cheap; // never let a checker failure block editing
  }
  const mine = (v: Violation) => v.entityIds.includes(id);
  const walkways = (r: { violations: Violation[] }) => r.violations.filter((v) => v.code === 'walkway_too_narrow');
  // a walkway finding is the room's, not the item's: it counts only when this item makes it appear
  const newWalkway = walkways(report).length > walkways(base).length ? walkways(report).slice(0, 1) : [];
  const extra = [...report.violations.filter((v) => mine(v) && v.code !== 'walkway_too_narrow'), ...newWalkway];
  const seen = new Set(cheap.violations.map((v) => v.message));
  const s = split([...cheap.violations, ...extra.filter((v) => !seen.has(v.message))], [...cheap.warnings, ...report.warnings.filter(mine)]);
  return verdict(cheap.roomId, s.violations, s.warnings);
}

/** Colour of the ghost for a verdict. */
export const GHOST_VALID_COLOR = '#2e9e5b';
export const GHOST_INVALID_COLOR = '#d64545';
export const ghostColor = (v: Pick<GhostVerdict, 'valid'>): string => (v.valid ? GHOST_VALID_COLOR : GHOST_INVALID_COLOR);
