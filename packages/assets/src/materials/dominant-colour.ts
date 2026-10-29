/**
 * The dominant colour of a product photo (CG8), deterministic: the same pixels always give the same hex.
 *
 * Product photos are the product on a white backdrop, so near-white, near-transparent and low-chroma-bright pixels are
 * ignored. The rest is binned into 16 levels per channel; the fullest bin wins (lowest bin index on a tie) and the result is
 * the mean of the pixels in it. `undefined` when nothing but backdrop is left.
 */
export function dominantColour(rgba: ArrayLike<number>, width: number, height: number): string | undefined {
  const n = Math.min(width * height, Math.floor(rgba.length / 4));
  const counts = new Uint32Array(4096);
  const sums = new Float64Array(4096 * 3);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    const a = rgba[i * 4 + 3]!;
    if (a < 128) continue;
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    if (lo >= 232 || (hi >= 215 && hi - lo < 10)) continue; // backdrop (white / pale grey)
    const bin = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    counts[bin]!++;
    sums[bin * 3]! += r;
    sums[bin * 3 + 1]! += g;
    sums[bin * 3 + 2]! += b;
  }
  let best = -1;
  let bestCount = 0;
  for (let bin = 0; bin < 4096; bin++) {
    if (counts[bin]! > bestCount) {
      best = bin;
      bestCount = counts[bin]!;
    }
  }
  // fewer than 0.5% of the pixels: it is only noise around the backdrop
  if (best < 0 || bestCount < Math.max(2, n * 0.005)) return undefined;
  const hex = (k: number) => Math.round(sums[best * 3 + k]! / bestCount).toString(16).padStart(2, '0');
  return `#${hex(0)}${hex(1)}${hex(2)}`;
}
