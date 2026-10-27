import { checkParametricMesh, defaultParametricFor, meshAssetId } from '../assets/catalog';
import { CHEAP_RULES, checkSubject, layoutContext, ROOM_TOLERANCE, type Subject } from '../placement/constraints';
import { itemDims, itemMountOf } from '../placement/footprint';
import { linkedLightFor, linkedLightPose } from '../lighting/lamps';
import { LIMITS, Item, Light, type Scene, type Vec2 } from '../schema';
import { pointInPolygon } from '../validate';
import type { Author, LeafCommand } from './schema';
import { deepEqual, err, unknownIdHint, type CommandError } from './util';

/** Soft cap on the number of items in one room (a guard against runaway batches, not a design rule). */
export const ITEMS_PER_ROOM_SOFT_CAP = 60;

type ItemLeaf = Extract<LeafCommand, { type: 'item.place' | 'item.move' | 'item.rotate' | 'item.setVariant' | 'item.remove' }>;
/** `ids` are the items touched, `lights` the linked lights added, moved or removed with them. */
export type ItemOutcome = { ok: true; scene: Scene; inverse: LeafCommand[]; ids: string[]; lights: string[] } | { ok: false; errors: CommandError[] };

const fail = (...errors: CommandError[]): ItemOutcome => ({ ok: false, errors });
const ok = (scene: Scene, inverse: LeafCommand[], ids: string[], lights: string[] = []): ItemOutcome => ({ ok: true, scene, inverse, ids, lights });
const noop = (scene: Scene): ItemOutcome => ({ ok: true, scene, inverse: [], ids: [], lights: [] });

export function isItemCommand(cmd: { type: string }): cmd is ItemLeaf {
  return cmd.type.startsWith('item.');
}

interface Ctx {
  author: Author;
  trusted?: boolean;
}

/** Restoring an earlier state (undo / redo) is always allowed; otherwise only a user may do things to locked items. */
function lockedError(item: Item, ctx: Ctx, verb: string): CommandError | undefined {
  if (item.locked !== true || ctx.trusted || ctx.author.kind === 'user') return undefined;
  return err('precondition_failed', 'id', `item "${item.id}" is locked (existing furniture) and cannot be ${verb} by ${ctx.author.kind}`, 'plan around it; only the user can change a locked item');
}

function findItem(scene: Scene, id: string): { item: Item; index: number } | CommandError {
  const index = scene.items.findIndex((i) => i.id === id);
  if (index < 0) return err('unknown_entity', 'id', `unknown item "${id}"`, unknownIdHint(id, scene.items.map((i) => i.id), 'item'));
  return { item: scene.items[index]!, index };
}

const isErr = (x: unknown): x is CommandError => typeof x === 'object' && x !== null && 'code' in x && 'message' in x;

const parseItem = (candidate: unknown, path: string): { item: Item } | { errors: CommandError[] } => {
  const r = Item.safeParse(candidate);
  if (r.success) return { item: r.data };
  return { errors: r.error.issues.map((i) => err('invalid_command', [path, ...i.path.map(String)].join('/'), i.message)) };
};

/** Room an item is judged in: its `roomId`, else the room containing its position. */
function roomIdOf(scene: Scene, item: Item): string | undefined {
  if (item.roomId !== undefined) return item.roomId;
  return scene.rooms.find((r) => pointInPolygon(item.position, r.polygon, ROOM_TOLERANCE))?.id;
}

/** Cheap hard checks (inside the room, no overlap, door swings) on an item as it would stand in `scene`; locked items skip the room-containment rule. */
function placementErrors(scene: Scene, item: Item, path: string): CommandError[] {
  const roomId = roomIdOf(scene, item);
  if (roomId === undefined) {
    return [
      {
        ...err('placement_invalid', path, `item "${item.id}" is not inside any room`, 'put the position inside a room (describe_room bounds) and give roomId'),
        violation: { code: 'outside_room', message: `item "${item.id}" is not inside any room`, entityIds: [item.id], hint: 'put the position inside a room' },
      },
    ];
  }
  const subject: Subject = {
    id: item.id,
    roomId,
    position: item.position,
    rotation: item.rotation,
    elevation: item.elevation,
    dims: itemDims(item),
    mount: itemMountOf(item),
  };
  // Existing furniture is built into the plan, not placed in a room: a locked item may stand outside its room's polygon
  // (the placard of Chambre 2 sits in the wall thickness and opens onto the Entrée), as `validateLayout` does not judge it either.
  const rules = item.locked === true ? CHEAP_RULES.filter((r) => r !== 'inside') : CHEAP_RULES;
  return checkSubject(layoutContext(scene), subject, rules).violations.map((v) => ({
    ...err('placement_invalid', path, v.message, v.hint),
    violation: v,
  }));
}

