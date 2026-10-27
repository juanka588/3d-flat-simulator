import type { CameraPose, OrbitPose, TopPose } from '@flat/scene';

/**
 * Pose maths shared by the camera rigs (pure, no three.js objects) and the record of which pose the
 * rigs have actually put on the camera.
 *
 * Conventions (WORLD: X = plan x, Y = up, Z = plan y; plan-up is -Z):
 * - orbit `azimuthDeg`: degrees clockwise on the plan from plan-up. The camera sits at
 *   `target + distance * (cos(el) sin(az), sin(el), -cos(el) cos(az))`: az 0 is north of the target
 *   (-Z), 90 east (+X), 135 south-east (the default framing).
 * - walk `headingDeg`: degrees clockwise on the plan from plan-up, the direction the eyes look.
 *   three.js `rotation.y` (and `stats().yawDeg`) is the negative: `yawDeg = -headingDeg`, and the
 *   forward vector is `(sin h, 0, -cos h)`. `stats().headingDeg` reports the clockwise value.
 * - top `rotationDeg`: the plan rotates clockwise on screen by this much, so the camera's up vector is
 *   `(-sin r, 0, -cos r)`. `stats().yawDeg` of a top camera is the up vector's heading (`= rotationDeg`).
 */

const RAD = Math.PI / 180;

export function orbitPosition(pose: OrbitPose): [number, number, number] {
  const az = pose.azimuthDeg * RAD;
  const el = pose.elevationDeg * RAD;
  const flat = Math.cos(el) * pose.distance;
  return [pose.target[0] + flat * Math.sin(az), pose.target[1] + Math.sin(el) * pose.distance, pose.target[2] - flat * Math.cos(az)];
}

/** Three.js `rotation.y` in radians for a clockwise plan heading. */
export function headingToYaw(headingDeg: number): number {
  return -headingDeg * RAD;
}

/** Clockwise plan heading in degrees, in [0, 360), for a three.js yaw in degrees. */
export function yawToHeadingDeg(yawDeg: number): number {
  const h = -yawDeg % 360;
  return h < 0 ? h + 360 : h === 0 ? 0 : h;
}

export function topUp(pose: TopPose): [number, number, number] {
  const r = pose.rotationDeg * RAD;
  return [-Math.sin(r), 0, -Math.cos(r)];
}

/** Orthographic zoom (pixels per metre) that shows `halfHeight` metres above and below the centre. */
export function topZoomFor(pose: TopPose, viewportHeightPx: number): number {
  return viewportHeightPx / (2 * pose.halfHeight);
}

let applied: CameraPose | undefined;

/** The pose the rig last put on the camera (undefined until it did, or after the rig unmounted). */
export function appliedPose(): CameraPose | undefined {
  return applied;
}

export function noteAppliedPose(pose: CameraPose | undefined): void {
  applied = pose;
}
