import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { BackSide, Color, ShaderMaterial, Vector3 } from 'three';
import type { Mesh } from 'three';
import type { RGB } from './lighting';

/** Radius of the sky sphere, which follows the camera; must lie inside the camera's near/far range. */
const SKY_RADIUS = 10;

const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  // Zenith -> horizon gradient, then a blend to the ground tone below the horizon.
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
  col = mix(col, uGround, smoothstep(0.0, -0.12, h));
  float c = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (0.35 * pow(c, 6.0) + 0.5 * pow(c, 40.0) + 4.0 * pow(c, 2500.0));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

/**
 * Screen-tuned sky dome: a zenith -> horizon gradient (colours from `skyState`, linear RGB) with a
 * warm halo and disc around the sun. Our own small shader instead of the physical three.js `Sky`,
 * whose output is HDR and unscaled relative to the flat's exposure (it rendered flat grey). It
 * ignores depth and tone mapping (colours are final display colours), is drawn first, and stays
 * centred on the camera so a small sphere looks like an infinitely distant dome.
 */
export function SkyDome({ direction, zenith, horizon, ground, sunVisibility }: { direction: [number, number, number]; zenith: RGB; horizon: RGB; ground: RGB; sunVisibility: number }) {
  const ref = useRef<Mesh>(null);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        side: BackSide,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        fog: false,
        uniforms: {
          uZenith: { value: new Color() },
          uHorizon: { value: new Color() },
          uGround: { value: new Color() },
          uSunDir: { value: new Vector3(0, 1, 0) },
          uSunColor: { value: new Color() },
        },
      }),
    [],
  );
  useLayoutEffect(() => () => material.dispose(), [material]);

  useLayoutEffect(() => {
    const u = material.uniforms as Record<'uZenith' | 'uHorizon' | 'uGround' | 'uSunColor', { value: Color }> & { uSunDir: { value: Vector3 } };
    u.uZenith.value.setRGB(...zenith);
    u.uHorizon.value.setRGB(...horizon);
    // Below the horizon the dome continues the lit context ground (see `groundDisplay`).
    u.uGround.value.setRGB(...ground);
    u.uSunDir.value.set(...direction);
    u.uSunColor.value.setRGB(1.0, 0.82, 0.55).multiplyScalar(sunVisibility);
  }, [material, zenith, horizon, ground, direction, sunVisibility]);

  useLayoutEffect(() => {
    const sky = ref.current;
    if (!sky) return;
    sky.name = 'sky';
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
  }, []);
  useFrame(({ camera }) => ref.current?.position.copy(camera.position));
  return (
    <mesh ref={ref} material={material} scale={SKY_RADIUS} raycast={() => undefined}>
      <sphereGeometry args={[1, 32, 16]} />
    </mesh>
  );
}
