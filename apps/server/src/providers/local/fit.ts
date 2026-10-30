import { DIMS_MISMATCH_LIMIT as SHARED_MISMATCH_LIMITS, HARD_DIMS_LIMIT, bothAxesOff, scaleDistortion, scaleSizeToDims } from '@flat/assets';
import type { Dims } from '@flat/scene';

/**
 * How well a model's bounding box fits a product's listed size. These are the SAME rules the viewer applies at load time
 * (the distortion maths shared through `@flat/assets` + the quarter-turn retry in `packages/viewer/src/model-controller.ts`), run here once
 * at build time so the catalogue only keeps models that will be drawn without a surprise. A parity test (`fit.test.ts`) pins the two together.
 *
 * Boxes are `[x, y, z]` sizes in metres; item dims are width (x), depth (z), height (y).
 */

export type { Dims };
export type Size3 = readonly [number, number, number];

/** Aspect distortion above which the viewer warns (`dims_mismatch`) for a provider model. */
export const DIMS_MISMATCH_LIMIT = SHARED_MISMATCH_LIMITS.provider;
/**
 * The catalogue is stricter than the viewer: a model more than 25% out of proportion with the listed size (the viewer's limit for
 * a lookalike) is dropped at build time (`has3d: false`) instead of being drawn stretched. 10-25% is kept and flagged `dims_mismatch`.
 */
export const CATALOG_REJECT_LIMIT = 0.25;
/** The viewer keeps the quarter-turned model only when it is clearly better. */
export const QUARTER_TURN_MARGIN = 0.05;

/** Per-axis scale and distortion: the shared maths of `@flat/assets` (the viewer uses the very same functions). */
export const scaleToDims = scaleSizeToDims;
export { HARD_DIMS_LIMIT, scaleDistortion };

export const distortionOf = (size: Size3, dims: Dims): number => scaleDistortion(scaleToDims(size, dims));

export type FitVerdict = 'ok' | 'warn' | 'reject';

export interface FitChoice {
  /** Bake a quarter turn about +y (swap the model's x and z extents): the long side ran along the other axis than the shop's width/depth. */
  quarterTurn: boolean;
  distortion: number;
  /** Size after the optional quarter turn: [x, y, z]. */
  size: [number, number, number];
  verdict: FitVerdict;
  /** When rejected: the human reason (`catalog:status` shows it). */
  reason?: string;
  /** Which of the 6 axis permutations would fit best, when no yaw-only rotation does (a model lying on its side: not repaired, only reported). */
  betterAxes?: string;
  /** Overall dims taken from the model (a headboard / overhang wider than the listed frame): the record's dims must be replaced by these. */
  dims?: Dims;
  /** Why `dims` differ from the listed ones: `model` (overall size of the model) or `swap` (the shop lists a desk's length as its depth: width and depth exchanged instead of turning the model). */
  dimsFrom?: 'model' | 'swap';
}

/** What the product is, for the rules that depend on the type (the shop's type name, the product name, our category). */
export interface FitHint {
  category?: string;
  typeName?: string;
  name?: string;
}

/** Products whose listed w x d describe the frame/body only and whose model legitimately sticks out of it: beds (headboard, footboard), desks with a return, corner units. */
const OVERHANG_WORDS = /\b(lit|lits|bed|beds|tete de lit|bureau|desk|angle|corner|chaise longue|meridienne)\b/;
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function mayOverhang(hint: FitHint = {}): boolean {
  if (hint.category === 'bed') return true;
  return OVERHANG_WORDS.test(fold(`${hint.typeName ?? ''} ${hint.name ?? ''}`));
}
/** Products with a front that the shop lists "length x width" (a desk 140 x 60 is stored as d 1.4): turning the model would put its front on a short side, so the listed w and d are swapped instead. */
export const swapsInsteadOfTurning = (hint: FitHint = {}): boolean => hint.category === 'desk';
/** For those types a quarter turn must give a near-exact fit. */
export const OVERHANG_TURN_LIMIT = 0.05;
/** Model/listed ratios between which a bigger model is taken as the true overall size (headboard, overhang) rather than a wrong model. */
const OVERHANG_RATIO: readonly [number, number] = [0.9, 1.8];
const OVERHANG_MIN_GAIN = 1.25;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

