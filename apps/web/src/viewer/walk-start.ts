import { findSpawn, insideFlat, sceneBounds3 } from '@flat/scene';
import type { Scene } from '@flat/scene';

/** Radius of the walker's body, metres (also the person ghost's clearance from walls). */
export const BODY_RADIUS = 0.25;

/** Where the person stands on the plan (x, z in metres) and where it looks (three.js `rotation.y`, degrees). */
export interface PersonPlacement {
  x: number;
  z: number;
  yawDeg: number;
}

/** Standing point and look direction (degrees, three.js `rotation.y`); looks towards the flat's centre. */
export function spawnPose(scene: Scene): { position: [number, number]; yaw: number } {
  const b = sceneBounds3(scene);
  const centre: [number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
  const spawn = findSpawn(scene, BODY_RADIUS);
  const position = spawn?.position ?? centre;
  const dx = centre[0] - position[0];
  const dz = centre[1] - position[1];
  // forward = (-sin yaw, -cos yaw) in (x, z)
  const yaw = Math.hypot(dx, dz) > 0.5 ? (Math.atan2(-dx, -dz) * 180) / Math.PI : 0;
  return { position, yaw };
}

/**
 * The person's placement for a scene: the saved one (the last walk pose or a drag of the ghost) when it is still
 * inside the flat, otherwise the default walk start (a room centre, looking towards the middle of the flat).
 */
export function personPlacement(scene: Scene, saved: PersonPlacement | null | undefined): PersonPlacement {
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.z) && insideFlat(scene)([saved.x, saved.z])) return saved;
  const s = spawnPose(scene);
  return { x: s.position[0], z: s.position[1], yawDeg: s.yaw };
}
