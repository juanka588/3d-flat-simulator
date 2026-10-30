import { roomSideFinish } from '../geometry/materials';
import { analyzeRoomWallSides, wallFaceRooms } from '../geometry/room-sides';
import { zoneProblems } from '../geometry/zones';
import { fitGridToRoom, GRID_DROP_M } from '../lighting/lamps';
import { roomCeilingHeight } from '../geometry/floors';
import { LIMITS, Light, Scene, lightIssues, wallLength, type Cornice, type FloorZone, type Light as LightT, type Material, type Panelling, type Room, type Wall } from '../schema';
import { isDefaultStructural, isStructural } from '../structural';
import { canCutOpening, canRemoveWall } from './guards';
import { applyItemCommand, isItemCommand } from './items';
import { parseCommand } from './parse';
import type { Author, BatchCommand, Command, CommandEnvelope, LeafCommand } from './schema';
import { deepEqual, err, unknownIdHint, type CommandError } from './util';

export interface ApplyWarning {
  /** Reserved: no longer emitted. Room paint now converts shared-side finishes instead of overriding. */
  code: 'shared_wall_side_override';
  path: string;
  message: string;
}

/** Entities touched by a command, as ids (deduplicated, in first-touched order). */
export interface Changed {
  materials: string[];
  walls: string[];
  rooms: string[];
  lights: string[];
  /** Ids of items placed, moved, rotated, re-varianted or removed. Absent when no item was touched. */
  items?: string[];
  site: boolean;
  defaults: boolean;
}

export type ApplyOk = {
  ok: true;
  scene: Scene;
  /** Command that restores the exact previous scene. An empty batch when nothing changed. */
  inverse: Command;
  changed: Changed;
  warnings: ApplyWarning[];
  /** Present (true) when the command changed nothing. */
  noop?: true;
};
export type ApplyFail = { ok: false; errors: CommandError[] };
export type ApplyResult = ApplyOk | ApplyFail;

export interface ApplyOptions {
  /** Current scene revision, checked against `envelope.ifRev`. */
  rev?: number;
  /**
   * Internal: set by history when re-applying an entry it recorded itself (undo / redo). Skips the
   * external size caps (a batch may hold more than 500 commands; inverses of valid batches can) and the
   * author permission rules (restoring an earlier state is always allowed), while every payload is still
   * validated. Never set it for commands that come from outside.
   */
  trusted?: boolean;
}

/** Who is applying the command; some rules depend on it. */
export interface ReduceContext {
  author: Author;
  /** See `ApplyOptions.trusted`. */
  trusted?: boolean;
}

type Outcome =
  | { ok: true; scene: Scene; inverse: LeafCommand[]; changed: Changed; warnings: ApplyWarning[] }
  | ApplyFail;

const emptyChanged = (): Changed => ({ materials: [], walls: [], rooms: [], lights: [], site: false, defaults: false });
const noop = (scene: Scene): Outcome => ({ ok: true, scene, inverse: [], changed: emptyChanged(), warnings: [] });
const fail = (...errors: CommandError[]): ApplyFail => ({ ok: false, errors });
const touch = (key: 'materials' | 'walls' | 'rooms' | 'lights' | 'items', ...ids: string[]): Changed => ({ ...emptyChanged(), [key]: ids });

function mergeChanged(a: Changed, b: Changed): Changed {
  const u = (x: string[], y: string[]) => [...new Set([...x, ...y])];
  return {
    materials: u(a.materials, b.materials),
    walls: u(a.walls, b.walls),
    rooms: u(a.rooms, b.rooms),
    lights: u(a.lights, b.lights),
    ...(a.items || b.items ? { items: u(a.items ?? [], b.items ?? []) } : {}),
    site: a.site || b.site,
    defaults: a.defaults || b.defaults,
  };
}

function replaceAt<T>(list: readonly T[], index: number, item: T): T[] {
  const out = list.slice();
  out[index] = item;
  return out;
}

const allIds = (scene: Scene): Set<string> =>
  new Set([...scene.materials, ...scene.walls, ...scene.openings, ...scene.rooms, ...scene.items, ...scene.lights].map((e) => e.id));

function checkMaterial(scene: Scene, id: string | null | undefined, path: string): CommandError | undefined {
  if (id === null || id === undefined || scene.materials.some((m) => m.id === id)) return undefined;
  return err('unknown_material', path, `unknown material "${id}"`, unknownIdHint(id, scene.materials.map((m) => m.id), 'material') + '; define it first with material.define');
}

function findWall(scene: Scene, id: string): { wall: Wall; index: number } | CommandError {
  const index = scene.walls.findIndex((w) => w.id === id);
  if (index < 0) return err('unknown_entity', 'wallId', `unknown wall "${id}"`, unknownIdHint(id, scene.walls.map((w) => w.id), 'wall'));
  return { wall: scene.walls[index]!, index };
}

function findRoom(scene: Scene, id: string): { room: Room; index: number } | CommandError {
  const index = scene.rooms.findIndex((r) => r.id === id);
  if (index < 0) return err('unknown_entity', 'roomId', `unknown room "${id}"`, unknownIdHint(id, scene.rooms.map((r) => r.id), 'room'));
  return { room: scene.rooms[index]!, index };
}

const isErr = (x: unknown): x is CommandError => typeof x === 'object' && x !== null && 'code' in x && 'message' in x;

type Finish = Wall['finish'];
type Side = 'left' | 'right';
function buildFinish(left: string | undefined, right: string | undefined): Finish {
  return { ...(left !== undefined ? { left } : {}), ...(right !== undefined ? { right } : {}) };
}

/** Wall with one room-scoped side finish set (`undefined` clears); empty entries and the empty record are removed. */
function withRoomFinish(wall: Wall, roomId: string, side: Side, material: string | undefined): Wall {
  const prev = wall.roomFinishes ?? {};
  const entry: { left?: string; right?: string } = { ...(Object.hasOwn(prev, roomId) ? prev[roomId] : {}) };
  if (material === undefined) delete entry[side];
  else entry[side] = material;
  const pairs = Object.entries(prev).filter(([k]) => k !== roomId);
  if (Object.keys(entry).length) pairs.push([roomId, entry]);
  const { roomFinishes: _drop, ...rest } = wall;
  void _drop;
  return pairs.length ? { ...rest, roomFinishes: Object.fromEntries(pairs) } : rest;
}

const mkSetFinish = (wallId: string, side: 'left' | 'right' | 'both', m: string | undefined, roomId?: string): LeafCommand => ({
  type: 'wall.setFinish', wallId, side, materialId: m ?? null, ...(roomId !== undefined ? { roomId } : {}),
});

