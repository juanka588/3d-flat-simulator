import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Vector3 } from 'three';

const forward = new Vector3();
const up = new Vector3();

/** Clockwise screen angle (degrees) from "screen up" to true north for the current camera. */
export function northNeedleAngle(forwardXZ: [number, number], northAngleDeg: number): number {
  const theta = (northAngleDeg * Math.PI) / 180;
  const n: [number, number] = [Math.sin(theta), -Math.cos(theta)];
  const right: [number, number] = [-forwardXZ[1], forwardXZ[0]];
  const along = n[0] * forwardXZ[0] + n[1] * forwardXZ[1];
  const across = n[0] * right[0] + n[1] * right[1];
  return (Math.atan2(across, along) * 180) / Math.PI;
}

/** In-canvas driver: rotates the DOM needle imperatively each frame (no React re-renders). */
export function CompassDriver({ onAngle, northAngle }: { onAngle: (degrees: number) => void; northAngle: number }) {
  const last = useRef(Number.NaN);
  useFrame(({ camera }) => {
    camera.getWorldDirection(forward);
    let x = forward.x;
    let z = forward.z;
    if (Math.hypot(x, z) < 0.3) {
      // Looking (almost) straight down: screen-up is the camera's up vector.
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      x = up.x;
      z = up.z;
    }
    const len = Math.hypot(x, z) || 1;
    const angle = northNeedleAngle([x / len, z / len], northAngle);
    if (Number.isNaN(last.current) || Math.abs(angle - last.current) > 0.01) {
      onAngle(angle);
      last.current = angle;
    }
  });
  useEffect(() => {
    last.current = Number.NaN;
  }, [northAngle]);
  return null;
}

/** Compass overlay; the needle points to true north. */
export function CompassOverlay({ needle }: { needle: RefObject<HTMLDivElement | null> }) {
  return (
    <div className="compass" role="img" aria-label="Compass: needle points to true north">
      <div className="compass-needle" ref={needle} data-testid="compass-needle">
        <span className="compass-n">N</span>
      </div>
    </div>
  );
}
