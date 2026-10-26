/**
 * Walk-mode camera: eye height from the person's height, and field of view from the screen shape.
 *
 * Why these numbers (the walk view used to feel "small"):
 * - Eye height. The eyes sit about 11 cm below the top of the head, so a 166 cm person looks from
 *   1.55 m (the old fixed 1.60 m suited a 171 cm person). The height is a user setting.
 * - Field of view. The old 70 degree vertical fov on a 16:10 window is a ~100 degree horizontal fov:
 *   a fisheye look that makes rooms and furniture seem far away and small. 50 degrees vertical is
 *   close to a normal lens (~78 degrees horizontal at 16:10) and objects keep the size the eye expects.
 *   A portrait phone is the opposite problem: 50 degrees vertical would be only ~25 degrees across,
 *   a keyhole. There the fov is derived from a target horizontal fov of 75 degrees instead, and the
 *   resulting vertical fov is capped so the image does not stretch too much at the edges.
 */
export const DEFAULT_PERSON_HEIGHT_CM = 166;
export const MIN_PERSON_HEIGHT_CM = 120;
export const MAX_PERSON_HEIGHT_CM = 210;
/** Distance from the eyes to the top of the head, in metres. */
export const EYE_BELOW_HEAD_M = 0.11;

/** Vertical fov on landscape (aspect >= 1) screens, degrees. */
export const LANDSCAPE_VERTICAL_FOV_DEG = 50;
/** Target horizontal fov on portrait (aspect < 1) screens, degrees. */
export const PORTRAIT_HORIZONTAL_FOV_DEG = 75;
/** Upper bound of the vertical fov on very tall screens, degrees. */
export const MAX_VERTICAL_FOV_DEG = 100;

/** A usable person height in whole centimetres: non-numbers fall back to the default, others are clamped. */
export function clampPersonHeightCm(cm: number): number {
  if (!Number.isFinite(cm)) return DEFAULT_PERSON_HEIGHT_CM;
  return Math.min(MAX_PERSON_HEIGHT_CM, Math.max(MIN_PERSON_HEIGHT_CM, Math.round(cm)));
}

/** Camera (eye) height in metres, to the millimetre, for a person of `heightCm`. */
export function eyeHeightM(heightCm: number): number {
  return Math.round((clampPersonHeightCm(heightCm) / 100 - EYE_BELOW_HEAD_M) * 1000) / 1000;
}

/** Vertical field of view (degrees) of the walk camera for a viewport of the given width / height. */
export function walkFovDeg(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0 || aspect >= 1) return LANDSCAPE_VERTICAL_FOV_DEG;
  const halfH = (PORTRAIT_HORIZONTAL_FOV_DEG * Math.PI) / 360;
  const vertical = (2 * Math.atan(Math.tan(halfH) / aspect) * 180) / Math.PI;
  return Math.min(MAX_VERTICAL_FOV_DEG, Math.max(LANDSCAPE_VERTICAL_FOV_DEG, vertical));
}

/** Horizontal fov (degrees) that a vertical fov gives at the given aspect. */
export function horizontalFovDeg(verticalDeg: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((verticalDeg * Math.PI) / 360) * aspect) * 180) / Math.PI;
}