/** Sides of `wall` that `roomId` adjoins, with a hint listing who is on each face. */
function borderingSides(scene: Scene, wallId: string, roomId: string): { sides: Side[]; hint: string } {
  const analysis = analyzeRoomWallSides(scene, roomId);
  const sides = analysis.ok ? analysis.sides.filter((s) => s.wallId === wallId).map((s) => s.side) : [];
  const faces = wallFaceRooms(scene).get(wallId);
  const list = (ids: string[] | undefined) => (ids?.length ? ids.map((x) => `"${x}"`).join(', ') : 'no room');
  return { sides, hint: `wall "${wallId}" has ${list(faces?.left)} on its left side and ${list(faces?.right)} on its right side` };
}

function setRoomFinish(scene: Scene, cmd: Extract<LeafCommand, { type: 'wall.setFinish' }>): Outcome {
  const roomId = cmd.roomId!;
  const found = findWall(scene, cmd.wallId);
  if (isErr(found)) return fail(found);
  const room = findRoom(scene, roomId);
  if (isErr(room)) return fail(room);
  const bad = checkMaterial(scene, cmd.materialId, 'materialId');
  if (bad) return fail(bad);
  const next = cmd.materialId ?? undefined;
  const requested: Side[] = cmd.side === 'both' ? ['left', 'right'] : [cmd.side];
  let targets = requested;
  if (next !== undefined) {
    const { sides, hint } = borderingSides(scene, cmd.wallId, roomId);
    targets = requested.filter((sd) => sides.includes(sd));
    if (targets.length === 0 || (cmd.side !== 'both' && !sides.includes(cmd.side))) {
      return fail(err('precondition_failed', 'roomId', `room "${roomId}" does not border the ${cmd.side === 'both' ? 'sides' : `${cmd.side} side`} of wall "${cmd.wallId}"`, hint));
    }
  }
  let wall = found.wall;
  const prevs: [Side, string | undefined][] = [];
  for (const sd of targets) {
    const prev = roomSideFinish(wall, roomId, sd);
    if (prev === next) continue;
    prevs.push([sd, prev]);
    wall = withRoomFinish(wall, roomId, sd, next);
  }
  if (wall === found.wall) return noop(scene);
  const inverse: LeafCommand[] =
    prevs.length === 2 && prevs[0]![1] === prevs[1]![1]
      ? [mkSetFinish(wall.id, 'both', prevs[0]![1], roomId)]
      : prevs.map(([sd, p]) => mkSetFinish(wall.id, sd, p, roomId));
  return { ok: true, scene: { ...scene, walls: replaceAt(scene.walls, found.index, wall) }, inverse, changed: touch('walls', wall.id), warnings: [] };
}

function setPaint(scene: Scene, cmd: Extract<LeafCommand, { type: 'wall.setFinish' }>): Outcome {
  if (cmd.roomId !== undefined) return setRoomFinish(scene, cmd);
  const found = findWall(scene, cmd.wallId);
  if (isErr(found)) return fail(found);
  const bad = checkMaterial(scene, cmd.materialId, 'materialId');
  if (bad) return fail(bad);
  const { wall, index } = found;
  const next = cmd.materialId ?? undefined;
  const prevL = wall.finish.left;
  const prevR = wall.finish.right;
  const newL = cmd.side === 'right' ? prevL : next;
  const newR = cmd.side === 'left' ? prevR : next;
  if (newL === prevL && newR === prevR) return noop(scene);
  const nextWall: Wall = { ...wall, finish: buildFinish(newL, newR) };
  const inverse: LeafCommand[] =
    cmd.side === 'left' ? [mkSetFinish(wall.id, 'left', prevL)]
    : cmd.side === 'right' ? [mkSetFinish(wall.id, 'right', prevR)]
    : prevL === prevR ? [mkSetFinish(wall.id, 'both', prevL)]
    : [mkSetFinish(wall.id, 'left', prevL), mkSetFinish(wall.id, 'right', prevR)];
  return {
    ok: true,
    scene: { ...scene, walls: replaceAt(scene.walls, index, nextWall) },
    inverse,
    changed: touch('walls', wall.id),
    warnings: [],
  };
}

/** Wall with the mouldings of one side set (`undefined` clears); the empty record is never stored. */
function withWallPanelling(wall: Wall, side: Side, value: Panelling | undefined): Wall {
  const entry: { left?: Panelling; right?: Panelling } = { ...wall.panelling };
  if (value === undefined) delete entry[side];
  else entry[side] = value;
  const { panelling: _drop, ...rest } = wall;
  void _drop;
  return Object.keys(entry).length ? { ...rest, panelling: entry } : rest;
}

/**
 * The mouldings after a command: `style` null removes them; a style replaces the style and keeps the other stored
 * fields (sizes written in a file); `colour` sets (string) or resets (null) the colour. A colour alone needs mouldings.
 */
function mergePanelling(prev: Panelling | undefined, style: string | null | undefined, colour: string | null | undefined): Panelling | undefined | CommandError {
  if (style === null) return undefined;
  if (style === undefined && colour === undefined) return prev;
  if (style === undefined && prev === undefined) return err('precondition_failed', 'panelColour', 'panelColour needs panelling: set a panelling style first');
  const next: Panelling = { ...prev, ...(style !== undefined ? { style: style as Panelling['style'] } : {}) } as Panelling;
  if (colour === null) delete next.colour;
  else if (colour !== undefined) next.colour = colour;
  return next;
}

/** The command that restores `prev` (best effort for sizes only a file can hold: style and colour are exact). */
const panellingBack = (prev: Panelling | undefined) => ({ panelling: prev?.style ?? null, ...(prev ? { panelColour: prev.colour ?? null } : {}) });

/** Mouldings cover the whole face (also the stretches of other rooms on a shared side): `roomId` does not scope them. */
function setWallPanelling(scene: Scene, cmd: Extract<LeafCommand, { type: 'wall.setFinish' }>): Outcome {
  const found = findWall(scene, cmd.wallId);
  if (isErr(found)) return fail(found);
  let wall = found.wall;
  const inverse: LeafCommand[] = [];
  for (const sd of cmd.side === 'both' ? (['left', 'right'] as const) : [cmd.side]) {
    const prev = wall.panelling?.[sd];
    const next = mergePanelling(prev, cmd.panelling, cmd.panelColour);
    if (isErr(next)) return fail(next);
    if (deepEqual(prev, next)) continue;
    wall = withWallPanelling(wall, sd, next);
    inverse.push({ type: 'wall.setFinish', wallId: wall.id, side: sd, ...panellingBack(prev) });
  }
  if (wall === found.wall) return noop(scene);
  return { ok: true, scene: { ...scene, walls: replaceAt(scene.walls, found.index, wall) }, inverse, changed: touch('walls', wall.id), warnings: [] };
}

