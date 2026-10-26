import { wallFaceRooms } from './geometry/room-sides';
import type { Scene, Wall } from './schema';
import { EPSILON } from './schema';

/** Walls at least this thick (metres) are structural unless marked otherwise. */
export const STRUCTURAL_MIN_THICKNESS = 0.15;

export type StructuralSource = 'explicit' | 'exterior' | 'thickness' | 'partition';

export interface StructuralInfo {
  structural: boolean;
  /**
   * Why: `explicit` (`wall.structural` is set), `exterior` (separates an indoor room from
   * outdoors or a balcony), `thickness` (>= 15 cm), or `partition` (the default for thinner walls).
   */
  source: StructuralSource;
}

const exteriorCache = new WeakMap<object, Map<string, boolean>>();

/** True when exactly one face of the wall belongs to an indoor (non-balcony) room. */
function isExterior(scene: Pick<Scene, 'walls' | 'rooms'>, wallId: string): boolean {
  let map = exteriorCache.get(scene);
  if (!map) {
    const indoor = new Set(scene.rooms.filter((r) => r.type !== 'balcony').map((r) => r.id));
    map = new Map();
    for (const [id, faces] of wallFaceRooms(scene)) {
      const l = faces.left.some((r) => indoor.has(r));
      const r = faces.right.some((r2) => indoor.has(r2));
      map.set(id, l !== r);
    }
    exteriorCache.set(scene, map);
  }
  return map.get(wallId) ?? false;
}

/**
 * Whether a wall is structural (load-bearing, facade, party wall) and so never removable.
 * Resolution order:
 *  1. `wall.structural` when set;
 *  2. exterior walls (indoor room on one face only, e.g. facades and balcony doors) are structural;
 *  3. walls >= 0.15 m thick are structural;
 *  4. thinner walls are removable partitions.
 */
export function structuralInfo(scene: Pick<Scene, 'walls' | 'rooms'>, wall: Pick<Wall, 'id' | 'thickness' | 'structural'>): StructuralInfo {
  if (wall.structural !== undefined) return { structural: wall.structural, source: 'explicit' };
  if (isExterior(scene, wall.id)) return { structural: true, source: 'exterior' };
  if (wall.thickness >= STRUCTURAL_MIN_THICKNESS - EPSILON) return { structural: true, source: 'thickness' };
  return { structural: false, source: 'partition' };
}

export function isStructural(scene: Pick<Scene, 'walls' | 'rooms'>, wall: Pick<Wall, 'id' | 'thickness' | 'structural'>): boolean {
  return structuralInfo(scene, wall).structural;
}