const allIds = (scene: Scene): Set<string> =>
  new Set([...scene.materials, ...scene.walls, ...scene.openings, ...scene.rooms, ...scene.items, ...scene.lights].map((e) => e.id));

const DIMS_TOLERANCE = 0.001;
const sameDims = (a: { w: number; d: number; h: number }, b: { w: number; d: number; h: number }) =>
  Math.abs(a.w - b.w) <= DIMS_TOLERANCE && Math.abs(a.d - b.d) <= DIMS_TOLERANCE && Math.abs(a.h - b.h) <= DIMS_TOLERANCE;

/**
 * Defence in depth for non-user authors (the MCP layer builds the product from the server's record; the
 * reducer cannot see that record but can refuse an item that contradicts itself): a product snapshot, a
 * productRef equal to it, dims equal to its dims, a parametric shape of that size.
 */
function consistencyErrors(item: Item, path: string): CommandError[] {
  const p = item.product;
  if (p === undefined) {
    return [err('precondition_failed', `${path}/product`, 'a product snapshot is required (a productRef alone is not enough)', 'use place_item: it reads the product record from the server')];
  }
  const errors: CommandError[] = [];
  if (item.productRef !== undefined && (item.productRef.provider !== p.provider || item.productRef.sku !== p.sku)) {
    errors.push(err('precondition_failed', `${path}/productRef`, `productRef ${item.productRef.provider}:${item.productRef.sku} does not match the product ${p.provider}:${p.sku}`, 'use place_item: it reads the product record from the server'));
  }
  if (item.dims !== undefined && !sameDims(item.dims, p.dims)) {
    errors.push(err('precondition_failed', `${path}/dims`, `dims ${item.dims.w} x ${item.dims.d} x ${item.dims.h} differ from the product dims ${p.dims.w} x ${p.dims.d} x ${p.dims.h}`, 'dimensions come from the product record; use place_item'));
  }
  if (item.mesh?.kind === 'parametric') {
    const check = checkParametricMesh(item.mesh, item.dims ?? p.dims);
    if (check.status === 'dims_mismatch' || check.status === 'invalid_params') {
      errors.push(err('precondition_failed', `${path}/mesh`, `the parametric shape does not fit the product dimensions`, 'omit mesh or use the dims of the product'));
    }
  }
  return errors;
}