function setFinish(scene: Scene, cmd: Extract<LeafCommand, { type: 'wall.setFinish' }>): Outcome {
  const hasPanelling = cmd.panelling !== undefined || cmd.panelColour !== undefined;
  if (cmd.materialId === undefined && !hasPanelling) {
    return fail(err('invalid_command', 'materialId', 'wall.setFinish needs a materialId (null clears) and/or panelling (null removes)'));
  }
  const paint = cmd.materialId === undefined ? noop(scene) : setPaint(scene, cmd);
  if (!paint.ok || !hasPanelling) return paint;
  const pan = setWallPanelling(paint.scene, cmd);
  if (!pan.ok) return pan;
  return { ok: true, scene: pan.scene, inverse: [...pan.inverse, ...paint.inverse], changed: mergeChanged(paint.changed, pan.changed), warnings: [] };
}

function setStructural(scene: Scene, cmd: Extract<LeafCommand, { type: 'wall.setStructural' }>, ctx: ReduceContext): Outcome {
  const found = findWall(scene, cmd.wallId);
  if (isErr(found)) return fail(found);
  const { wall, index } = found;
  if (cmd.structural === false && ctx.author.kind !== 'user' && !ctx.trusted && wall.structural !== false && isDefaultStructural(scene, wall)) {
    return fail(err('precondition_failed', 'structural', `wall "${wall.id}" is structural by default (exterior or at least 15 cm thick) and cannot be marked removable by ${ctx.author.kind}`, 'only a user can mark a structural wall as removable'));
  }
  const prev = wall.structural;
  const next = cmd.structural ?? undefined;
  if (prev === next) return noop(scene);
  const { structural: _drop, ...rest } = wall;
  void _drop;
  const nextWall: Wall = next === undefined ? rest : { ...rest, structural: next };
  return {
    ok: true,
    scene: { ...scene, walls: replaceAt(scene.walls, index, nextWall) },
    inverse: [{ type: 'wall.setStructural', wallId: wall.id, structural: prev ?? null }],
    changed: touch('walls', wall.id),
    warnings: [],
  };
}

/** Largest displacement of an endpoint of a structural wall (load-bearing, facade, party): a snap, never a redesign. */
export const STRUCTURAL_MAX_MOVE = 0.2;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

function setEnds(scene: Scene, cmd: Extract<LeafCommand, { type: 'wall.setEnds' }>, ctx: ReduceContext): Outcome {
  const found = findWall(scene, cmd.wallId);
  if (isErr(found)) return fail(found);
  const { wall, index } = found;
  const start = cmd.start ?? wall.start;
  const end = cmd.end ?? wall.end;
  if (start[0] === wall.start[0] && start[1] === wall.start[1] && end[0] === wall.end[0] && end[1] === wall.end[1]) return noop(scene);
  if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 1e-3) {
    return fail(err('precondition_failed', 'end', `wall "${wall.id}" would be shorter than 1 mm`, 'a wall needs two distinct ends'));
  }
  if (!ctx.trusted && isStructural(scene, wall)) {
    const moved = Math.max(Math.hypot(start[0] - wall.start[0], start[1] - wall.start[1]), Math.hypot(end[0] - wall.end[0], end[1] - wall.end[1]));
    if (moved > STRUCTURAL_MAX_MOVE + 1e-9) {
      return fail(err('precondition_failed', 'start', `wall "${wall.id}" is structural: an end may move by at most ${STRUCTURAL_MAX_MOVE * 100} cm (asked ${(moved * 100).toFixed(1)} cm)`, 'structural walls only get small snaps; redraw it by hand'));
    }
  }
  // Openings keep their place in the plan: their offset is measured from the (possibly moved) start.
  const oldLen = wallLength(wall);
  const newLen = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const ou = [(wall.end[0] - wall.start[0]) / oldLen, (wall.end[1] - wall.start[1]) / oldLen] as const;
  const nu = [(end[0] - start[0]) / newLen, (end[1] - start[1]) / newLen] as const;
  const openings = scene.openings.map((o) => {
    if (o.wallId !== wall.id) return o;
    const x = wall.start[0] + ou[0] * o.offset;
    const y = wall.start[1] + ou[1] * o.offset;
    const offset = round6(Math.max(0, (x - start[0]) * nu[0] + (y - start[1]) * nu[1]));
    return offset === o.offset ? o : { ...o, offset };
  });
  const nextWall: Wall = { ...wall, start: [start[0], start[1]], end: [end[0], end[1]] };
  return {
    ok: true,
    scene: { ...scene, walls: replaceAt(scene.walls, index, nextWall), openings: openings.some((o, i) => o !== scene.openings[i]) ? openings : scene.openings },
    inverse: [{ type: 'wall.setEnds', wallId: wall.id, start: wall.start, end: wall.end }],
    changed: touch('walls', wall.id),
    warnings: [],
  };
}

function setPolygon(scene: Scene, cmd: Extract<LeafCommand, { type: 'room.setPolygon' }>): Outcome {
  const found = findRoom(scene, cmd.roomId);
  if (isErr(found)) return fail(found);
  const { room, index } = found;
  if (deepEqual(room.polygon, cmd.polygon)) return noop(scene);
  return {
    ok: true,
    scene: { ...scene, rooms: replaceAt(scene.rooms, index, { ...room, polygon: cmd.polygon.map((p) => [p[0], p[1]] as [number, number]) }) },
    inverse: [{ type: 'room.setPolygon', roomId: room.id, polygon: room.polygon }],
    changed: touch('rooms', room.id),
    warnings: [],
  };
}

function roomSlot(scene: Scene, cmd: Extract<LeafCommand, { type: 'room.setFloor' | 'room.setCeiling' }>): Outcome {
  const found = findRoom(scene, cmd.roomId);
  if (isErr(found)) return fail(found);
  const bad = checkMaterial(scene, cmd.materialId, 'materialId');
  if (bad) return fail(bad);
  const { room, index } = found;
  const key = cmd.type === 'room.setFloor' ? 'floorMaterial' : 'ceilingMaterial';
  const prev = room[key];
  const next = cmd.materialId ?? undefined;
  if (prev === next) return noop(scene);
  const { [key]: _drop, ...rest } = room;
  void _drop;
  const nextRoom: Room = next === undefined ? rest : { ...rest, [key]: next };
  return {
    ok: true,
    scene: { ...scene, rooms: replaceAt(scene.rooms, index, nextRoom) },
    inverse: [{ type: cmd.type, roomId: room.id, materialId: prev ?? null }],
    changed: touch('rooms', room.id),
    warnings: [],
  };
}