const PERMS: { name: string; pick: (s: Size3) => [number, number, number] }[] = [
  { name: 'x,y,z', pick: (s) => [s[0], s[1], s[2]] },
  { name: 'z,y,x', pick: (s) => [s[2], s[1], s[0]] },
  { name: 'x,z,y', pick: (s) => [s[0], s[2], s[1]] },
  { name: 'y,x,z', pick: (s) => [s[1], s[0], s[2]] },
  { name: 'y,z,x', pick: (s) => [s[1], s[2], s[0]] },
  { name: 'z,x,y', pick: (s) => [s[2], s[0], s[1]] },
];

/**
 * Chooses between the model as it is and turned a quarter (the viewer's retry), and judges the result:
 * `ok` (<= 10%), `warn` (<= 25%, drawn with a `dims_mismatch` warning) or `reject` (> 25%: dropped from the catalogue; the viewer itself only refuses above 50%).
 */
export function chooseFit(size: Size3, dims: Dims, hint: FitHint = {}): FitChoice {
  const overhang = mayOverhang(hint);
  const asIs = distortionOf(size, dims);
  const turned: [number, number, number] = [size[2], size[1], size[0]];
  const alt = distortionOf(turned, dims);
  // The model's authored orientation (IKEA models face +z, width along x) is the primary signal: turn only when it is wrong in BOTH
  // axes and the turned model fits; a type with parts beyond its frame needs a near-exact fit for that.
  const quarterTurn = asIs > DIMS_MISMATCH_LIMIT && bothAxesOff(size, dims) && alt + QUARTER_TURN_MARGIN < asIs && (!overhang || alt <= OVERHANG_TURN_LIMIT);
  const swap = quarterTurn && swapsInsteadOfTurning(hint);
  const turn = quarterTurn && !swap;
  let distortion = quarterTurn ? alt : asIs;
  const final: [number, number, number] = turn ? turned : [size[0], size[1], size[2]];
  let adopted: Dims | undefined;
  let dimsFrom: 'model' | 'swap' | undefined;
  if (swap) {
    adopted = { w: dims.d, d: dims.w, h: dims.h };
    dimsFrom = 'swap';
  } else if (overhang && distortion > DIMS_MISMATCH_LIMIT) {
    const ratios = [final[0] / dims.w, final[1] / dims.h, final[2] / dims.d];
    if (ratios.every((q) => q >= OVERHANG_RATIO[0] && q <= OVERHANG_RATIO[1]) && Math.max(...ratios) >= OVERHANG_MIN_GAIN) {
      adopted = { w: r3(final[0]), d: r3(final[2]), h: r3(final[1]) };
      distortion = 0;
      dimsFrom = 'model';
    }
  }
  const verdict: FitVerdict = distortion > CATALOG_REJECT_LIMIT || !Number.isFinite(distortion) ? 'reject' : distortion > DIMS_MISMATCH_LIMIT ? 'warn' : 'ok';
  const out: FitChoice = { quarterTurn: turn, distortion, size: final, verdict, ...(adopted ? { dims: adopted, dimsFrom: dimsFrom! } : {}) };
  if (verdict === 'reject') {
    const best = PERMS.map((p) => ({ name: p.name, d: distortionOf(p.pick(size), dims) })).sort((a, b) => a.d - b.d)[0]!;
    if (best.name !== 'x,y,z' && best.name !== 'z,y,x' && best.d <= DIMS_MISMATCH_LIMIT) out.betterAxes = best.name;
    out.reason = out.betterAxes
      ? `the model lies on its side (its axes ${out.betterAxes} match the listed size); not usable as shipped`
      : `model proportions (${size.map((v) => Math.round(v * 100)).join('x')} cm) do not match the listed size (${[dims.w, dims.h, dims.d].map((v) => Math.round(v * 100)).join('x')} cm w x h x d): ${Number.isFinite(distortion) ? Math.round(distortion * 100) : '?'}% distortion`;
  }
  return out;
}