function place(scene: Scene, cmd: Extract<ItemLeaf, { type: 'item.place' }>, ctx: Ctx): ItemOutcome {
  const draft = cmd.item;
  if (!ctx.trusted) {
    if (ctx.author.kind !== 'user' && draft.product === undefined && draft.productRef === undefined) {
      return fail(
        err(
          'precondition_failed',
          'item/product',
          `items placed by ${ctx.author.kind === 'llm' ? 'an LLM' : 'the planner'} must reference a real product (productRef or product)`,
          'search_products first, then place a product it returned (place_item); furniture cannot be invented',
        ),
      );
    }
    if (ctx.author.kind !== 'user' && draft.locked === true) {
      return fail(err('precondition_failed', 'item/locked', `only the user can create locked items (existing furniture)`, 'omit "locked"'));
    }
  }
  if (scene.items.length >= LIMITS.items) return fail(err('limit_exceeded', 'item', `too many items (max ${LIMITS.items})`));
  const ids = allIds(scene);
  let id = draft.id;
  if (id === undefined) {
    let n = scene.items.length + 1;
    while (ids.has(`item-${n}`)) n++;
    id = `item-${n}`;
  } else if (ids.has(id)) {
    return fail(err('precondition_failed', 'item/id', `id "${id}" is already used`, 'omit the id to derive one, or use item.move / item.rotate'));
  }
  if (draft.roomId !== undefined && !scene.rooms.some((r) => r.id === draft.roomId)) {
    return fail(err('unknown_entity', 'item/roomId', `unknown room "${draft.roomId}"`, unknownIdHint(draft.roomId, scene.rooms.map((r) => r.id), 'room')));
  }
  const parsed = parseItem({ ...draft, id }, 'item');
  if ('errors' in parsed) return fail(...parsed.errors);
  let item = parsed.item;
  if (item.roomId === undefined) {
    const containing = scene.rooms.find((r) => pointInPolygon(item.position, r.polygon, ROOM_TOLERANCE));
    if (containing) item = { ...item, roomId: containing.id };
  }
  if (item.roomId !== undefined && scene.items.filter((i) => i.roomId === item.roomId).length >= ITEMS_PER_ROOM_SOFT_CAP) {
    return fail(err('limit_exceeded', 'item', `room "${item.roomId}" already holds ${ITEMS_PER_ROOM_SOFT_CAP} items (the per-room limit)`, 'remove something first'));
  }
  if (!ctx.trusted && ctx.author.kind !== 'user') {
    const inconsistent = consistencyErrors(item, 'item');
    if (inconsistent.length) return fail(...inconsistent);
  }
  if (!ctx.trusted) {
    const problems = placementErrors(scene, item, 'item');
    if (problems.length) return fail(...problems);
  }
  const items = scene.items.slice();
  items.splice(Math.min(cmd.index ?? items.length, items.length), 0, item);
  // A lamp comes with its light (or the exact light an undo puts back).
  let lights = scene.lights;
  const lightIds: string[] = [];
  if (cmd.restoreLight !== undefined) {
    const restored = Light.safeParse(cmd.restoreLight.light);
    if (!restored.success || restored.data.itemId !== id) return fail(err('invalid_command', 'restoreLight', 'restoreLight must be a valid light of this item'));
    lights = lights.slice();
    lights.splice(Math.min(cmd.restoreLight.index, lights.length), 0, restored.data);
    lightIds.push(restored.data.id);
  } else if (cmd.autoLight !== false && lights.length < LIMITS.lights) {
    const light = linkedLightFor(item, freshLightId(scene, id), item.roomId, item.product?.name);
    if (light) {
      lights = [...lights, light];
      lightIds.push(light.id);
    }
  }
  return ok({ ...scene, items, lights }, [{ type: 'item.remove', id }], [id], lightIds);
}

/** The light of a lamp item (at most one per item), with its index. */
function linkedLight(scene: Scene, itemId: string): { light: Light; index: number } | undefined {
  const index = scene.lights.findIndex((l) => l.itemId === itemId);
  return index < 0 ? undefined : { light: scene.lights[index]!, index };
}

/**
 * Puts the linked light of `item` back where the item says (position, height, room), deriving them with the same pure
 * function every time: so an item command and its inverse restore the light bit for bit. Unchanged lights keep identity.
 */
function syncLinked(scene: Scene, item: Item): { scene: Scene; lights: string[] } {
  const found = linkedLight(scene, item.id);
  if (!found || found.light.offset === undefined) return { scene, lights: [] };
  const pose = linkedLightPose(item, found.light.offset);
  const next: Record<string, unknown> = { ...found.light, position: pose.position, elevation: pose.elevation };
  if (item.roomId === undefined) delete next.roomId;
  else next.roomId = item.roomId;
  if (deepEqual(next, found.light)) return { scene, lights: [] };
  const lights = scene.lights.slice();
  lights[found.index] = next as Light;
  return { scene: { ...scene, lights }, lights: [found.light.id] };
}

function replaceItem(scene: Scene, index: number, item: Item): { scene: Scene; lights: string[] } {
  const items = scene.items.slice();
  items[index] = item;
  return syncLinked({ ...scene, items }, item);
}

/** Id of the light a new lamp item gets: `<item>-light`, else `light-N`, unique across all entities. */
function freshLightId(scene: Scene, itemId: string): string {
  const ids = allIds(scene);
  const base = `${itemId}-light`;
  if (base.length <= 64 && !ids.has(base)) return base;
  let n = scene.lights.length + 1;
  while (ids.has(`light-${n}`)) n++;
  return `light-${n}`;
}