/**
 * Paints a room's walls: sets `room.wallFinish` and makes it visible on every stretch of the
 * room's own wall sides, without changing how any other room looks:
 *  - the room's own scoped finishes (`wall.roomFinishes[room]`) are cleared;
 *  - a whole-side finish on a side the room has to itself is cleared;
 *  - a whole-side finish on a shared side is first converted into scoped finishes for the other
 *    rooms on that side (so they keep their look), then cleared.
 * Afterwards a later `wall.setFinish` (scoped or not) wins over the room paint again.
 */
function roomPaint(scene: Scene, cmd: Extract<LeafCommand, { type: 'room.setWallFinish' }>): Outcome {
  const found = findRoom(scene, cmd.roomId);
  if (isErr(found)) return fail(found);
  const bad = checkMaterial(scene, cmd.materialId, 'materialId');
  if (bad) return fail(bad);
  const analysis = analyzeRoomWallSides(scene, cmd.roomId);
  if (!analysis.ok) {
    const e = analysis.errors[0]!;
    return fail(err(e.code, 'roomId', e.message, 'room edges must run along wall faces; set finishes per wall with wall.setFinish'));
  }
  let current = scene;
  const wallInverse: LeafCommand[] = [];
  let changed = emptyChanged();
  const step = (c: Extract<LeafCommand, { type: 'wall.setFinish' }>): ApplyFail | undefined => {
    const r = setPaint(current, c);
    if (!r.ok) return r;
    current = r.scene;
    wallInverse.unshift(...r.inverse);
    changed = mergeChanged(changed, r.changed);
    return undefined;
  };
  for (const s of analysis.sides) {
    const wallOf = () => current.walls.find((w) => w.id === s.wallId)!;
    let failure: ApplyFail | undefined;
    if (roomSideFinish(wallOf(), cmd.roomId, s.side) !== undefined) {
      failure = step({ type: 'wall.setFinish', wallId: s.wallId, side: s.side, materialId: null, roomId: cmd.roomId });
      if (failure) return failure;
    }
    const whole = wallOf().finish[s.side];
    if (whole !== undefined) {
      for (const other of s.otherRoomIds) {
        if (roomSideFinish(wallOf(), other, s.side) !== undefined) continue;
        failure = step({ type: 'wall.setFinish', wallId: s.wallId, side: s.side, materialId: whole, roomId: other });
        if (failure) return failure;
      }
      failure = step({ type: 'wall.setFinish', wallId: s.wallId, side: s.side, materialId: null });
      if (failure) return failure;
    }
  }
  const prev = found.room.wallFinish;
  const next = cmd.materialId ?? undefined;
  const inverse: LeafCommand[] = [];
  if (prev !== next) {
    const { wallFinish: _drop, ...rest } = found.room;
    void _drop;
    const nextRoom: Room = next === undefined ? rest : { ...rest, wallFinish: next };
    current = { ...current, rooms: replaceAt(current.rooms, found.index, nextRoom) };
    changed = mergeChanged(changed, touch('rooms', cmd.roomId));
    // Applied first on undo; the wall sides are already clean at that point, then they are restored.
    inverse.push({ type: 'room.setWallFinish', roomId: cmd.roomId, materialId: prev ?? null });
  }
  inverse.push(...wallInverse);
  if (current === scene) return noop(scene);
  return { ok: true, scene: current, inverse, changed, warnings: [] };
}

/** Room-level mouldings and cornice (`null` clears, omitted stays), after the optional paint. */
function roomWallFinish(scene: Scene, cmd: Extract<LeafCommand, { type: 'room.setWallFinish' }>): Outcome {
  const hasPanelling = cmd.panelling !== undefined || cmd.panelColour !== undefined;
  if (cmd.materialId === undefined && !hasPanelling && cmd.corniceMm === undefined) {
    return fail(err('invalid_command', 'materialId', 'room.setWallFinish needs materialId (null clears), panelling and/or corniceMm (null removes)'));
  }
  const paint = cmd.materialId === undefined ? noop(scene) : roomPaint(scene, cmd);
  if (!paint.ok || (!hasPanelling && cmd.corniceMm === undefined)) return paint;
  const found = findRoom(paint.scene, cmd.roomId);
  if (isErr(found)) return fail(found);
  const prev = found.room;
  const panelling = mergePanelling(prev.panelling, cmd.panelling, cmd.panelColour);
  if (isErr(panelling)) return fail(panelling);
  const cornice: Cornice | undefined = cmd.corniceMm === undefined ? prev.cornice : cmd.corniceMm === null ? undefined : { ...prev.cornice, heightMm: cmd.corniceMm };
  const { panelling: _p, cornice: _c, ...rest } = prev;
  void _p;
  void _c;
  const room: Room = { ...rest, ...(panelling ? { panelling } : {}), ...(cornice ? { cornice } : {}) };
  if (deepEqual(room, prev)) return paint;
  const back = {
    ...(hasPanelling ? panellingBack(prev.panelling) : {}),
    ...(cmd.corniceMm !== undefined ? { corniceMm: prev.cornice?.heightMm ?? null } : {}),
  };
  return {
    ok: true,
    scene: { ...paint.scene, rooms: replaceAt(paint.scene.rooms, found.index, room) },
    inverse: [{ type: 'room.setWallFinish', roomId: room.id, ...back }, ...paint.inverse],
    changed: mergeChanged(paint.changed, touch('rooms', room.id)),
    warnings: [],
  };
}

function setDefaults(scene: Scene, cmd: Extract<LeafCommand, { type: 'scene.setDefaults' }>): Outcome {
  const keys = (['wall', 'floor', 'ceiling'] as const).filter((k) => cmd[k] !== undefined);
  for (const k of keys) {
    const bad = checkMaterial(scene, cmd[k], k);
    if (bad) return fail(bad);
  }
  const defaults: Record<string, string> = { ...scene.defaults };
  const inverse: Record<string, string | null> = {};
  let changedAny = false;
  for (const k of keys) {
    const prev = scene.defaults[k];
    const next = cmd[k] ?? undefined;
    if (prev === next) continue;
    changedAny = true;
    inverse[k] = prev ?? null;
    if (next === undefined) delete defaults[k];
    else defaults[k] = next;
  }
  if (!changedAny) return noop(scene);
  return {
    ok: true,
    scene: { ...scene, defaults },
    inverse: [{ type: 'scene.setDefaults', ...inverse }],
    changed: { ...emptyChanged(), defaults: true },
    warnings: [],
  };
}

