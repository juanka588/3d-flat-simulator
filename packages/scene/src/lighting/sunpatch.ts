import type { Scene, Vec2 } from '../schema';
import type { Point3 } from '../camera';

export interface SunPatch {
  openingId: string;
  roomId: string;
  /** Lit area on the room floor, in plan coordinates, clipped to the room polygon. */
  polygon: Vec2[];
  area: number;
}

/**
 * Projects every glazed opening onto the floors along the sun direction (`direction` points
 * towards the sun). Ignores obstruction by neighbouring buildings. (M2.3 — stub)
 */
export function sunPatches(_scene: Scene, _direction: Point3): SunPatch[] {
  throw new Error('not implemented');
}

/**
 * Hours of direct sun per room on a local date (any patch with area > 0.05 m² counts),
 * sampled every `stepMinutes`. (M2.3 — stub)
 */
export function sunlightHours(_scene: Scene, _date: string, _stepMinutes = 10): Record<string, number> {
  throw new Error('not implemented');
}
