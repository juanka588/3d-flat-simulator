import { analyzeRoomWallSides } from '../geometry/room-sides';
import { LIMITS, Light, Scene, type Light as LightT, type Material, type Room, type Wall } from '../schema';
import { parseCommand } from './parse';
import type { BatchCommand, Command, CommandEnvelope, LeafCommand } from './schema';
import { deepEqual, err, unknownIdHint, type CommandError } from './util';

export interface ApplyWarning {
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
}

type Outcome =
  | { ok: true; scene: Scene; inverse: LeafCommand[]; changed: Changed; warnings: ApplyWarning[] }
  | ApplyFail;

const emptyChanged = (): Changed => ({ materials: [], walls: [], rooms: [], lights: [], site: false, defaults: false });
const noop = (scene: Scene): Outcome => ({ ok: true, scene, inverse: [], changed: emptyChanged(), warnings: [] });
const fail = (...errors: CommandError[]): ApplyFail => ({ ok: false, errors });
const touch = (key: keyof Omit<Changed, 'site' | 'defaults'>, ...ids: string[]): Changed => ({ ...emptyChanged(), [key]: ids });

function mergeChanged(a: Changed, b: Changed): Changed {
  const u = (x: string[], y: string[]) => [...new Set([...x, ...y])];
  return {
    materials: u(a.materials, b.materials),
    walls: u(a.walls, b.walls),
    rooms: u(a.rooms, b.rooms),
    lights: u(a.lights, b.lights),
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
function buildFinish(left: string | undefined, right: string | undefined): Finish {
  return { ...(left !== undefined ? { left } : {}), ...(right !== undefined ? { right } : {}) };
}

function setFinish(scene: Scene, cmd: Extract<LeafCommand, { type: 'wall.setFinish' }>): Outcome {
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
  const mk = (side: 'left' | 'right' | 'both', m: string | undefined): LeafCommand => ({
    type: 'wall.setFinish', wallId: wall.id, side, materialId: m ?? null,
  });
  const inverse: LeafCommand[] =
    cmd.side === 'left' ? [mk('left', prevL)]
    : cmd.side === 'right' ? [mk('right', prevR)]
    : prevL === prevR ? [mk('both', prevL)]
    : [mk('left', prevL), mk('right', prevR)];
  return {
    ok: true,
    scene: { ...scene, walls: replaceAt(scene.walls, index, nextWall) },
    inverse,
    changed: touch('walls', wall.id),
    warnings: [],
  };
}

function setStructural(scene: Scene, cmd: Extract<LeafCommand, { type: 'wall.setStructural' }>): Outcome {
  const found = findWall(scene, cmd.wallId);
  if (isErr(found)) return fail(found);
  const { wall, index } = found;
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
 * Paints a room's walls: sets `room.wallFinish` and clears the explicit finish of the wall sides
 * the room has to itself ('full'), so the room value shows. Shared ('partial') sides keep their
 * explicit finish (warning `shared_wall_side_override` when one exists, since it wins over the
 * room finish); sides without one show the room finish only on this room's stretch.
 */
function roomWallFinish(scene: Scene, cmd: Extract<LeafCommand, { type: 'room.setWallFinish' }>): Outcome {
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
  const warnings: ApplyWarning[] = [];
  for (const s of analysis.sides) {
    if (s.coverage === 'full') {
      const r = setFinish(current, { type: 'wall.setFinish', wallId: s.wallId, side: s.side, materialId: null });
      if (!r.ok) return r;
      current = r.scene;
      wallInverse.push(...r.inverse);
      changed = mergeChanged(changed, r.changed);
    } else {
      const explicit = current.walls.find((w) => w.id === s.wallId)?.finish[s.side];
      if (explicit !== undefined) {
        warnings.push({
          code: 'shared_wall_side_override',
          path: 'roomId',
          message: `the ${s.side} side of wall "${s.wallId}" is shared and has its own finish "${explicit}", which overrides the room finish; reset it with wall.setFinish`,
        });
      }
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
    // Applied first on undo; it re-clears sides that are already clear, then the walls are restored.
    inverse.push({ type: 'room.setWallFinish', roomId: cmd.roomId, materialId: prev ?? null });
  }
  inverse.push(...wallInverse);
  if (current === scene) return noop(scene);
  return { ok: true, scene: current, inverse, changed, warnings };
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
    if (w.finish.left === cmd.id || w.finish.right === cmd.id) users.push(`wall ${w.id}`);
  });
  scene.rooms.forEach((r) => {
    if (r.floorMaterial === cmd.id || r.ceilingMaterial === cmd.id) users.push(`room ${r.id}`);
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
  const parsed = Light.safeParse({ ...cmd.light, id });
  if (!parsed.success) {
    return fail(...parsed.error.issues.map((i) => err('invalid_command', ['light', ...i.path.map(String)].join('/'), i.message)));
  }
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

function updateLight(scene: Scene, cmd: Extract<LeafCommand, { type: 'light.update' }>): Outcome {
  const at = scene.lights.findIndex((l) => l.id === cmd.id);
  if (at < 0) return fail(err('unknown_entity', 'id', `unknown light "${cmd.id}"`, unknownIdHint(cmd.id, scene.lights.map((l) => l.id), 'light')));
  const light = scene.lights[at]!;
  const badRoom = checkRoomRef(scene, cmd.patch.roomId, 'patch/roomId');
  if (badRoom) return fail(badRoom);
  const merged: Record<string, unknown> = { ...light };
  const prevPatch: Record<string, unknown> = {};
  let changedAny = false;
  for (const [k, v] of Object.entries(cmd.patch)) {
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
  return {
    ok: true,
    scene: { ...scene, lights: scene.lights.filter((_, i) => i !== at) },
    inverse: [{ type: 'light.add', light, index: at }],
    changed: touch('lights', light.id),
    warnings: [],
  };
}

function applyLeaf(scene: Scene, cmd: LeafCommand): Outcome {
  switch (cmd.type) {
    case 'material.define': return defineMaterial(scene, cmd);
    case 'material.remove': return removeMaterial(scene, cmd);
    case 'wall.setFinish': return setFinish(scene, cmd);
    case 'wall.setStructural': return setStructural(scene, cmd);
    case 'room.setWallFinish': return roomWallFinish(scene, cmd);
    case 'room.setFloor':
    case 'room.setCeiling': return roomSlot(scene, cmd);
    case 'scene.setDefaults': return setDefaults(scene, cmd);
    case 'site.set': return setSite(scene, cmd);
    case 'light.add': return addLight(scene, cmd);
    case 'light.update': return updateLight(scene, cmd);
    case 'light.remove': return removeLight(scene, cmd);
    default:
      return fail(err('not_supported', 'type', `command "${(cmd as { type: string }).type}" has no reducer`));
  }
}

const prefix = (i: number, p: string) => `commands/${i}${p ? `/${p}` : ''}`;

function applyBatch(scene: Scene, cmd: BatchCommand): Outcome {
  let current = scene;
  const inverse: LeafCommand[] = [];
  let changed = emptyChanged();
  const warnings: ApplyWarning[] = [];
  const errors: CommandError[] = [];
  for (let i = 0; i < cmd.commands.length; i++) {
    const r = applyLeaf(current, cmd.commands[i]!);
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
  return { ok: true, scene: current, inverse, changed, warnings };
}

export function toInverseCommand(label: string, list: LeafCommand[]): Command {
  return list.length === 1 ? list[0]! : { type: 'batch', label: `undo: ${label}`, commands: list };
}

/**
 * Applies one command envelope to a scene. Pure and deterministic: no clock, no randomness,
 * no mutation of its inputs; entities the command does not touch keep their identity (`===`).
 * `batch` is atomic. Unparseable envelopes yield `invalid_command` (or `not_supported`).
 * Every ok scene passes `Scene.safeParse`; a command that would break it yields `scene_invalid`.
 */
export function applyCommand(scene: Scene, envelope: CommandEnvelope, options: ApplyOptions = {}): ApplyResult {
  const parsed = parseCommand(envelope);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const env = parsed.envelope;
  if (env.ifRev !== undefined && options.rev !== undefined && env.ifRev !== options.rev) {
    return fail(err('precondition_failed', 'ifRev', `scene is at revision ${options.rev}, command expected ${env.ifRev}`, 'reload the scene and retry'));
  }
  const cmd = env.cmd;
  const out = cmd.type === 'batch' ? applyBatch(scene, cmd) : applyLeaf(scene, cmd);
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