function setSite(scene: Scene, cmd: Extract<LeafCommand, { type: 'site.set' }>): Outcome {
  const site: Record<string, unknown> = { ...scene.site };
  const prevPatch: Record<string, unknown> = {};
  let changedAny = false;
  for (const [k, v] of Object.entries(cmd.site)) {
    if (v === undefined) continue;
    const prev = (scene.site as Record<string, unknown>)[k];
    const next = v === null ? undefined : v;
    if (prev === next) continue;
    changedAny = true;
    prevPatch[k] = prev === undefined ? null : prev;
    if (next === undefined) delete site[k];
    else site[k] = next;
  }
  if (!changedAny) return noop(scene);
  return {
    ok: true,
    scene: { ...scene, site: site as Scene['site'] },
    inverse: [{ type: 'site.set', site: prevPatch as Extract<LeafCommand, { type: 'site.set' }>['site'] }],
    changed: { ...emptyChanged(), site: true },
    warnings: [],
  };
}

function defineMaterial(scene: Scene, cmd: Extract<LeafCommand, { type: 'material.define' }>): Outcome {
  const m = cmd.material as Material;
  const at = scene.materials.findIndex((x) => x.id === m.id);
  if (at >= 0) {
    const prev = scene.materials[at]!;
    if (prev.kind !== m.kind) {
      return fail(err('precondition_failed', 'material/kind', `material "${m.id}" is a ${prev.kind} material; its kind cannot change to ${m.kind}`, 'use a new id for a different kind'));
    }
    if (deepEqual(prev, m)) return noop(scene);
    return {
      ok: true,
      scene: { ...scene, materials: replaceAt(scene.materials, at, m) },
      inverse: [{ type: 'material.define', material: prev }],
      changed: touch('materials', m.id),
      warnings: [],
    };
  }
  if (allIds(scene).has(m.id)) return fail(err('precondition_failed', 'material/id', `id "${m.id}" is already used by another entity`));
  if (scene.materials.length >= LIMITS.materials) {
    return fail(err('limit_exceeded', 'material', `too many materials (max ${LIMITS.materials})`));
  }
  const materials = scene.materials.slice();
  materials.splice(Math.min(cmd.index ?? materials.length, materials.length), 0, m);
  return {
    ok: true,
    scene: { ...scene, materials },
    inverse: [{ type: 'material.remove', id: m.id }],
    changed: touch('materials', m.id),
    warnings: [],
  };
}

function removeMaterial(scene: Scene, cmd: Extract<LeafCommand, { type: 'material.remove' }>): Outcome {
  const at = scene.materials.findIndex((x) => x.id === cmd.id);
  if (at < 0) {
    return fail(err('unknown_material', 'id', `unknown material "${cmd.id}"`, unknownIdHint(cmd.id, scene.materials.map((m) => m.id), 'material')));
  }
  const users: string[] = [];
  scene.walls.forEach((w) => {
    const scoped = Object.values(w.roomFinishes ?? {}).some((e) => e.left === cmd.id || e.right === cmd.id);
    if (w.finish.left === cmd.id || w.finish.right === cmd.id || scoped) users.push(`wall ${w.id}`);
  });
  scene.rooms.forEach((r) => {
    if (r.floorMaterial === cmd.id) users.push(`room ${r.id} (floor)`);
    if (r.ceilingMaterial === cmd.id) users.push(`room ${r.id} (ceiling)`);
    r.floorZones?.forEach((z) => {
      if (z.material === cmd.id) users.push(`room ${r.id} (floor zone ${z.id})`);
    });
    if (r.wallFinish === cmd.id) users.push(`room ${r.id} (wall finish)`);
  });
  (['wall', 'floor', 'ceiling'] as const).forEach((k) => {
    if (scene.defaults[k] === cmd.id) users.push(`defaults.${k}`);
  });
  if (users.length) {
    return fail(err('precondition_failed', 'id', `material "${cmd.id}" is still used by ${users.slice(0, 5).join(', ')}${users.length > 5 ? ', ...' : ''}`, 'reassign those first'));
  }
  const prev = scene.materials[at]!;
  return {
    ok: true,
    scene: { ...scene, materials: scene.materials.filter((_, i) => i !== at) },
    inverse: [{ type: 'material.define', material: prev, index: at }],
    changed: touch('materials', cmd.id),
    warnings: [],
  };
}

function checkRoomRef(scene: Scene, roomId: string | null | undefined, path: string): CommandError | undefined {
  if (roomId === null || roomId === undefined || scene.rooms.some((r) => r.id === roomId)) return undefined;
  return err('unknown_entity', path, `unknown room "${roomId}"`, unknownIdHint(roomId, scene.rooms.map((r) => r.id), 'room'));
}

/** Geometry of a grid from `fitToRoom` or from the defaults of an omitted elevation; errors say what to send. */
function resolveGrid(scene: Scene, input: Record<string, unknown>, path: string): Record<string, unknown> | CommandError {
  const out: Record<string, unknown> = { ...input };
  const roomId = typeof input.roomId === 'string' ? input.roomId : undefined;
  const room = roomId !== undefined ? scene.rooms.find((r) => r.id === roomId) : undefined;
  if (input.fitToRoom === true) {
    if (!room) return err('invalid_command', `${path}/roomId`, 'fitToRoom needs the roomId of the room to cover', 'pass roomId (rooms[].id from list_rooms) or give position, width and depth');
    const fit = fitGridToRoom(scene, room);
    if (!fit) return err('precondition_failed', `${path}/fitToRoom`, `no rectangle fits in room "${room.id}"`, 'give position, width and depth');
    out.position = fit.position;
    out.width = fit.width;
    out.depth = fit.depth;
    out.rotation = 0;
    if (out.elevation === undefined) out.elevation = fit.elevation;
  }
  delete out.fitToRoom;
  if (out.elevation === undefined && room) out.elevation = Math.max(0, Math.round((roomCeilingHeight(scene, room) - GRID_DROP_M) * 100) / 100);
  for (const k of ['position', 'width', 'depth', 'elevation']) {
    if (out[k] === undefined) return err('invalid_command', `${path}/${k}`, `a grid needs ${k}`, 'set fitToRoom: true with a roomId to cover the room, or give position, width, depth and elevation');
  }
  return out;
}

