import { MATTRESS_THICKNESS, bedDressingOf } from '../items/dressing';
import type { Dims } from '../primitives';
import type { Item, Vec2 } from '../schema';
import { FLAT_MAX_H, footprintOf, itemDims, itemMountOf, localToPlan, round4 } from './footprint';

/**
 * Items standing on other items (relation "on"): which things may go on which, and the height and spot of the top.
 * Pure helpers shared by the relation resolver and the solver.
 */

/** Things that stand on furniture (a nightstand, table, shelf, desk, sideboard...). */
const ON_FURNITURE: ReadonlySet<string> = new Set(['lamp', 'vase', 'plant', 'frame', 'decor']);
/** Things that lie on seats and beds. */
const ON_SEATING: ReadonlySet<string> = new Set(['cushion', 'throw']);
/** Supports for cushions and throws. */
const SEATING: ReadonlySet<string> = new Set(['sofa', 'armchair', 'chair', 'bed']);
/** Supports for lamps, vases, plants, frames and decor. */
const FURNITURE: ReadonlySet<string> = new Set(['bedside', 'drawers', 'shelf', 'sideboard', 'tv_unit', 'table', 'desk', 'wardrobe', 'kitchen', 'other']);
/** Lamps taller than this are floor lamps: they do not stand on furniture. */
export const MAX_TABLE_LAMP_H = 0.8;
/** Duvet and pillows on a dressed bed frame rise this far above the mattress. */
const DUVET_M = 0.05;
/** Seat height estimate of a sofa, armchair or chair, as a share of its height (capped). */
const SEAT_SHARE = 0.55;
const SEAT_MAX_M = 0.46;

/** Category of a support: its product's, else guessed from the id of its shape (legacy built-in assets). */
export function supportCategory(item: Pick<Item, 'assetId' | 'product'>): string | undefined {
  if (item.product) return item.product.category;
  const id = item.assetId.toLowerCase();
  if (/sofa|couch/.test(id)) return 'sofa';
  if (/armchair/.test(id)) return 'armchair';
  if (/bed\b|bed[-_:]/.test(id) && !/bedside/.test(id)) return 'bed';
  if (/chair|stool/.test(id)) return 'chair';
  if (/table|desk|shelf|nightstand|sideboard|drawers|wardrobe|cabinet/.test(id)) return 'table';
  return undefined;
}

/** What a thing of `category` may stand on, in words, for the error hint. */
export function standsOnHint(category: string | undefined): string {
  if (category !== undefined && ON_SEATING.has(category)) return 'a cushion or throw goes on a sofa, armchair, chair or bed';
  return 'lamps (table lamps), vases, plants, frames and decor go on furniture (nightstand, table, shelf, desk, sideboard, drawers, TV unit); cushions and throws go on a sofa or bed';
}

/** Why `item` (a thing of `category` and `dims`) cannot stand on `support`, or undefined when it can. */
export function whyNotOn(category: string | undefined, dims: Dims, support: Item): string | undefined {
  const sd = itemDims(support);
  if (itemMountOf(support) === 'ceiling') return `"${support.id}" hangs from the ceiling`;
  const sc = supportCategory(support);
  if (sc === 'rug' || (sd.h <= FLAT_MAX_H && itemMountOf(support) === 'floor')) return `"${support.id}" is a floor covering (rug), nothing stands on it as furniture; place it on the floor`;
  if (category !== undefined && ON_SEATING.has(category)) {
    return sc !== undefined && SEATING.has(sc) ? undefined : `a ${category} goes on a sofa, armchair, chair or bed, not on "${support.id}"${sc ? ` (${sc})` : ''}`;
  }
  if (category === 'lamp' && dims.h > MAX_TABLE_LAMP_H) return `this lamp is ${round4(dims.h)} m tall (a floor lamp); only table lamps up to ${MAX_TABLE_LAMP_H} m stand on furniture`;
  if (category !== undefined && !ON_FURNITURE.has(category)) return `a ${category} cannot stand on another item; ${standsOnHint(category)}`;
  if (sc !== undefined && SEATING.has(sc)) return `"${support.id}" is a ${sc}; only a cushion or throw goes on it`;
  if (sc !== undefined && !FURNITURE.has(sc)) return `"${support.id}" (${sc}) is not furniture to put things on`;
  if (sd.h < 0.2) return `"${support.id}" is only ${round4(sd.h)} m high`;
  return undefined;
}

/** Height of the top surface of `support` where things stand (floor to top): a seat for sofas and chairs, the mattress for a dressed bed. */
export function supportTop(support: Item): number {
  const d = itemDims(support);
  const sc = supportCategory(support);
  let top = d.h;
  if (sc === 'sofa' || sc === 'armchair' || sc === 'chair') top = Math.min(SEAT_MAX_M, d.h * SEAT_SHARE);
  else if (sc === 'bed') {
    const dress = bedDressingOf(support);
    if (dress) top = dress.slatTop + MATTRESS_THICKNESS + DUVET_M;
  }
  return round4(support.elevation + top);
}

/** Default offset on the top of a support: the centre; on a seat a little towards the front (away from the backrest). */
export function defaultOffset(support: Item): Vec2 {
  const sc = supportCategory(support);
  const d = itemDims(support);
  return sc === 'sofa' || sc === 'armchair' || sc === 'chair' ? [0, round4(d.d * 0.12)] : [0, 0];
}

/** Plan position of the spot `offset` on the top of `support`. */
export function spotOn(support: Item, offset: Vec2): Vec2 {
  const o = localToPlan(support.rotation, offset[0], offset[1]);
  return [round4(support.position[0] + o[0]), round4(support.position[1] + o[1])];
}

/**
 * Whether the footprint fits on the top of `support`: all four corners (a throw only needs its centre, it drapes over the edge).
 * Returns a message when it does not.
 */
export function fitOn(category: string | undefined, support: Item, position: Vec2, rotation: number, dims: Pick<Dims, 'w' | 'd'>): string | undefined {
  const sd = itemDims(support);
  const tol = 0.005;
  const frame = (p: Vec2): Vec2 => {
    const dx = p[0] - support.position[0];
    const dy = p[1] - support.position[1];
    const r = localToPlan(support.rotation, 1, 0);
    const f = localToPlan(support.rotation, 0, 1);
    return [dx * r[0] + dy * r[1], dx * f[0] + dy * f[1]];
  };
  const inside = (p: Vec2, slack: number) => {
    const [x, z] = frame(p);
    return Math.abs(x) <= sd.w / 2 + slack && Math.abs(z) <= sd.d / 2 + slack;
  };
  const pts = category === 'throw' ? [position] : footprintOf(position, rotation, dims);
  if (pts.every((p) => inside(p, tol))) return undefined;
  return category === 'throw'
    ? `the spot is off the edge of "${support.id}" (${round4(sd.w)} x ${round4(sd.d)} m)`
    : `${round4(dims.w)} x ${round4(dims.d)} m does not fit on top of "${support.id}", which is ${round4(sd.w)} x ${round4(sd.d)} m; use a smaller product or another offset`;
}
