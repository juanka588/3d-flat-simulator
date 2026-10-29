/**
 * Shadow settings of point and spot lamps.
 *
 * three.js compares lamp shadows in perspective depth-buffer units, `z = f (d - n) / (d (f - n))`
 * for a distance `d` along the view axis, not in metres: `bias` is added to that value. The same
 * `bias` is therefore a different number of metres at every distance (`dz/dd = n f / (d^2 (f - n))`,
 * i.e. it grows with `d^2`), and a bias that is right at 1 m is a 0.3 m light leak at 6 m. The bias
 * is converted at a representative receiver distance, and the rest (grazing walls) is covered by
 * the normal offset, which IS in metres.
 */

/** Near and far plane of every lamp shadow camera, metres. */
export const LAMP_SHADOW_NEAR = 0.1;
export const LAMP_SHADOW_FAR = 16;
/** Receiver distance (metres) at which the depth bias equals `LAMP_SHADOW_BIAS_M`. */
export const LAMP_SHADOW_REF_DISTANCE_M = 3;
/** World-space depth bias (metres) at the reference distance. */
export const LAMP_SHADOW_BIAS_M = 0.02;
/** Normal offset (metres) of the shadow lookup: kills acne on walls seen at a grazing angle from the lamp. */
export const LAMP_NORMAL_BIAS_M = 0.05;

/**
 * Perspective-depth bias (three.js `shadow.bias`, negative = towards the light) equal to `metres`
 * of depth at `distance` from the lamp.
 */
export function perspectiveDepthBias(metres: number, distance: number, near = LAMP_SHADOW_NEAR, far = LAMP_SHADOW_FAR): number {
  return (-metres * near * far) / (distance * distance * (far - near));
}

/** Depth bias of the lamps' shadows (see `perspectiveDepthBias`). */
export const LAMP_SHADOW_BIAS = perspectiveDepthBias(LAMP_SHADOW_BIAS_M, LAMP_SHADOW_REF_DISTANCE_M);