function addLight(scene: Scene, cmd: Extract<LeafCommand, { type: 'light.add' }>): Outcome {
  if (scene.lights.length >= LIMITS.lights) return fail(err('limit_exceeded', 'light', `too many lights (max ${LIMITS.lights})`));
  const ids = allIds(scene);
  let id = cmd.light.id;
  if (id === undefined) {
    let n = scene.lights.length + 1;
    while (ids.has(`light-${n}`)) n++;
    id = `light-${n}`;
  } else if (ids.has(id)) {
    return fail(err('precondition_failed', 'light/id', `id "${id}" is already used`, 'omit the id to derive one, or use light.update'));
  }
  const badRoom = checkRoomRef(scene, cmd.light.roomId, 'light/roomId');
  if (badRoom) return fail(badRoom);
  let candidate: Record<string, unknown> = { ...cmd.light, id };
  if (cmd.light.type === 'grid') {
    const resolved = resolveGrid(scene, candidate, 'light');
    if (isErr(resolved)) return fail(resolved);
    candidate = resolved;
  }
  const parsed = Light.safeParse(candidate);
  if (!parsed.success) {
    return fail(...parsed.error.issues.map((i) => err('invalid_command', ['light', ...i.path.map(String)].join('/'), i.message)));
  }
  const problems = lightIssues(parsed.data);
  if (problems.length) return fail(...problems.map((m) => err('invalid_command', 'light', m)));
  const lights = scene.lights.slice();
  lights.splice(Math.min(cmd.index ?? lights.length, lights.length), 0, parsed.data);
  return {
    ok: true,
    scene: { ...scene, lights },
    inverse: [{ type: 'light.remove', id }],
    changed: touch('lights', id),
    warnings: [],
  };
}

/** Fields of a lamp item's light that follow the item and so cannot be set on the light. */
const LINKED_FIXED = ['position', 'elevation', 'roomId'] as const;

function updateLight(scene: Scene, cmd: Extract<LeafCommand, { type: 'light.update' }>): Outcome {
  const at = scene.lights.findIndex((l) => l.id === cmd.id);
  if (at < 0) return fail(err('unknown_entity', 'id', `unknown light "${cmd.id}"`, unknownIdHint(cmd.id, scene.lights.map((l) => l.id), 'light')));
  const light = scene.lights[at]!;
  const badRoom = checkRoomRef(scene, cmd.patch.roomId, 'patch/roomId');
  if (badRoom) return fail(badRoom);
  const patch: Record<string, unknown> = { ...cmd.patch };
  if (light.itemId !== undefined) {
    for (const k of LINKED_FIXED) {
      if (patch[k] !== undefined) {
        return fail(err('precondition_failed', `patch/${k}`, `light "${light.id}" belongs to item "${light.itemId}" and follows it (${k} cannot be set on the light)`, 'move or rotate the item (item_move, item_rotate); on, lumens, kelvin and name can be changed here'));
      }
    }
  }
  if (patch.fitToRoom !== undefined) {
    if (light.type !== 'grid') return fail(err('invalid_command', 'patch/fitToRoom', 'fitToRoom is for grid lights', 'a ' + light.type + ' light takes position instead'));
    if (patch.fitToRoom === true) {
      const roomId = patch.roomId === null ? undefined : ((patch.roomId as string | undefined) ?? light.roomId);
      const resolved = resolveGrid(scene, { ...light, roomId, fitToRoom: true, elevation: patch.elevation ?? light.elevation }, 'patch');
      if (isErr(resolved)) return fail(resolved);
      patch.position = resolved.position;
      patch.width = resolved.width;
      patch.depth = resolved.depth;
      patch.rotation = 0;
    }
    delete patch.fitToRoom;
  }
  // A user's change of a lamp item's lumens makes the figure the user's, not the product's (undo restores the source).
  if (light.itemId !== undefined && patch.lumens !== undefined && patch.lumensSource === undefined && light.lumensSource !== undefined && light.lumensSource !== 'user' && patch.lumens !== (light as { lumens: number }).lumens) {
    patch.lumensSource = 'user';
  }
  const merged: Record<string, unknown> = { ...light };
  const prevPatch: Record<string, unknown> = {};
  let changedAny = false;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const prev = (light as Record<string, unknown>)[k];
    const next = v === null ? undefined : v;
    if (deepEqual(prev, next)) continue;
    changedAny = true;
    prevPatch[k] = prev === undefined ? null : prev;
    if (next === undefined) delete merged[k];
    else merged[k] = next;
  }
  if (!changedAny) return noop(scene);
  const parsed = Light.safeParse(merged);
  if (!parsed.success) {
    return fail(...parsed.error.issues.map((i) => err('invalid_command', ['patch', ...i.path.map(String)].join('/'), i.message, `a ${light.type} light cannot take this field`)));
  }
  const problems = lightIssues(parsed.data);
  if (problems.length) return fail(...problems.map((m) => err('invalid_command', 'patch', m)));
  return {
    ok: true,
    scene: { ...scene, lights: replaceAt(scene.lights, at, merged as LightT) },
    inverse: [{ type: 'light.update', id: light.id, patch: prevPatch as Extract<LeafCommand, { type: 'light.update' }>['patch'] }],
    changed: touch('lights', light.id),
    warnings: [],
  };
}

function removeLight(scene: Scene, cmd: Extract<LeafCommand, { type: 'light.remove' }>): Outcome {
  const at = scene.lights.findIndex((l) => l.id === cmd.id);
  if (at < 0) return fail(err('unknown_entity', 'id', `unknown light "${cmd.id}"`, unknownIdHint(cmd.id, scene.lights.map((l) => l.id), 'light')));
  const light = scene.lights[at]!;
  if (light.itemId !== undefined) {
    return fail(err('precondition_failed', 'id', `light "${light.id}" belongs to item "${light.itemId}" and cannot be removed on its own`, 'switch it off with light_update {on: false}, or remove the item (item_remove)'));
  }
  return {
    ok: true,
    scene: { ...scene, lights: scene.lights.filter((_, i) => i !== at) },
    inverse: [{ type: 'light.add', light, index: at }],
    changed: touch('lights', light.id),
    warnings: [],
  };
}

/** Room with its floor zones replaced; the key is dropped when no zone is left (an empty list is never stored). */
function withZones(room: Room, zones: FloorZone[]): Room {
  const { floorZones: _drop, ...rest } = room;
  void _drop;
  return zones.length ? { ...rest, floorZones: zones } : rest;
}

function zoneFail(roomId: string, zones: readonly FloorZone[], room: Room): ApplyFail | undefined {
  const problem = zoneProblems(room.polygon, zones)[0];
  if (!problem) return undefined;
  return fail(err('precondition_failed', `zone/${problem.field}`, problem.message, `draw the zone inside room "${roomId}" (polygon points in plan metres) without overlapping its other zones`));
}

