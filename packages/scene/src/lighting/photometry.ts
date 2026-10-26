/**
 * Photometric conversions for three.js physical lights (r155+): Point/Spot intensity in candela
 * (decay 2, distance 0), Directional in lux, RectAreaLight in nits. (M2.6)
 */

/** Isotropic point light: cd = lm / 4π. */
export function pointCandela(lumens: number): number {
  return Math.max(0, lumens) / (4 * Math.PI);
}

/**
 * Spot with full cone angle θ: cd = lm / (2π(1 − cos(θ/2))). three.js `angle` is θ/2 in radians.
 * θ is clamped to [0.01°, 180°] so the result is always finite (180° gives lm / 2π).
 */
export function spotCandela(lumens: number, fullAngleDeg: number): number {
  const theta = Math.min(180, Math.max(0.01, fullAngleDeg));
  const solidAngle = 2 * Math.PI * (1 - Math.cos((theta * Math.PI) / 360));
  return Math.max(0, lumens) / solidAngle;
}

/** Lambertian rectangular panel: nits = lm / (π · w · d). */
export function areaNits(lumens: number, width: number, depth: number): number {
  if (lumens <= 0) return 0;
  if (!(width > 0) || !(depth > 0)) throw new RangeError('areaNits: width and depth must be positive');
  return lumens / (Math.PI * width * depth);
}

const clamp255 = (v: number) => Math.min(255, Math.max(0, v));
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Colour temperature → linear RGB, normalised so relative luminance Y = 1 (Rec. 709
 * coefficients). Components may therefore exceed 1 for warm colours. Uses Tanner Helland's
 * sRGB approximation (valid 1000–40000 K), converted to linear light.
 */
export function kelvinToLinearRgb(kelvin: number): [number, number, number] {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const lin = [r, g, b].map((v) => srgbToLinear(clamp255(v) / 255));
  const y = 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
  return [lin[0]! / y, lin[1]! / y, lin[2]! / y];
}
