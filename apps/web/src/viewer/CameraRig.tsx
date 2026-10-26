import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useMemo } from 'react';
import { TOUCH } from 'three';
import { fitCamera, sceneBounds3 } from '@flat/scene';
import type { Scene } from '@flat/scene';
import type { ViewMode } from './view-types';

const ORBIT_FOV = 50;
/** Constant near plane: small enough not to clip walls up close, large enough for depth precision. */
const NEAR = 0.05;
/** Closest the orbit camera may get to its target, in metres. */
const MIN_DISTANCE = 1;
/** How far out the user may zoom, as a multiple of the framing distance. */
const MAX_DISTANCE_FACTOR = 3;
/** Top view zoom range relative to the fitted zoom. */
const MIN_ZOOM_FACTOR = 0.4;
const MAX_ZOOM_FACTOR = 30;
const TOP_MARGIN = 1.1;

/**
 * Touch gestures. Orbit: one finger rotates, two fingers pinch-zoom and pan. Top view cannot rotate, so
 * there one finger pans (three's default would leave it doing nothing) and two fingers pinch and pan.
 */
const ORBIT_TOUCHES = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
const TOP_TOUCHES = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN };

/**
 * Orbit and top-down cameras. Remount (via `key`) when the scene or mode changes to re-frame.
 * Walk mode has its own rig, see WalkControls.
 */
export function CameraRig({
  scene,
  mode,
  extraReach = 0,
}: {
  scene: Scene;
  mode: Exclude<ViewMode, 'walk'>;
  /** How far site context extends from the flat; only widens the far plane, the framing stays on the flat. */
  extraReach?: number;
}) {
  const size = useThree((s) => s.size);
  const { fit, far, maxDistance, topZoom } = useMemo(
    () => {
      const bounds = sceneBounds3(scene);
      const fit = fitCamera(bounds, { mode, aspect: size.width / Math.max(size.height, 1), fovDeg: ORBIT_FOV });
      const diagonal = Math.hypot(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      );
      const distance = Math.hypot(
        fit.position[0] - fit.target[0],
        fit.position[1] - fit.target[1],
        fit.position[2] - fit.target[2],
      );
      const maxDistance = Math.max(distance * MAX_DISTANCE_FACTOR, MIN_DISTANCE * 2);
      // Top view looks along -Y with screen-up = -Z, so plan x is screen width and plan y screen height.
      const halfWidth = ((bounds.max[0] - bounds.min[0]) / 2) * TOP_MARGIN;
      const halfHeight = ((bounds.max[2] - bounds.min[2]) / 2) * TOP_MARGIN;
      const topZoom = Math.min(size.height / (2 * Math.max(halfHeight, 0.1)), size.width / (2 * Math.max(halfWidth, 0.1)));
      return {
        fit,
        // The camera can sit `maxDistance` from the target and the box is within `diagonal` of it.
        far: maxDistance + diagonal + extraReach + 10,
        maxDistance,
        topZoom,
      };
    },
    // Re-fit on scene/mode only: resizing the canvas must not reset the user's pan and zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene, mode],
  );

  if (mode === 'top') {
    return (
      <>
        <OrthographicCamera makeDefault position={fit.position} up={fit.up} zoom={topZoom} near={NEAR} far={far} />
        <OrbitControls
          makeDefault
          target={fit.target}
          enableRotate={false}
          touches={TOP_TOUCHES}
          screenSpacePanning
          minZoom={topZoom * MIN_ZOOM_FACTOR}
          maxZoom={topZoom * MAX_ZOOM_FACTOR}
        />
      </>
    );
  }
  return (
    <>
      <PerspectiveCamera makeDefault fov={ORBIT_FOV} position={fit.position} up={fit.up} near={NEAR} far={far} />
      <OrbitControls
        makeDefault
        target={fit.target}
        touches={ORBIT_TOUCHES}
        minDistance={MIN_DISTANCE}
        maxDistance={maxDistance}
        maxPolarAngle={Math.PI / 2 - 0.01}
      />
    </>
  );
}