function setFloorZone(scene: Scene, cmd: Extract<LeafCommand, { type: 'room.setFloorZone' }>): Outcome {
  const found = findRoom(scene, cmd.roomId);
  if (isErr(found)) return fail(found);
  const bad = checkMaterial(scene, cmd.zone.material, 'zone/material');
  if (bad) return fail(bad);
  const { room, index } = found;
  const zone = cmd.zone as FloorZone;
  const zones = room.floorZones ?? [];
  const at = zones.findIndex((z) => z.id === zone.id);
  if (at < 0 && zones.length >= LIMITS.floorZonesPerRoom) return fail(err('limit_exceeded', 'zone', `too many floor zones in room "${room.id}" (max ${LIMITS.floorZonesPerRoom})`));
  if (at >= 0 && deepEqual(zones[at], zone)) return noop(scene);
  const next = zones.slice();
  if (at >= 0) next[at] = zone;
  else next.splice(Math.min(cmd.index ?? next.length, next.length), 0, zone);
  const invalid = zoneFail(room.id, next, room);
  if (invalid) return invalid;
  return {
    ok: true,
    scene: { ...scene, rooms: replaceAt(scene.rooms, index, withZones(room, next)) },
    inverse: [at >= 0 ? { type: 'room.setFloorZone', roomId: room.id, zone: zones[at]! } : { type: 'room.removeFloorZone', roomId: room.id, zoneId: zone.id }],
    changed: touch('rooms', room.id),
    warnings: [],
  };
}

function findZone(room: Room, zoneId: string): { zone: FloorZone; at: number } | CommandError {
  const zones = room.floorZones ?? [];
  const at = zones.findIndex((z) => z.id === zoneId);
  if (at < 0) return err('unknown_entity', 'zoneId', `unknown floor zone "${zoneId}" in room "${room.id}"`, unknownIdHint(zoneId, zones.map((z) => z.id), 'floor zone'));
  return { zone: zones[at]!, at };
}

function removeFloorZone(scene: Scene, cmd: Extract<LeafCommand, { type: 'room.removeFloorZone' }>): Outcome {
  const found = findRoom(scene, cmd.roomId);
  if (isErr(found)) return fail(found);
  const hit = findZone(found.room, cmd.zoneId);
  if (isErr(hit)) return fail(hit);
  const next = found.room.floorZones!.filter((_, i) => i !== hit.at);
  return {
    ok: true,
    scene: { ...scene, rooms: replaceAt(scene.rooms, found.index, withZones(found.room, next)) },
    inverse: [{ type: 'room.setFloorZone', roomId: found.room.id, zone: hit.zone, index: hit.at }],
    changed: touch('rooms', found.room.id),
    warnings: [],
  };
}

function setFloorZoneMaterial(scene: Scene, cmd: Extract<LeafCommand, { type: 'room.setFloorZoneMaterial' }>): Outcome {
  const found = findRoom(scene, cmd.roomId);
  if (isErr(found)) return fail(found);
  const hit = findZone(found.room, cmd.zoneId);
  if (isErr(hit)) return fail(hit);
  const bad = checkMaterial(scene, cmd.material, 'material');
  if (bad) return fail(bad);
  if (hit.zone.material === cmd.material) return noop(scene);
  const next = found.room.floorZones!.slice();
  next[hit.at] = { ...hit.zone, material: cmd.material };
  return {
    ok: true,
    scene: { ...scene, rooms: replaceAt(scene.rooms, found.index, withZones(found.room, next)) },
    inverse: [{ type: 'room.setFloorZoneMaterial', roomId: found.room.id, zoneId: hit.zone.id, material: hit.zone.material }],
    changed: touch('rooms', found.room.id),
    warnings: [],
  };
}

/** Commands reserved for later milestones: the structural rules are enforced before `not_supported`, so the order is right once they get real reducers. */
function reservedLeaf(scene: Scene, cmd: { type: string; wallId?: unknown }): Outcome {
  const wallId = typeof cmd.wallId === 'string' ? cmd.wallId : undefined;
  if (wallId !== undefined) {
    const guard = cmd.type === 'wall.remove' ? canRemoveWall(scene, wallId) : cmd.type === 'opening.add' ? canCutOpening(scene, wallId) : undefined;
    if (guard && !guard.ok) {
      const { ok: _ok, ...e } = guard;
      void _ok;
      return fail(e);
    }
  }
  return fail(err('not_supported', 'type', `command "${cmd.type}" has no reducer`));
}

function itemLeaf(scene: Scene, cmd: Extract<LeafCommand, { type: `item.${string}` }>, ctx: ReduceContext): Outcome {
  const r = applyItemCommand(scene, cmd, ctx);
  if (!r.ok) return r;
  return { ok: true, scene: r.scene, inverse: r.inverse, changed: r.ids.length ? { ...touch('items', ...r.ids), lights: r.lights } : emptyChanged(), warnings: [] };
}

function applyLeaf(scene: Scene, cmd: LeafCommand, ctx: ReduceContext): Outcome {
  if (isItemCommand(cmd)) return itemLeaf(scene, cmd, ctx);
  switch (cmd.type) {
    case 'material.define': return defineMaterial(scene, cmd);
    case 'material.remove': return removeMaterial(scene, cmd);
    case 'wall.setFinish': return setFinish(scene, cmd);
    case 'wall.setStructural': return setStructural(scene, cmd, ctx);
    case 'wall.setEnds': return setEnds(scene, cmd, ctx);
    case 'room.setPolygon': return setPolygon(scene, cmd);
    case 'room.setWallFinish': return roomWallFinish(scene, cmd);
    case 'room.setFloor':
    case 'room.setCeiling': return roomSlot(scene, cmd);
    case 'scene.setDefaults': return setDefaults(scene, cmd);
    case 'site.set': return setSite(scene, cmd);
    case 'light.add': return addLight(scene, cmd);
    case 'light.update': return updateLight(scene, cmd);
    case 'light.remove': return removeLight(scene, cmd);
    case 'room.setFloorZone': return setFloorZone(scene, cmd);
    case 'room.removeFloorZone': return removeFloorZone(scene, cmd);
    case 'room.setFloorZoneMaterial': return setFloorZoneMaterial(scene, cmd);
    default:
      return reservedLeaf(scene, cmd as { type: string });
  }
}

const prefix = (i: number, p: string) => `commands/${i}${p ? `/${p}` : ''}`;

// ---- inverse collapsing -------------------------------------------------------------------------

