import { Sky } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useRef } from 'react';
import type { ComponentRef } from 'react';

/** The three.js Sky shader expects a sun position at about this distance (its fade-out is scaled by it). */
const SUN_DISTANCE = 450_000;
/** Edge of the sky box, which follows the camera; must lie inside the camera's near/far range. */
const SKY_BOX = 20;

/**
 * drei `<Sky>` driven by the sun direction. It is drawn first, ignores depth and tone mapping (the
 * physical exposure is tuned for the flat's luminance, not for the sky's), and stays centred on the
 * camera so a small box looks like an infinitely distant dome.
 */
export function SkyDome({ direction }: { direction: [number, number, number] }) {
  const ref = useRef<ComponentRef<typeof Sky>>(null);
  useLayoutEffect(() => {
    const sky = ref.current;
    if (!sky) return;
    sky.name = 'sky';
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    const material = sky.material;
    material.toneMapped = false;
    material.depthTest = false;
    material.depthWrite = false;
  }, []);
  useFrame(({ camera }) => ref.current?.position.copy(camera.position));
  return (
    <Sky
      ref={ref}
      distance={SKY_BOX}
      sunPosition={[direction[0] * SUN_DISTANCE, direction[1] * SUN_DISTANCE, direction[2] * SUN_DISTANCE]}
    />
  );
}