function move(scene: Scene, cmd: Extract<ItemLeaf, { type: 'item.move' }>, ctx: Ctx): ItemOutcome {
  const found = findItem(scene, cmd.id);
  if (isErr(found)) return fail(found);
  const { item, index } = found;
  const locked = lockedError(item, ctx, 'moved');
  if (locked) return fail(locked);
  if (typeof cmd.roomId === 'string' && !scene.rooms.some((r) => r.id === cmd.roomId)) {
    return fail(err('unknown_entity', 'roomId', `unknown room "${cmd.roomId}"`, unknownIdHint(cmd.roomId, scene.rooms.map((r) => r.id), 'room')));
  }
  const next: Record<string, unknown> = { ...item, position: cmd.position as Vec2 };
  const inverse: Extract<LeafCommand, { type: 'item.move' }> = { type: 'item.move', id: item.id, position: item.position };
  if (cmd.elevation !== undefined) {
    next.elevation = cmd.elevation;
    inverse.elevation = item.elevation;
  }
  if (cmd.rotation !== undefined) {
    next.rotation = cmd.rotation;
    inverse.rotation = item.rotation;
  }
  if (cmd.roomId !== undefined) {
    if (cmd.roomId === null) delete next.roomId;
    else next.roomId = cmd.roomId;
    inverse.roomId = item.roomId ?? null;
  } else if (item.roomId !== undefined) {
    // The undo restores the room explicitly: an item may sit outside its declared room (the hall-facing
    // placard inside Chambre 2), and moving it back would otherwise "follow" it into the containing room.
    inverse.roomId = item.roomId;
    // dragged into another room: follow it, unless the new spot is still in the old room
    const current = scene.rooms.find((r) => r.id === item.roomId);
    // an item that stands outside its own room (the hall-facing placard of Chambre 2) must get its room back when it returns
    if (current && !pointInPolygon(item.position, current.polygon, ROOM_TOLERANCE)) inverse.roomId = item.roomId;
    if (current && !pointInPolygon(cmd.position, current.polygon, ROOM_TOLERANCE)) {
      const into = scene.rooms.find((r) => pointInPolygon(cmd.position, r.polygon, ROOM_TOLERANCE));
      if (into) {
        next.roomId = into.id;
        inverse.roomId = item.roomId;
      }
    }
  }
  if (cmd.relation !== undefined) {
    if (cmd.relation === null) delete next.relation;
    else next.relation = cmd.relation;
    inverse.relation = item.relation ?? null;
  }
  const parsed = parseItem(next, 'item');
  if ('errors' in parsed) return fail(...parsed.errors.map((e) => ({ ...e, path: e.path.replace(/^item/, '') || 'position' })));
  if (deepEqual(parsed.item, item)) return noop(scene);
  if (!ctx.trusted) {
    const problems = placementErrors(scene, parsed.item, 'position');
    if (problems.length) return fail(...problems);
  }
  const r = replaceItem(scene, index, parsed.item);
  return ok(r.scene, [inverse], [item.id], r.lights);
}

function rotate(scene: Scene, cmd: Extract<ItemLeaf, { type: 'item.rotate' }>, ctx: Ctx): ItemOutcome {
  const found = findItem(scene, cmd.id);
  if (isErr(found)) return fail(found);
  const { item, index } = found;
  const locked = lockedError(item, ctx, 'rotated');
  if (locked) return fail(locked);
  if (item.rotation === cmd.rotation) return noop(scene);
  const next: Item = { ...item, rotation: cmd.rotation };
  if (!ctx.trusted) {
    const problems = placementErrors(scene, next, 'rotation');
    if (problems.length) return fail(...problems);
  }
  const r = replaceItem(scene, index, next);
  return ok(r.scene, [{ type: 'item.rotate', id: item.id, rotation: item.rotation }], [item.id], r.lights);
}

