import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useMemo } from 'react';
import { fitCamera, sceneBounds3 } from '@flat/scene';
import type { Scene } from '@flat/scene';
import type { ViewMode } from './view-types';

const ORBIT_FOV = 50;

/**
 * Orbit and top-down cameras. Remount (via `key`) when the scene or mode changes to re-frame.
 * Walk mode has its own rig, see WalkControls.
 */
export function CameraRig({ scene, mode }: { scene: Scene; mode: Exclude<ViewMode, 'walk'> }) {
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(size.height, 1);
  const { fit, near, far } = useMemo(() => {
    const bounds = sceneBounds3(scene);
    const fit = fitCamera(bounds, { mode, aspect, fovDeg: ORBIT_FOV });
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
    // The whole box lies within `diagonal` of its centre, so it is inside [distance - diagonal, distance + diagonal].
    return {
      fit,
      near: Math.max(0.05, (distance - diagonal) * 0.5),
      far: distance + diagonal * 2 + 10,
    };
  },
    // Re-fit on scene/mode only, not on every resize (that would reset the user's view).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene, mode],
  );

  if (mode === 'top') {
    return (
      <>
        <OrthographicCamera
          makeDefault
          position={fit.position}
          up={fit.up}
          zoom={size.height / (2 * (fit.orthoHalfHeight ?? 1))}
          near={near}
          far={far}
        />
        <OrbitControls makeDefault target={fit.target} enableRotate={false} screenSpacePanning />
      </>
    );
  }
  return (
    <>
      <PerspectiveCamera makeDefault fov={ORBIT_FOV} position={fit.position} up={fit.up} near={near} far={far} />
      <OrbitControls makeDefault target={fit.target} maxPolarAngle={Math.PI / 2 - 0.01} />
    </>
  );
}
