import type { Light, LightingView } from '@flat/scene';
import type { ViewMode } from '../viewer/view-types';

/** Exposure added on top of the user's own while walking with the lights on. */
export const WALK_LIGHTS_EV = 0.5;

/** Walk-mode lights preference ('0' = off); on when never set. */
export const WALK_LIGHTS_KEY = 'flat.walkLightsOn';

const NO_LIGHTS: readonly Pick<Light, 'id'>[] = [];

/** The lighting view with every lamp on and `ev` stops more exposure; pure, the input is not touched. */
export function withAllLampsOn(lighting: LightingView, lights: readonly Pick<Light, 'id'>[], ev: number): LightingView {
  const lamps: LightingView['lamps'] = { ...lighting.lamps };
  for (const l of lights) lamps[l.id] = { ...lamps[l.id], on: true };
  return { ...lighting, lamps, exposureEV: Math.min(6, lighting.exposureEV + ev) };
}

const cache = new WeakMap<LightingView, WeakMap<readonly Pick<Light, 'id'>[], LightingView>>();

/**
 * What the viewer lights the flat with: the stored lighting, except in walk mode with the preference on,
 * where every lamp is on and the exposure is raised. A derived layer: the stored lighting (the user's lamp
 * toggles and exposure) is never changed, so leaving walk mode restores it exactly. Memoised so the
 * result is the same object while its inputs are (the viewer and the test hook compare by identity).
 */
export function effectiveLighting(
  lighting: LightingView,
  mode: ViewMode,
  walkLightsOn: boolean,
  lights: readonly Pick<Light, 'id'>[] = NO_LIGHTS,
): LightingView {
  if (mode !== 'walk' || !walkLightsOn) return lighting;
  let byLights = cache.get(lighting);
  if (!byLights) cache.set(lighting, (byLights = new WeakMap()));
  let out = byLights.get(lights);
  if (!out) byLights.set(lights, (out = withAllLampsOn(lighting, lights, WALK_LIGHTS_EV)));
  return out;
}
