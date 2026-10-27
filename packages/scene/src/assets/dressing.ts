import type { MeshData } from '../geometry/types';
import type { Item } from '../schema';
import { Kit } from './generators/kit';
import { ITEM_MATERIALS } from './item-materials';

/**
 * Visual "dressing" of a placed product: parts the viewer DRAWS next to the real model although they are not
 * bought with it. Today: a mattress, a duvet and pillows on a bed FRAME (IKEA sells KLEPPSTAD, MALM... as frames
 * only, so their 3D models show bare slats). The dressing is not an item: it is never in the bill of materials,
 * has no price and does not take part in collisions. `Item.dressing: false` turns it off.
 */

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const FRAME_NAME = /\b(cadre de lit|cadre lit|cadre|structure de lit|structure|sommier|bed frame|bedframe|bedstead|frame)\b/;
const MATTRESS_NAME = /\b(matelas|mattress|surmatelas|topper)\b/;
/** A bed frame as the shop names it: "KLEPPSTAD Cadre de lit", "MALM Cadre lit", "bed frame". */
export function isBedFrameName(name: string): boolean {
  const n = fold(name);
  return FRAME_NAME.test(n) && !MATTRESS_NAME.test(n);
}

/** What the item is dressed with, or undefined: not a bed frame, a parametric bed (it has its own mattress), or `dressing: false`. */
export interface BedDressingSpec {
  /** Mattress footprint (m) and where the slat bed top is (m above the floor). */
  mattress: { w: number; d: number };
  /** Frame outer dims, the dressing is drawn inside them. */
  frame: { w: number; d: number; h: number };
  slatTop: number;
}

/** Mattress thickness, m. */
export const MATTRESS_THICKNESS = 0.2;
/** Slat height of a typical frame, m (a lower frame gets a proportionally lower one). */
const SLAT_TOP = 0.3;

/** The sleeping surface "160x200" of a name, in metres (width x length), when it states one. */
export function sleepingSurfaceOf(name: string): { w: number; d: number } | undefined {
  const m = /(\d{2,3})\s*[x×]\s*(\d{3})(?!\d)/.exec(name);
  if (!m) return undefined;
  const w = Number(m[1]) / 100;
  const d = Number(m[2]) / 100;
  return w >= 0.6 && w <= 2.2 && d >= 1.6 && d <= 2.4 ? { w, d } : undefined;
}

export function bedDressingOf(item: Pick<Item, 'dressing' | 'dims' | 'product' | 'mesh'>): BedDressingSpec | undefined {
  if (item.dressing === false) return undefined;
  const p = item.product;
  if (!p || p.category !== 'bed' || !isBedFrameName(p.name)) return undefined;
  if (item.mesh?.kind === 'parametric') return undefined; // the generated bed has its own mattress
  const dims = item.dims ?? p.dims;
  const named = sleepingSurfaceOf(p.name);
  // The frame is a few cm wider than the mattress and a headboard thicker than the mattress is long.
  const w = Math.min(dims.w - 0.02, named?.w ?? dims.w - 0.06);
  const d = Math.min(dims.d - 0.02, named?.d ?? dims.d - 0.07);
  if (w < 0.5 || d < 1.4) return undefined;
  return { mattress: { w, d }, frame: dims, slatTop: Math.min(SLAT_TOP, dims.h * 0.6) };
}

/** Mattress, duvet and pillows in the item frame (head at the back, -z). */
export function buildBedDressing(spec: BedDressingSpec): MeshData {
  const { mattress: m, frame, slatTop } = spec;
  const kit = new Kit();
  const x0 = -m.w / 2;
  const x1 = m.w / 2;
  // Foot flush with the frame, head against the headboard.
  const z1 = frame.d / 2;
  const z0 = z1 - m.d;
  const top = slatTop + MATTRESS_THICKNESS;
  kit.box(ITEM_MATERIALS.whiteMatte, x0, slatTop, z0, x1, top, z1, 0.03);
  // Duvet: over the lower two thirds, hanging 12 cm down the sides and the foot (inside the frame footprint).
  const dz0 = z0 + m.d * 0.34;
  const duvetT = 0.07;
  const over = 0.02;
  kit.box(ITEM_MATERIALS.bedding, x0 - over, top, dz0, x1 + over, top + duvetT, z1, 0.03);
  const drop = 0.12;
  kit.box(ITEM_MATERIALS.bedding, x0 - over, top - drop, dz0, x0, top, z1, 0.015);
  kit.box(ITEM_MATERIALS.bedding, x1, top - drop, dz0, x1 + over, top, z1, 0.015);
  kit.box(ITEM_MATERIALS.bedding, x0 - over, top - drop, z1 - over, x1 + over, top, z1, 0.015);
  // Pillows against the headboard.
  const pillows = m.w >= 1.3 ? 2 : 1;
  const pw = Math.min(0.62, (m.w - 0.1) / pillows - 0.04);
  for (let i = 0; i < pillows; i++) {
    const cx = ((i + 0.5) / pillows - 0.5) * m.w;
    kit.box(ITEM_MATERIALS.whiteMatte, cx - pw / 2, top, z0 + 0.04, cx + pw / 2, top + 0.13, z0 + 0.04 + 0.4, 0.04);
  }
  return kit.build();
}
