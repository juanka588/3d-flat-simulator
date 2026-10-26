import { useFrame, useThree } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Scene, SiteContext } from '@flat/scene';
import { DirectionalLight, Object3D } from 'three';
import type { LightingModel } from './lighting';
import { fitSunShadow } from './sun-fit';
import { sunFitInputs } from './sun-bounds';

export const SUN_SHADOW_MAP_SIZE = 2048;

type OkModel = Extract<LightingModel, { ok: true }>;

/**
 * The sun: a directional light (lux) whose orthographic shadow frustum is refitted to the flat
 * (plus nearby context) whenever the sun direction, scene or context changes. Intensity is 0 when
 * the sun is down or disabled, and its shadow map is then no longer re-rendered.
 */
export function SunLight({ model, scene, context }: { model: OkModel; scene: Scene; context: SiteContext | null }) {
  const light = useRef<DirectionalLight>(null);
  const target = useMemo(() => new Object3D(), []);
  const invalidate = useThree((s) => s.invalidate);
  const [dx, dy, dz] = model.sun.direction;
  const active = model.sunActive;

  useLayoutEffect(() => {
    const l = light.current;
    if (!l || !active) return;
    const { receivers, casters } = sunFitInputs(scene, context);
    const fit = fitSunShadow([dx, dy, dz], receivers, casters);
    if (!fit) return;
    l.position.set(...fit.position);
    target.position.set(...fit.target);
    const cam = l.shadow.camera;
    cam.up.set(...fit.up);
    cam.left = fit.left;
    cam.right = fit.right;
    cam.top = fit.top;
    cam.bottom = fit.bottom;
    cam.near = fit.near;
    cam.far = fit.far;
    cam.updateProjectionMatrix();
    l.updateMatrixWorld();
    target.updateMatrixWorld();
    invalidate();
  }, [scene, context, dx, dy, dz, active, target, invalidate]);

  // Skip re-rendering the shadow map while the sun contributes nothing (once it has been allocated).
  useFrame(() => {
    const l = light.current;
    if (l) l.shadow.autoUpdate = active || l.shadow.map === null;
  });

  return (
    <>
      <primitive object={target} />
      <directionalLight
        ref={light}
        name="sun"
        target={target}
        intensity={model.sunLux}
        castShadow
        shadow-mapSize={[SUN_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.02}
      />
    </>
  );
}
