import {
  areaNits,
  autoExposure,
  kelvinToLinearRgb,
  pointCandela,
  polygonArea,
  skyState,
  spotCandela,
  sunAt,
} from '@flat/scene';
import type { Light, LightingView, Scene, SunState } from '@flat/scene';

/**
 * Light unit scaling (see docs/photometry.md): every light is given in real photometric units,
 * which three.js (r155+, physically based) consumes directly:
 *   sun   -> DirectionalLight.intensity = lux on a surface facing the sun
 *   lamps -> Point/SpotLight.intensity  = candela (decay 2, distance 0); RectAreaLight = nits
 *   sky   -> HemisphereLight.intensity  = AMBIENT_FRACTION * sky illuminance on a horizontal plane
 * No light is fudged to look right. A clear noon (~1e5 lux) and a 150 lx lamp-lit room differ by
 * ~3 orders of magnitude, so the dynamic range is absorbed by `toneMappingExposure`, set to
 * `autoExposure(sun, ambient, lamps) * 2^EV` (NeutralToneMapping).
 */

/**
 * Fraction of the open-sky illuminance that the (unoccluded) hemisphere light delivers to
 * everything, including interiors. A hemisphere light cannot be shadowed by walls, so only a
 * fraction of the sky is used: shade stays readable but clearly darker than the sun patch or a
 * lit lamp (at noon about 17 klx * 0.3 = 5 klx against ~100 klx of direct sun), and the
 * interior is never as bright as outdoors. Raise it for brighter shade, lower it for moodier rooms.
 */
export const AMBIENT_FRACTION = 0.3;

/** How far the hemisphere light's sky colour is pulled towards white, so shade is not tinted deep blue. */
export const AMBIENT_DESATURATION = 0.6;

/** Above this direct-sun illuminance (lux) lamps are lost in daylight, so they skip shadow maps. */
export const LAMP_SHADOW_SUN_LUX_MAX = 10_000;

export type RGB = [number, number, number];

export interface LampSpec {
  id: string;
  name: string;
  type: Light['type'];
  roomId: string | undefined;
  /** World position (x = plan x, y = elevation, z = plan y). */
  position: [number, number, number];
  on: boolean;
  lumens: number;
  kelvin: number;
  /** Linear RGB of the lamp colour, luminance-normalised. */
  color: RGB;
  /** Candela (point/spot) or nits (area); 0 when the lamp is off. */
  intensity: number;
  /** Spot half-angle in radians (three's `angle`). */
  angle: number;
  width: number;
  depth: number;
  /** Plan rotation of an area panel, degrees. */
  rotation: number;
}

export type LightingModel =
  | {
      ok: true;
      sun: SunState;
      /** Whether the sun contributes at all (enabled and above the horizon). */
      sunActive: boolean;
      /** Direct-sun illuminance fed to the light (0 when inactive). */
      sunLux: number;
      ambientLux: number;
      zenith: RGB;
      horizon: RGB;
      exposure: number;
      lamps: LampSpec[];
    }
  | { ok: false; error: string; lamps: LampSpec[] };

/** Scene lights with the lighting view's overrides applied; photometry is filled in separately. */
export function resolveLamps(scene: Scene, lighting: LightingView): LampSpec[] {
  return scene.lights.map((light) => {
    const o = lighting.lamps[light.id] ?? {};
    return {
      id: light.id,
      name: light.name ?? light.id,
      type: light.type,
      roomId: light.roomId,
      position: [light.position[0], light.elevation, light.position[1]],
      on: o.on ?? light.on,
      lumens: o.lumens ?? light.lumens,
      kelvin: o.kelvin ?? light.kelvin,
      color: [1, 1, 1],
      intensity: 0,
      angle: light.type === 'spot' ? (light.angle * Math.PI) / 360 : 0,
      width: light.type === 'area' ? light.width : 0,
      depth: light.type === 'area' ? light.depth : 0,
      rotation: light.type === 'area' ? light.rotation : 0,
    };
  });
}

function withPhotometry(lamp: LampSpec, light: Light): LampSpec {
  const color = kelvinToLinearRgb(lamp.kelvin);
  let candela: number;
  switch (light.type) {
    case 'point':
      candela = pointCandela(lamp.lumens);
      break;
    case 'spot':
      candela = spotCandela(lamp.lumens, light.angle);
      break;
    case 'area':
      candela = areaNits(lamp.lumens, light.width, light.depth);
      break;
  }
  return { ...lamp, color, intensity: lamp.on ? candela : 0 };
}

/** Total floor area of the habitable rooms (balconies excluded), for the lamp share of the exposure. */
function interiorArea(scene: Scene): number {
  return scene.rooms.filter((r) => r.type !== 'balcony').reduce((sum, r) => sum + polygonArea(r.polygon), 0);
}

/**
 * Everything the viewer needs to light the flat, from the contracts in `@flat/scene`. Any maths
 * failure yields `ok: false` so the viewer can fall back to neutral lighting instead of crashing.
 */
export function computeLighting(scene: Scene, lighting: LightingView): LightingModel {
  const lamps = resolveLamps(scene, lighting);
  try {
    const sun = sunAt(scene.site, lighting.date, lighting.time);
    const sunActive = lighting.sunEnabled && sun.isUp;
    const sunLux = sunActive ? sun.illuminanceLux : 0;
    const sky = skyState(sun.altitudeDeg);
    const ambientLux = lighting.sunEnabled ? sky.ambientLux : 0;
    const lit = lamps.map((lamp, i) => withPhotometry(lamp, scene.lights[i]!));
    // Mean illuminance the lamps add over the habitable area (lumens per square metre).
    const area = Math.max(interiorArea(scene), 1);
    const lampLux = lit.reduce((sum, l) => sum + (l.on ? l.lumens : 0), 0) / area;
    const exposure = autoExposure(sunLux, ambientLux, lampLux) * Math.pow(2, lighting.exposureEV);
    if (!Number.isFinite(exposure) || exposure <= 0) throw new Error('exposure is not a positive number');
    return {
      ok: true,
      sun,
      sunActive,
      sunLux,
      ambientLux,
      zenith: sky.zenithColor,
      horizon: sky.horizonColor,
      exposure,
      lamps: lit,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), lamps };
  }
}
