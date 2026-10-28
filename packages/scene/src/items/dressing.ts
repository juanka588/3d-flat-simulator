import type { Item } from '../schema';

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
