import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useMemo } from 'react';
import type { Scene } from '@flat/scene';
import { fitCamera, sceneBounds3 } from '../scene-adapters';
import type { ViewMode } from './view-types';

const ORBIT_FOV = 50;

/**
 * Orbit and top-down cameras. Remount (via `key`) when the scene or mode changes to re-frame.
 * Walk mode has its own rig, see WalkControls.
 */
export function CameraRig({ scene, mode }: { scene: Scene; mode: Exclude<ViewMode, 'walk'> }) {
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(size.height, 1);
  const fit = useMemo(
    () => fitCamera(sceneBounds3(scene), { mode, aspect, fovDeg: ORBIT_FOV }),
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
          up={[0, 0, -1]}
          zoom={size.height / (2 * fit.halfHeight)}
          near={fit.near}
          far={fit.far}
        />
        <OrbitControls makeDefault target={fit.target} enableRotate={false} screenSpacePanning />
      </>
    );
  }
  return (
    <>
      <PerspectiveCamera makeDefault fov={ORBIT_FOV} position={fit.position} near={fit.near} far={fit.far} />
      <OrbitControls makeDefault target={fit.target} maxPolarAngle={Math.PI / 2 - 0.01} />
    </>
  );
}
