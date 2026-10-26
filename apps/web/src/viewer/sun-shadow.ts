import type { SunShadowFit } from './sun-fit';

/** Depth bias of the sun's shadow in metres: how far a surface may sit behind the stored depth before it counts as shadowed. */
export const SUN_SHADOW_BIAS_M = 0.015;

/** Normal offset in shadow-map texels. */
export const SUN_NORMAL_BIAS_TEXELS = 2;

/**
 * Bias settings for the sun's orthographic shadow. The shadow depth is linear over
 * `far - near`, and three.js's `bias` is in those normalised units, so a fixed bias would be a
 * different number of metres for every fit (a 400 m range turns 0.0005 into 0.2 m of light
 * leaking under walls). `bias = -K / (far - near)` keeps it at `K` metres whatever the range.
 * `normalBias` (metres, along the surface normal) is a couple of shadow-map texels.
 */
export function sunShadowBias(fit: Pick<SunShadowFit, 'left' | 'right' | 'top' | 'bottom' | 'near' | 'far'>, mapSize: number): { bias: number; normalBias: number } {
  const texel = Math.max(fit.right - fit.left, fit.top - fit.bottom) / mapSize;
  return { bias: -SUN_SHADOW_BIAS_M / (fit.far - fit.near), normalBias: SUN_NORMAL_BIAS_TEXELS * texel };
}
