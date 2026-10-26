/**
 * Photometric conversions for three.js physical lights (r155+): Point/Spot intensity in candela
 * (decay 2, distance 0), Directional in lux, RectAreaLight in nits. (M2.6 — stubs)
 */

/** Isotropic point light: cd = lm / 4π. */
export function pointCandela(_lumens: number): number {
  throw new Error('not implemented');
}

/** Spot with full cone angle θ: cd = lm / (2π(1 − cos(θ/2))). three.js `angle` is θ/2 in radians. */
export function spotCandela(_lumens: number, _fullAngleDeg: number): number {
  throw new Error('not implemented');
}

/** Lambertian rectangular panel: nits = lm / (π · w · d). */
export function areaNits(_lumens: number, _width: number, _depth: number): number {
  throw new Error('not implemented');
}

/** Colour temperature → linear RGB (0–1), normalised so relative luminance Y = 1. */
export function kelvinToLinearRgb(_kelvin: number): [number, number, number] {
  throw new Error('not implemented');
}
