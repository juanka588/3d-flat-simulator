import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import { autoExposure } from '@flat/scene';
import type { LightingModel } from './lighting';
import { adaptExposure, keyLux } from './probe-field';
import { probeField } from './probe-runtime';
import type { ViewMode } from './view-types';

/** Opt-in (`?exposure=adapt`): the default exposure stays keyed on the open-air light, see PROBE_INDOOR_SKY_GAIN. */
export const adaptiveExposure = (): boolean => typeof location !== 'undefined' && new URLSearchParams(location.search).get('exposure') === 'adapt';

/** Time constant (s) of the adaptation of the exposure in the app; tests and headless renders settle at once. */
const ADAPT_TAU_S = 0.35;

/** True when nothing may depend on time: automated pages (tests, headless renders) get the settled exposure on the very frame. */
export const settledAtOnce = (): boolean => typeof navigator !== 'undefined' && (navigator.webdriver === true || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('test')));

/**
 * Eye / camera adaptation of the exposure, used with the baked light probes. The old exposure was keyed on the open-air light
 * (sun + sky + lamps), so a daylit room that only receives a few per cent of it rendered dark. Here it is keyed on the light the
 * probes give where the camera is (walk, and orbit cameras inside a room) or on the flat-wide interior mean (top and orbit views
 * from outside), see `keyLux`: a day interior with big windows reads bright as in a photo, a lamp-lit evening is exposed as before
 * (lamps alone fix the key there). The exposure moves towards its target with a short ease in the app and at once under automation.
 */
export function ExposureAdapt({ model, exposureEV, viewMode, tone }: { model: Extract<LightingModel, { ok: true }>; exposureEV: number; viewMode: ViewMode; tone: { exposureScale: number } }) {
  const current = useRef(0);
  const invalidate = useThree((s) => s.invalidate);
  useFrame(({ gl, camera }, delta) => {
    const camera2d = viewMode === 'top' ? null : { x: camera.position.x, z: camera.position.z };
    const key = keyLux({ field: probeField(), camera: camera2d, lampLux: model.lampLux, openAirLux: model.keyLux });
    const target = autoExposure(key, 0, 0) * Math.pow(2, exposureEV) * tone.exposureScale;
    const next = adaptExposure(current.current, target, delta, settledAtOnce() ? 0 : ADAPT_TAU_S);
    current.current = next;
    gl.toneMappingExposure = next;
    if (next !== target) invalidate();
  });
  return null;
}
