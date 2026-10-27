import type { Scene } from './schema';
import type { CameraPose, OrbitPose, TopPose, WalkPose } from './view';

/**
 * Pure camera presets (M4.3, lane A). Each returns a `CameraPose` for a scene; none reads a clock,
 * a viewport or a renderer, so the same input gives the same pose and they run in node.
 * Contract tests: every preset on every fixture returns a pose that passes `CameraPose.parse`, has
 * finite numbers, and (walk) an eye position inside the room polygon.
 */

/** Compass point (true north, after `site.northAngle`) or a plan heading in degrees clockwise from plan-up. */
export type Facing = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW' | number;

/** An error the caller maps to `unknown_room` (the message lists the nearest room ids). */
export class UnknownRoomError extends Error {
  constructor(public readonly roomId: string) {
    super(`unknown room "${roomId}"`);
  }
}

/**
 * Orbit-style overview of one room from a corner, high enough to see the floor and the walls
 * (`render_view {view:'room'}`). Throws `UnknownRoomError` for an unknown room.
 */
export function roomOverviewPose(_scene: Scene, _roomId: string, _opts?: { fovDeg?: number }): OrbitPose {
  throw new Error('not implemented');
}

/**
 * Eye-level pose standing inside the room (at the doorway side or the centroid-most point that is
 * inside the polygon), looking `facing` (default: towards the room centre / the longest visible wall).
 * Throws `UnknownRoomError` for an unknown room.
 */
export function walkPoseInRoom(_scene: Scene, _roomId: string, _opts?: { facing?: Facing; eyeHeight?: number; fovDeg?: number }): WalkPose {
  throw new Error('not implemented');
}

/** Orthographic plan view fitting the room (`roomId`) or the whole flat. */
export function topPose(_scene: Scene, _opts?: { roomId?: string; margin?: number; aspect?: number }): TopPose {
  throw new Error('not implemented');
}

/** Orbit view of the whole flat (or of `roomId`) from `azimuthDeg` / `elevationDeg`. */
export function orbitPose(_scene: Scene, _opts?: { roomId?: string; azimuthDeg?: number; elevationDeg?: number; fovDeg?: number; aspect?: number }): OrbitPose {
  throw new Error('not implemented');
}

/** Resolves a `Facing` to a plan heading (degrees clockwise from plan-up) for the scene's `northAngle`. */
export function facingToHeadingDeg(_scene: Scene, _facing: Facing): number {
  throw new Error('not implemented');
}

export type { CameraPose };
