/**
 * How well a model's bounding box fits a product's listed size. These are the SAME rules the viewer applies at load time
 * (`apps/web/src/viewer/model-math.ts` + the quarter-turn retry in `model-controller.ts`), run here once at build time so the
 * catalogue only keeps models that will be drawn without a surprise. A parity test (`fit.test.ts`) pins the two together.
 *
 * Boxes are `[x, y, z]` sizes in metres; item dims are width (x), depth (z), height (y).
 */

export interface Dims {
  w: number;
  d: number;
  h: number;
}
export type Size3 = readonly [number, number, number];

/** Aspect distortion above which the viewer warns (`dims_mismatch`) for a provider model. */
export const DIMS_MISMATCH_LIMIT = 0.1;
/** Distortion above which the viewer refuses the model altogether. */
export const HARD_DIMS_LIMIT = 0.5;
/**
 * The catalogue is stricter than the viewer: a model more than 25% out of proportion with the listed size (the viewer's limit for
 * a lookalike) is dropped at build time (`has3d: false`) instead of being drawn stretched. 10-25% is kept and flagged `dims_mismatch`.
 */
export const CATALOG_REJECT_LIMIT = 0.25;
/** The viewer keeps the quarter-turned model only when it is clearly better. */
export const QUARTER_TURN_MARGIN = 0.05;

/** Per-axis scale from a model of `size` (x, y, z) to `dims`; an axis the model has no extent on is left at 1. */
export function scaleToDims(size: Size3, dims: Dims): [number, number, number] {
  const pick = (target: number, native: number) => (native > 1e-9 ? target / native : 1);
  return [pick(dims.w, size[0]), pick(dims.h, size[1]), pick(dims.d, size[2])];
}

/** Largest relative deviation of an axis scale from their geometric mean (0 = uniform scale). */
export function scaleDistortion(scale: readonly number[]): number {
  const g = Math.cbrt(scale[0]! * scale[1]! * scale[2]!);
  if (!(g > 0)) return Infinity;
  return Math.max(...scale.map((s) => Math.abs(s / g - 1)));
}

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
}

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
export function chooseFit(size: Size3, dims: Dims): FitChoice {
  const asIs = distortionOf(size, dims);
  const turned: [number, number, number] = [size[2], size[1], size[0]];
  const alt = distortionOf(turned, dims);
  const quarterTurn = asIs > DIMS_MISMATCH_LIMIT && alt + QUARTER_TURN_MARGIN < asIs;
  const distortion = quarterTurn ? alt : asIs;
  const final: [number, number, number] = quarterTurn ? turned : [size[0], size[1], size[2]];
  const verdict: FitVerdict = distortion > CATALOG_REJECT_LIMIT || !Number.isFinite(distortion) ? 'reject' : distortion > DIMS_MISMATCH_LIMIT ? 'warn' : 'ok';
  const out: FitChoice = { quarterTurn, distortion, size: final, verdict };
  if (verdict === 'reject') {
    const best = PERMS.map((p) => ({ name: p.name, d: distortionOf(p.pick(size), dims) })).sort((a, b) => a.d - b.d)[0]!;
    if (best.name !== 'x,y,z' && best.name !== 'z,y,x' && best.d <= DIMS_MISMATCH_LIMIT) out.betterAxes = best.name;
    out.reason = out.betterAxes
      ? `the model lies on its side (its axes ${out.betterAxes} match the listed size); not usable as shipped`
      : `model proportions (${size.map((v) => Math.round(v * 100)).join('x')} cm) do not match the listed size (${[dims.w, dims.h, dims.d].map((v) => Math.round(v * 100)).join('x')} cm w x h x d): ${Number.isFinite(distortion) ? Math.round(distortion * 100) : '?'}% distortion`;
  }
  return out;
}
