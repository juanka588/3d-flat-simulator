/**
 * Coordinate conventions
 *  - Map frame: local ENU in metres around an origin (lat0, lon0), using an equirectangular
 *    approximation: E = (lon - lon0) * cos(lat0) * R * pi/180, N = (lat - lat0) * R * pi/180
 *    with R = 6371008.8 m. At a few hundred metres the error is well below a centimetre.
 *  - Plan frame (Scene): metres, x right, y DOWN, origin at the flat's plan origin. If the plan
 *    x axis has compass bearing bx (clockwise from north), then
 *      x axis = (E, N) (sin bx, cos bx)        y axis = (E, N) (cos bx, -sin bx)
 *    and `site.northAngle` (clockwise angle from plan up to true north) = 90 - bx.
 */
import type { Pt } from './polygon';

export const R_EARTH = 6371008.8;
export const DEG = Math.PI / 180;

/** WGS84 -> local ENU metres around (lat0, lon0). */
export function toEnu(lat: number, lon: number, lat0: number, lon0: number): Pt {
  return [(lon - lon0) * Math.cos(lat0 * DEG) * R_EARTH * DEG, (lat - lat0) * R_EARTH * DEG];
}
/** Local ENU metres -> WGS84. */
export function fromEnu(e: number, n: number, lat0: number, lon0: number): Pt {
  return [lat0 + n / (R_EARTH * DEG), lon0 + e / (Math.cos(lat0 * DEG) * R_EARTH * DEG)];
}

/** Plan frame basis (in E,N) for a plan x axis with compass bearing `bx` degrees. */
export function planBasis(bx: number): { ex: Pt; ey: Pt } {
  const r = bx * DEG;
  return { ex: [Math.sin(r), Math.cos(r)], ey: [Math.cos(r), -Math.sin(r)] };
}

export const wrap360 = (a: number): number => ((a % 360) + 360) % 360;
export const wrap180 = (a: number): number => ((((a + 180) % 360) + 360) % 360) - 180;
export const round = (v: number, d: number): number => Math.round(v * 10 ** d) / 10 ** d;
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'] as const;
export const compass = (bearing: number): string => POINTS[Math.round(wrap360(bearing) / 22.5) % 16]!;
