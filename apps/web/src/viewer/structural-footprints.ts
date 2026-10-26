import { isStructural, wallLeftNormal, wallLength } from '@flat/scene';
import type { Scene, Vec2 } from '@flat/scene';

export interface WallFootprint {
  wallId: string;
  structural: boolean;
  /** Corners in plan coordinates (start-left, end-left, end-right, start-right). */
  corners: [Vec2, Vec2, Vec2, Vec2];
  height: number;
}

/** Plan rectangle of every wall (centreline +- half thickness) with its structural status. */
export function wallFootprints(scene: Pick<Scene, 'walls' | 'rooms'>): WallFootprint[] {
  const out: WallFootprint[] = [];
  for (const wall of scene.walls) {
    if (wallLength(wall) < 1e-9) continue;
    const n = wallLeftNormal(wall);
    const h = wall.thickness / 2;
    const at = (p: Vec2, s: number): Vec2 => [p[0] + n[0] * h * s, p[1] + n[1] * h * s];
    out.push({
      wallId: wall.id,
      structural: isStructural(scene, wall),
      corners: [at(wall.start, 1), at(wall.end, 1), at(wall.end, -1), at(wall.start, -1)],
      height: wall.height,
    });
  }
  return out;
}
