/**
 * Blank-capture detection. A render that comes back as one flat colour (the page background, the sky, black)
 * is a failed render, not a picture: the model cannot read it and the user sees "nothing". The page sends a
 * small RGBA thumbnail of its capture; this module decides whether it shows anything.
 */

export interface PixelStats {
  /** Standard deviation of the luma (0-255). A real render of the flat is far above 10; one colour is 0. */
  stddev: number;
  /** Mean luma (0-255). */
  mean: number;
  /** Distinct colours after quantising each channel to 4 bits (at most 4096). */
  colors: number;
  /** Share of the pixels that have the most common quantised colour (0-1). */
  topShare: number;
  pixels: number;
}

export const BLANK_LIMITS = {
  /** Below this luma deviation the image is considered flat. */
  minStddev: 2,
  /** Fewer distinct quantised colours than this is not a picture of a flat. */
  minColors: 8,
  /** One colour covering this much of the image is a blank with noise. */
  maxTopShare: 0.995,
} as const;

/** Statistics of an RGBA buffer (alpha ignored). Pure. */
export function analyzeThumb(rgba: ArrayLike<number>): PixelStats {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return { stddev: 0, mean: 0, colors: 0, topShare: 1, pixels: 0 };
  const bins = new Map<number, number>();
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    sumSq += luma * luma;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  let top = 0;
  for (const c of bins.values()) if (c > top) top = c;
  return { stddev: Math.sqrt(variance), mean, colors: bins.size, topShare: top / n, pixels: n };
}

/** Why the image counts as blank, or undefined when it shows something. */
export function describeBlank(stats: PixelStats): string | undefined {
  const { minStddev, minColors, maxTopShare } = BLANK_LIMITS;
  const what = `${stats.colors} colour${stats.colors === 1 ? '' : 's'}, luma deviation ${stats.stddev.toFixed(1)}, mean luma ${Math.round(stats.mean)}`;
  if (stats.pixels === 0) return 'the capture has no pixels';
  if (stats.stddev < minStddev) return `the image is a single flat colour (${what})`;
  if (stats.colors < minColors) return `the image has too few colours to be a picture of the flat (${what})`;
  if (stats.topShare > maxTopShare) return `the image is almost entirely one colour (${what})`;
  return undefined;
}
