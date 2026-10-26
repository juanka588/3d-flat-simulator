import { useThree } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Scene, SiteContext } from '@flat/scene';
import { DirectionalLight, Object3D } from 'three';
import type { LightingModel } from './lighting';
import { fitSunForScene } from './sun-bounds';
import { sunShadowBias } from './sun-shadow';

export const SUN_SHADOW_MAP_SIZE = 2048;

type OkModel = Extract<LightingModel, { ok: true }>;

/**
 * The sun: a directional light (lux) whose orthographic shadow frustum is refitted to the flat
 * (plus the context buildings that can shade it) whenever the sun direction, scene or context
 * changes. Intensity is 0 when the sun is down or disabled.
 *
 * The shadow map is never re-rendered automatically (`autoUpdate = false`): the scene is static,
 * so `needsUpdate` is set only when the sun direction or intensity, the scene or the context
 * change. The depth bias is expressed in metres (see `sunShadowBias`).
 */
export function SunLight({ model, scene, context }: { model: OkModel; scene: Scene; context: SiteContext | null }) {
  const light = useRef<DirectionalLight>(null);
  const target = useMemo(() => new Object3D(), []);
  const invalidate = useThree((s) => s.invalidate);
  const [dx, dy, dz] = model.sun.direction;
  const active = model.sunActive;
  const intensity = model.sunIntensity;

  useLayoutEffect(() => {
    const l = light.current;
    if (!l) return;
    l.shadow.autoUpdate = false;
    if (!active) return;
    const fit = fitSunForScene(scene, context, [dx, dy, dz]);
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
    const bias = sunShadowBias(fit, SUN_SHADOW_MAP_SIZE);
    l.shadow.bias = bias.bias;
    l.shadow.normalBias = bias.normalBias;
    l.updateMatrixWorld();
    target.updateMatrixWorld();
    l.shadow.needsUpdate = true;
    invalidate();
  }, [scene, context, dx, dy, dz, active, intensity, target, invalidate]);

  return (
    <>
      <primitive object={target} />
      <directionalLight
        ref={light}
        name="sun"
        target={target}
        intensity={intensity}
        castShadow
        shadow-mapSize={[SUN_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE]}
      />
    </>
  );
}
