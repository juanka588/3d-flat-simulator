import { deltaE2000, hexToLab, type Cluster } from './color';
import type { Rgba } from './png';

/**
 * The pure metrics of `score_against_reference` (CG5): palette (k-means in Lab, ΔE2000), layout (box IoU per category) and the
 * weighted overall score. Nothing here touches the network, the renderer or the scene server.
 */

// -- weights -------------------------------------------------------------------------------------------------------------

export const METRICS = ['palette', 'layout', 'clip', 'aesthetic'] as const;
export type Metric = (typeof METRICS)[number];
export type ScoreWeights = Record<Metric, number>;

/** Palette and layout say "does it look like the target", CLIP says it as a whole picture, aesthetic is a weak taste signal. */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = { palette: 0.3, layout: 0.3, clip: 0.3, aesthetic: 0.1 };

/** `FLAT_SCORE_WEIGHTS="palette=0.3,layout=0.3,clip=0.3,aesthetic=0.1"`; unknown or bad entries are ignored (reported in `ignored`). */
export function parseScoreWeights(value: string | undefined): { weights: ScoreWeights; ignored: string[] } {
  const weights = { ...DEFAULT_SCORE_WEIGHTS };
  const ignored: string[] = [];
  for (const part of (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split('=').map((s) => s.trim());
    const n = Number(v);
    if ((METRICS as readonly string[]).includes(k ?? '') && v !== undefined && v !== '' && Number.isFinite(n) && n >= 0) weights[k as Metric] = n;
    else ignored.push(part);
  }
  if (METRICS.every((m) => weights[m] === 0)) return { weights: { ...DEFAULT_SCORE_WEIGHTS }, ignored: [...ignored, 'all weights were 0'] };
  return { weights, ignored };
}

export interface Overall {
  /** 0 to 1, or null when no metric was available. */
  score: number | null;
  /** The weights actually used, renormalised over the metrics that were available (they add up to 1). */
  used: Partial<ScoreWeights>;
  missing: Metric[];
}

/** The weighted sum over the available metrics (a metric that could not be computed is left out and the rest renormalised). */
export function overallScore(parts: Partial<Record<Metric, number | null | undefined>>, weights: ScoreWeights): Overall {
  const have = METRICS.filter((m) => typeof parts[m] === 'number' && Number.isFinite(parts[m]) && weights[m] > 0);
  const missing = METRICS.filter((m) => !have.includes(m) && weights[m] > 0);
  const total = have.reduce((s, m) => s + weights[m], 0);
  if (!have.length || total === 0) return { score: null, used: {}, missing };
  const used: Partial<ScoreWeights> = {};
  let score = 0;
  for (const m of have) {
    used[m] = round(weights[m] / total, 4);
    score += (weights[m] / total) * clamp01(parts[m] as number);
  }
  return { score: round(score, 4), used, missing };
}

export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
export const round = (x: number, d = 3): number => Math.round(x * 10 ** d) / 10 ** d;

// -- palette -------------------------------------------------------------------------------------------------------------

/** A ΔE2000 of this size or more scores 0 (about "a different colour family"). */
export const PALETTE_DE_ZERO = 30;
/** Weight of a difference in area share, in ΔE units per 100 % of the image, when pairing clusters. */
const AREA_PAIR_COST = 40;

export interface PalettePair {
  target: { hex: string; area: number };
  ours: { hex: string; area: number };
  deltaE: number;
}
export interface RoleDelta {
  role: string;
  /** The colour the descriptor gave the role. */
  describedHex: string;
  /** The target image's colour for it (the nearest k-means cluster). */
  targetHex: string;
  oursHex: string;
  deltaE: number;
  areaPct: number;
}
export interface PaletteResult {
  score: number;
  /** ΔE2000 averaged over the target's clusters, weighted by their area. */
  meanDeltaE: number;
  pairs: PalettePair[];
  roles: RoleDelta[];
}

/** Pairs the target's clusters (largest first) with ours: the nearest unused cluster in Lab, with a small penalty for a different area share. */
export function comparePalettes(target: Cluster[], ours: Cluster[], described: { hex: string; role: string; areaPct: number }[] = []): PaletteResult {
  const used = new Set<number>();
  const pairOf = new Map<number, number>();
  const pairs: PalettePair[] = [];
  target.forEach((t, ti) => {
    let best = -1;
    let bestCost = Infinity;
    ours.forEach((o, oi) => {
      if (used.has(oi)) return;
      const cost = deltaE2000(t.lab, o.lab) + AREA_PAIR_COST * Math.abs(t.area - o.area);
      if (cost < bestCost) {
        bestCost = cost;
        best = oi;
      }
    });
    if (best < 0) best = ours.length ? nearest(t, ours) : -1; // more target clusters than ours: reuse the nearest
    if (best < 0) return;
    used.add(best);
    pairOf.set(ti, best);
    pairs.push({ target: { hex: t.hex, area: round(t.area) }, ours: { hex: ours[best]!.hex, area: round(ours[best]!.area) }, deltaE: round(deltaE2000(t.lab, ours[best]!.lab), 2) });
  });
  const totalArea = target.reduce((s, c) => s + c.area, 0) || 1;
  const meanDeltaE = pairs.length ? pairs.reduce((s, p, i) => s + p.deltaE * target[i]!.area, 0) / totalArea : PALETTE_DE_ZERO;
  const roles: RoleDelta[] = [];
  for (const d of described) {
    let lab;
    try {
      lab = hexToLab(d.hex);
    } catch {
      continue;
    }
    let ti = -1;
    let bd = Infinity;
    target.forEach((t, i) => {
      const e = deltaE2000(lab, t.lab);
      if (e < bd) {
        bd = e;
        ti = i;
      }
    });
    const oi = pairOf.get(ti);
    if (ti < 0 || oi === undefined) continue;
    roles.push({ role: d.role, describedHex: d.hex.toLowerCase(), targetHex: target[ti]!.hex, oursHex: ours[oi]!.hex, deltaE: round(deltaE2000(target[ti]!.lab, ours[oi]!.lab), 2), areaPct: d.areaPct });
  }
  return { score: round(clamp01(1 - meanDeltaE / PALETTE_DE_ZERO), 4), meanDeltaE: round(meanDeltaE, 2), pairs, roles };
}

function nearest(t: Cluster, ours: Cluster[]): number {
  let best = -1;
  let bd = Infinity;
  ours.forEach((o, i) => {
    const d = deltaE2000(t.lab, o.lab);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

// -- layout --------------------------------------------------------------------------------------------------------------

export type Box = [number, number, number, number];

export function boxArea(b: Box): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

export function boxIou(a: Box, b: Box): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** IoU of two SETS of boxes (the area covered by any box of each), rasterised on a coarse grid of the image. */
export function unionIou(a: Box[], b: Box[], size: { width: number; height: number }, cells = 96): number {
  const gx = cells;
  const gy = Math.max(1, Math.round((cells * size.height) / size.width));
  const paint = (boxes: Box[]) => {
    const g = new Uint8Array(gx * gy);
    for (const [x0, y0, x1, y1] of boxes)
      for (let j = Math.max(0, Math.floor((y0 / size.height) * gy)); j < Math.min(gy, Math.ceil((y1 / size.height) * gy)); j++)
        for (let i = Math.max(0, Math.floor((x0 / size.width) * gx)); i < Math.min(gx, Math.ceil((x1 / size.width) * gx)); i++) g[j * gx + i] = 1;
    return g;
  };
  const ga = paint(a);
  const gb = paint(b);
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < ga.length; i++) {
    if (ga[i] && gb[i]) inter++;
    if (ga[i] || gb[i]) uni++;
  }
  return uni ? inter / uni : 0;
}

export interface RefItem {
  id: string;
  category: string;
  subtype: string;
  box: Box;
  importance: number;
}
export interface OurItem {
  id: string;
  category: string;
  name: string;
  box: Box;
  pixels: number;
  /** Existing locked furniture: counted when it matches, never reported as extra. */
  locked?: boolean;
}
export interface CategoryIou {
  category: string;
  /** IoU of the area the category covers in the target and in ours. */
  iou: number;
  target: number;
  ours: number;
}
export interface LayoutResult {
  score: number;
  perCategory: CategoryIou[];
  matched: { target: string; ours: string; iou: number }[];
  /** Target items of a category that ours does not have at all. */
  missing: { id: string; category: string; subtype: string; importance: number }[];
  /** Target items whose category is present in ours, but not where the target has it (IoU below the match threshold). */
  misplaced: { id: string; category: string; subtype: string; importance: number; bestIou: number }[];
  /** Our items that match no target item. */
  extra: { id: string; category: string; name: string }[];
}

/** A pair of boxes of one category counts as the same item from this IoU on. */
export const MATCH_IOU = 0.1;
const EXTRA_PENALTY = 0.03;

export function compareLayouts(target: RefItem[], ours: OurItem[], size: { width: number; height: number }): LayoutResult {
  const pairs: { t: number; o: number; iou: number }[] = [];
  target.forEach((t, ti) =>
    ours.forEach((o, oi) => {
      if (t.category === o.category) pairs.push({ t: ti, o: oi, iou: boxIou(t.box, o.box) });
    }),
  );
  pairs.sort((a, b) => b.iou - a.iou || a.t - b.t || a.o - b.o);
  const tDone = new Set<number>();
  const oDone = new Set<number>();
  const matched: LayoutResult['matched'] = [];
  const iouOf = new Map<number, number>();
  for (const p of pairs) {
    if (p.iou < MATCH_IOU || tDone.has(p.t) || oDone.has(p.o)) continue;
    tDone.add(p.t);
    oDone.add(p.o);
    iouOf.set(p.t, p.iou);
    matched.push({ target: target[p.t]!.id, ours: ours[p.o]!.id, iou: round(p.iou) });
  }
  const bestIou = (ti: number) => Math.max(0, ...ours.filter((o) => o.category === target[ti]!.category).map((o) => boxIou(target[ti]!.box, o.box)));
  const missing: LayoutResult['missing'] = [];
  const misplaced: LayoutResult['misplaced'] = [];
  target.forEach((t, ti) => {
    if (tDone.has(ti)) return;
    const info = { id: t.id, category: t.category, subtype: t.subtype, importance: t.importance };
    if (ours.some((o) => o.category === t.category)) misplaced.push({ ...info, bestIou: round(bestIou(ti)) });
    else missing.push(info);
  });
  // An unmatched item of ours whose category the target has unmatched too is the misplaced counterpart, not an extra.
  const spare = new Map<string, number>();
  for (const m of misplaced) spare.set(m.category, (spare.get(m.category) ?? 0) + 1);
  const extra = ours.flatMap((o, oi) => {
    if (oDone.has(oi) || o.locked) return [];
    const left = spare.get(o.category) ?? 0;
    if (left > 0) {
      spare.set(o.category, left - 1);
      return [];
    }
    return [{ id: o.id, category: o.category, name: o.name }];
  });
  const weight = target.reduce((s, t) => s + t.importance, 0);
  const weighted = target.reduce((s, t, ti) => s + t.importance * (iouOf.get(ti) ?? 0), 0);
  const base = weight ? weighted / weight : 0;
  const categories = [...new Set([...target.map((t) => t.category), ...ours.map((o) => o.category)])].sort();
  const perCategory = categories.map<CategoryIou>((c) => {
    const tb = target.filter((t) => t.category === c);
    const ob = ours.filter((o) => o.category === c);
    return { category: c, iou: round(unionIou(tb.map((t) => t.box), ob.map((o) => o.box), size)), target: tb.length, ours: ob.length };
  });
  return { score: round(clamp01(base - EXTRA_PENALTY * extra.length), 4), perCategory, matched, missing, misplaced, extra };
}

// -- instance boxes ------------------------------------------------------------------------------------------------------

export interface InstanceLegendEntry {
  color: [number, number, number];
  id: string;
  kind: string;
  class: string;
  detail?: string;
}

/** The pixel bounding box of each item entity in an `instances` pass (exact colour match), ignoring specks below `minPixels`. */
export function itemBoxes(instances: Rgba, legend: InstanceLegendEntry[], minPixels = 40): Map<string, { box: Box; pixels: number }> {
  const byColour = new Map<number, InstanceLegendEntry>();
  for (const e of legend) if (e.kind === 'item') byColour.set((e.color[0] << 16) | (e.color[1] << 8) | e.color[2], e);
  const acc = new Map<number, { x0: number; y0: number; x1: number; y1: number; n: number }>();
  const { width, height, data } = instances;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
      if (!byColour.has(key)) continue;
      const a = acc.get(key);
      if (!a) acc.set(key, { x0: x, y0: y, x1: x + 1, y1: y + 1, n: 1 });
      else {
        if (x < a.x0) a.x0 = x;
        if (y < a.y0) a.y0 = y;
        if (x + 1 > a.x1) a.x1 = x + 1;
        if (y + 1 > a.y1) a.y1 = y + 1;
        a.n++;
      }
    }
  const out = new Map<string, { box: Box; pixels: number }>();
  for (const [key, a] of acc) if (a.n >= minPixels) out.set(byColour.get(key)!.id, { box: [a.x0, a.y0, a.x1, a.y1], pixels: a.n });
  return out;
}

// -- machine diff list ---------------------------------------------------------------------------------------------------

export interface DiffInput {
  palette?: PaletteResult | undefined;
  layout?: LayoutResult | undefined;
  clip?: { cosine: number } | undefined;
  aesthetic?: { ours: number; target: number } | undefined;
}

/** ΔE at which a role is listed; layout items above this importance lead the list. */
export const ROLE_DE_REPORT = 8;

/** Short, ordered fixes' raw material: "wall palette ΔE 18 (target sage #A8B5A0)", "missing: rug (importance 4)", "extra: armchair". */
export function diffList(d: DiffInput): string[] {
  const out: string[] = [];
  const missing = [...(d.layout?.missing ?? [])].sort((a, b) => b.importance - a.importance);
  for (const m of missing) out.push(`missing: ${m.subtype} (${m.category}, importance ${m.importance})`);
  const misplaced = [...(d.layout?.misplaced ?? [])].sort((a, b) => b.importance - a.importance);
  for (const m of misplaced) out.push(`misplaced: ${m.subtype} (${m.category}, importance ${m.importance}, overlap ${m.bestIou} with the target spot)`);
  const roles = [...(d.palette?.roles ?? [])].filter((r) => r.deltaE >= ROLE_DE_REPORT).sort((a, b) => b.deltaE * b.areaPct - a.deltaE * a.areaPct);
  for (const r of roles) out.push(`${r.role} palette ΔE ${Math.round(r.deltaE)} (target ${r.targetHex}, ours ${r.oursHex})`);
  if (!d.palette?.roles.length && d.palette && d.palette.meanDeltaE >= ROLE_DE_REPORT) out.push(`palette ΔE ${Math.round(d.palette.meanDeltaE)} overall (main target colours ${d.palette.pairs.slice(0, 3).map((p) => p.target.hex).join(' ')})`);
  for (const e of d.layout?.extra ?? []) out.push(`extra: ${e.name || e.category} (${e.category})`);
  if (d.clip && d.clip.cosine < 0.6) out.push(`overall look differs from the target (CLIP similarity ${round(d.clip.cosine, 2)})`);
  if (d.aesthetic && d.aesthetic.ours < d.aesthetic.target - 0.5) out.push(`aesthetic score ${round(d.aesthetic.ours, 1)} vs target ${round(d.aesthetic.target, 1)}`);
  return out;
}