/** Keys a command overwrites with absolute values; two commands with the same key supersede one another. */
function overwriteKeys(c: LeafCommand): string[] | undefined {
  switch (c.type) {
    case 'wall.setFinish':
      if (c.panelling !== undefined || c.panelColour !== undefined) return undefined;
      return (c.side === 'both' ? ['left', 'right'] : [c.side]).map((sd) => `finish|${c.wallId}|${c.roomId ?? ''}|${sd}`);
    case 'wall.setStructural': return [`structural|${c.wallId}`];
    case 'room.setFloor':
    case 'room.setCeiling': return [`${c.type}|${c.roomId}`];
    case 'scene.setDefaults': return (['wall', 'floor', 'ceiling'] as const).filter((k) => c[k] !== undefined).map((k) => `defaults|${k}`);
    case 'site.set': return Object.entries(c.site).filter(([, v]) => v !== undefined).map(([k]) => `site|${k}`);
    case 'light.update': return Object.entries(c.patch).filter(([, v]) => v !== undefined).map(([k]) => `light|${c.id}|${k}`);
    default: return undefined;
  }
}

/** Removes the keys in `seen` from patch-style commands. */
function strip(c: LeafCommand, seen: ReadonlySet<string>): LeafCommand {
  const keep = <T extends Record<string, unknown>>(obj: T, key: (k: string) => string): T =>
    Object.fromEntries(Object.entries(obj).filter(([k, v]) => v === undefined || !seen.has(key(k)))) as T;
  switch (c.type) {
    case 'scene.setDefaults': return { ...keep(c, (k) => `defaults|${k}`), type: c.type };
    case 'site.set': return { ...c, site: keep(c.site, (k) => `site|${k}`) };
    case 'light.update': return { ...c, patch: keep(c.patch, (k) => `light|${c.id}|${k}`) };
    default: return c;
  }
}

/**
 * Collapses an undo list: when several commands overwrite the same target (wall side, room slot,
 * site field, ...) only the last one in undo order matters, because it restores the oldest value.
 * The caller verifies the result, so a clever-but-wrong collapse can never be recorded.
 */
function collapseInverse(list: LeafCommand[]): LeafCommand[] {
  const seen = new Set<string>();
  const kept: LeafCommand[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i]!;
    const keys = overwriteKeys(c);
    if (!keys) {
      kept.push(c);
      continue;
    }
    if (keys.length === 0 || keys.every((k) => seen.has(k))) continue;
    kept.push(strip(c, seen));
    keys.forEach((k) => seen.add(k));
  }
  return kept.reverse();
}

function runLeaves(scene: Scene, list: readonly LeafCommand[], ctx: ReduceContext): Scene | undefined {
  let current = scene;
  for (const c of list) {
    const r = applyLeaf(current, c, ctx);
    if (!r.ok) return undefined;
    current = r.scene;
  }
  return current;
}

function applyBatch(scene: Scene, cmd: BatchCommand, ctx: ReduceContext): Outcome {
  let current = scene;
  let inverse: LeafCommand[] = [];
  let changed = emptyChanged();
  const warnings: ApplyWarning[] = [];
  const errors: CommandError[] = [];
  for (let i = 0; i < cmd.commands.length; i++) {
    const r = applyLeaf(current, cmd.commands[i]!, ctx);
    if (!r.ok) {
      errors.push(...r.errors.map((e) => ({ ...e, path: prefix(i, e.path) })));
      break;
    }
    current = r.scene;
    inverse.unshift(...r.inverse);
    changed = mergeChanged(changed, r.changed);
    warnings.push(...r.warnings.map((w) => ({ ...w, path: prefix(i, w.path) })));
  }
  if (errors.length) return { ok: false, errors };
  if (current !== scene) {
    const collapsed = collapseInverse(inverse);
    if (collapsed.length < inverse.length) {
      // Only trust a collapse that provably restores the original scene.
      const restored = runLeaves(current, collapsed, { ...ctx, trusted: true });
      if (restored && deepEqual(restored, scene)) inverse = collapsed;
    }
  }
  return { ok: true, scene: current, inverse, changed, warnings };
}

/**
 * Reducer without parsing or validation: applies one command (or a batch) and returns the new
 * scene plus an inverse. Exposed for tests of rules that parsing would otherwise pre-empt.
 * @internal Use `applyCommand`.
 */
export function reduceCommand(scene: Scene, cmd: { type: string; [key: string]: unknown }, ctx: ReduceContext = { author: { kind: 'user' } }): ApplyFail | { ok: true; scene: Scene } {
  const out = cmd.type === 'batch' ? applyBatch(scene, cmd as BatchCommand, ctx) : applyLeaf(scene, cmd as LeafCommand, ctx);
  return out.ok ? { ok: true, scene: out.scene } : out;
}

/** Longest label of a batch. */
const LABEL_MAX = 200;

/** Undo command for a list of inverse commands; the label is truncated to the batch label limit. */
export function toInverseCommand(label: string, list: LeafCommand[]): Command {
  if (list.length === 1) return list[0]!;
  const text = `undo: ${label}`;
  return { type: 'batch', label: text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text, commands: list };
}

/**
 * Applies one command envelope to a scene. Pure and deterministic: no clock, no randomness,
 * no mutation of its inputs; entities the command does not touch keep their identity (`===`).
 * `batch` is atomic. Unparseable envelopes yield `invalid_command` (or `not_supported`).
 * Every ok scene passes `Scene.safeParse`; a command that would break it yields `scene_invalid`.
 */
export function applyCommand(scene: Scene, envelope: CommandEnvelope, options: ApplyOptions = {}): ApplyResult {
  const parsed = parseCommand(envelope, { trusted: options.trusted === true });
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const env = parsed.envelope;
  if (env.ifRev !== undefined && options.rev !== undefined && env.ifRev !== options.rev) {
    return fail(err('precondition_failed', 'ifRev', `scene is at revision ${options.rev}, command expected ${env.ifRev}`, 'reload the scene and retry'));
  }
  const cmd = env.cmd;
  const ctx: ReduceContext = { author: env.author, trusted: options.trusted === true };
  const out = cmd.type === 'batch' ? applyBatch(scene, cmd, ctx) : applyLeaf(scene, cmd, ctx);
  if (!out.ok) return out;
  const label = cmd.type === 'batch' ? cmd.label : cmd.type;
  const allNoop = out.scene === scene;
  if (allNoop) {
    return { ok: true, scene, inverse: { type: 'batch', label: 'noop', commands: [] }, changed: emptyChanged(), warnings: out.warnings, noop: true };
  }
  const valid = Scene.safeParse(out.scene);
  if (!valid.success) {
    return fail(...valid.error.issues.map((i) => err('scene_invalid', i.path.map(String).join('/'), i.message, 'the command would leave the scene invalid')));
  }
  return { ok: true, scene: out.scene, inverse: toInverseCommand(label, out.inverse), changed: out.changed, warnings: out.warnings };
}