function setVariant(scene: Scene, cmd: Extract<ItemLeaf, { type: 'item.setVariant' }>, ctx: Ctx): ItemOutcome {
  const found = findItem(scene, cmd.id);
  if (isErr(found)) return fail(found);
  const { item, index } = found;
  const locked = lockedError(item, ctx, 'changed');
  if (locked) return fail(locked);
  if (cmd.product !== undefined && item.product === undefined) {
    return fail(err('precondition_failed', 'product', `item "${item.id}" has no product snapshot to replace`, 'place the product with item.place, which stores its snapshot'));
  }
  const next: Record<string, unknown> = { ...item };
  const inverse: Extract<LeafCommand, { type: 'item.setVariant' }> = { type: 'item.setVariant', id: item.id, variant: item.variant ?? null };
  if (cmd.variant === null) delete next.variant;
  else next.variant = cmd.variant;
  if (cmd.product !== undefined) {
    next.product = cmd.product;
    // a variant is usually another article: keep productRef (when there is one) pointing at the product
    if (item.productRef !== undefined) next.productRef = { provider: cmd.product.provider, sku: cmd.product.sku };
    inverse.product = item.product!;
    // explicit dims stay in step with the new product (else they would be stale)
    if (cmd.dims === undefined && item.dims !== undefined) {
      next.dims = cmd.product.dims;
      inverse.dims = item.dims;
    }
  }
  if (cmd.dims !== undefined) {
    if (cmd.dims === null) delete next.dims;
    else next.dims = cmd.dims;
    inverse.dims = item.dims ?? null;
  }
  // The shape follows the dims: an explicit mesh wins; a parametric one is re-derived for the new size
  // (a lookalike is scaled by the viewer, a provider model is the product's own).
  const newDims = (next.dims as Item['dims']) ?? cmd.product?.dims ?? item.product?.dims;
  if (cmd.mesh !== undefined) {
    if (cmd.mesh === null) delete next.mesh;
    else {
      next.mesh = cmd.mesh;
      next.assetId = meshAssetId(cmd.mesh as never, (next.productRef as Item['productRef']) ?? undefined);
    }
    inverse.mesh = item.mesh ?? null;
  } else if (item.mesh?.kind === 'parametric' && newDims !== undefined && !sameDims(newDims, item.dims ?? item.product?.dims ?? newDims)) {
    const category = cmd.product?.category ?? item.product?.category;
    const def = category !== undefined ? defaultParametricFor(category, newDims, cmd.product?.name ?? item.product?.name) : undefined;
    if (def && checkParametricMesh(def, newDims).status === 'ok') {
      next.mesh = { kind: 'parametric', generator: def.generator, params: def.params };
      next.assetId = meshAssetId(next.mesh as never);
    } else {
      delete next.mesh;
    }
    inverse.mesh = item.mesh;
  }
  const parsed = parseItem(next, 'item');
  if ('errors' in parsed) return fail(...parsed.errors);
  if (deepEqual(parsed.item, item)) return noop(scene);
  if (!ctx.trusted && ctx.author.kind !== 'user' && (cmd.product !== undefined || (cmd.dims !== undefined && cmd.dims !== null))) {
    const inconsistent = consistencyErrors(parsed.item, 'item');
    if (inconsistent.length) return fail(...inconsistent);
  }
  if (!ctx.trusted && !deepEqual(itemDims(parsed.item), itemDims(item))) {
    const problems = placementErrors(scene, parsed.item, 'dims');
    if (problems.length) return fail(...problems);
  }
  const r = replaceItem(scene, index, parsed.item);
  return ok(r.scene, [inverse], [item.id], r.lights);
}

function remove(scene: Scene, cmd: Extract<ItemLeaf, { type: 'item.remove' }>, ctx: Ctx): ItemOutcome {
  const found = findItem(scene, cmd.id);
  if (isErr(found)) return fail(found);
  const { item, index } = found;
  const locked = lockedError(item, ctx, 'removed');
  if (locked) return fail(locked);
  const linked = linkedLight(scene, item.id);
  const next = { ...scene, items: scene.items.filter((_, i) => i !== index), lights: linked ? scene.lights.filter((_, i) => i !== linked.index) : scene.lights };
  const inverse: LeafCommand = linked
    ? { type: 'item.place', item, index, restoreLight: { light: linked.light, index: linked.index } }
    : { type: 'item.place', item, index, autoLight: false };
  return ok(next, [inverse], [item.id], linked ? [linked.light.id] : []);
}

/** Reducer for the five item commands. Pure: returns a new scene (untouched entities keep their identity). */
export function applyItemCommand(scene: Scene, cmd: ItemLeaf, ctx: Ctx): ItemOutcome {
  switch (cmd.type) {
    case 'item.place': return place(scene, cmd, ctx);
    case 'item.move': return move(scene, cmd, ctx);
    case 'item.rotate': return rotate(scene, cmd, ctx);
    case 'item.setVariant': return setVariant(scene, cmd, ctx);
    case 'item.remove': return remove(scene, cmd, ctx);
  }
}
