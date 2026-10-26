import {
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
 *   lamps -> Point/SpotLight.intensity  = candela (decay 2, distance 0); an area panel is a shadow-casting
 *            point light just below the panel at lm / (2pi) (RectAreaLight cannot cast shadows)
 *   sky   -> HemisphereLight.intensity  = AMBIENT_FRACTION * sky illuminance on a horizontal plane
 * Lamps are never fudged. Sun and sky are "exact geometry, tuned brightness for screen" (see
 * docs/photometry.md, "Screen tuning of daylight"): a clear noon (~1e5 lux) and a 150 lx lamp-lit
 * room differ by ~3 orders of magnitude, and a physical sun at 5x the (unoccluded) hemisphere
 * clips every sun patch to white while the shade falls to black. So the light *fed to three.js* is
 * compressed: `sunIntensity` is a soft-clipped sun (never more than about SUN_TO_AMBIENT_RATIO
 * times the hemisphere), and the exposure is keyed on the *rendered* illuminance
 * `ambientIntensity + sunIntensity + lamps`, so shade stays mid-tone while the sun patch stays
 * bright. The physical lux stay in the
 * model (`sunLux`, `ambientLux`) for readouts. Night, evening and lamps-only scenes have no sun,
 * so none of this applies to them. The result is `toneMappingExposure` (NeutralToneMapping).
 */

/**
 * Fraction of the open-sky illuminance that the (unoccluded) hemisphere light delivers to
 * everything, including interiors. A hemisphere light cannot be shadowed by walls, so only a
 * fraction of the sky is used: shade stays readable but clearly darker than the sun patch or a
 * lit lamp (at noon about 17 klx * 0.3 = 5 klx against ~100 klx of direct sun), and the
 * interior is never as bright as outdoors. Raise it for brighter shade, lower it for moodier rooms.
 */
export const AMBIENT_FRACTION = 0.5;

/** How far the hemisphere light's sky colour is pulled towards white, so shade is not tinted blue. */
export const AMBIENT_DESATURATION = 0.92;

/** Luminance of the hemisphere's ground colour (light bounced up from the ground), relative to the sky colour (1). */
export const AMBIENT_GROUND_LUMINANCE = 0.55;

/**
 * Screen tuning of the direct sun: the rendered sun saturates towards `ratio x hemisphere` (a
 * soft clip, identity for a weak sun), so a sun patch is clearly brighter than shade (about
 * SUN_TO_AMBIENT_RATIO times on a horizontal surface at most) without burning to flat white.
 */
export const SUN_TO_AMBIENT_RATIO = 2;

/** Linear albedo of the context ground (`#6f6f6c`), used to match the sky dome's below-horizon fill to it. */
export const GROUND_ALBEDO = 0.16;

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
  /** Candela (point/spot, and the point proxy of an area panel: lm / 2pi); 0 when the lamp is off. */
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
      /** What the DirectionalLight is given (lux): the screen-tuned sun, <= `sunLux`. */
      sunIntensity: number;
      /** What the HemisphereLight is given (lux): `ambientLux * AMBIENT_FRACTION`. */
      ambientIntensity: number;
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
      // A panel radiates its whole flux into the lower hemisphere: rendered as a point light with lm / (2pi) (see Lamps).
      candela = lamp.lumens / (2 * Math.PI);
      break;
  }
  return { ...lamp, color, intensity: lamp.on ? candela : 0 };
}

/** Rec. 709 relative luminance of a linear RGB triple. */
export const luminance = ([r, g, b]: RGB): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Soft-clipped sun for rendering: `c (1 - exp(-sun / c))` with `c = SUN_TO_AMBIENT_RATIO x
 * hemisphere`. Monotonic, zero at zero, and ~identity while the sun is weak (low sun, twilight).
 */
export function renderSun(sunLux: number, ambientIntensity: number): number {
  if (sunLux <= 0) return 0;
  const c = SUN_TO_AMBIENT_RATIO * Math.max(ambientIntensity, 1);
  return c * (1 - Math.exp(-sunLux / c));
}

/**
 * Hemisphere light colours. The sky colour is pulled towards white (AMBIENT_DESATURATION) and then
 * normalised to unit luminance, so the light's intensity (lux) is its real contribution and shade
 * is neutral instead of blue; the ground colour is a warm-neutral bounce at AMBIENT_GROUND_LUMINANCE.
 */
export function hemisphereColors(zenith: RGB, horizon: RGB): { sky: RGB; ground: RGB } {
  const mixed = zenith.map((v) => v + (1 - v) * AMBIENT_DESATURATION) as RGB;
  const lum = Math.max(luminance(mixed), 1e-6);
  const sky = mixed.map((v) => v / lum) as RGB;
  const warm = horizon.map((v) => v * 0.15 + 0.85) as RGB; // nearly neutral, a hint of the horizon hue
  const gl = Math.max(luminance(warm), 1e-6);
  const ground = warm.map((v) => (v / gl) * AMBIENT_GROUND_LUMINANCE) as RGB;
  return { sky, ground };
}

/**
 * Display colour (linear, after exposure) of a sunlit-and-skylit horizontal ground patch, used to
 * fill the sky dome below the horizon so it continues the context ground instead of a flat grey.
 */
export function groundDisplay(sunIntensity: number, ambientIntensity: number, sunAltitudeDeg: number, exposure: number, tint: RGB): RGB {
  const irradiance = ambientIntensity + sunIntensity * Math.max(Math.sin((sunAltitudeDeg * Math.PI) / 180), 0);
  const radiance = Math.min(((GROUND_ALBEDO * irradiance) / Math.PI) * exposure, 0.8);
  return tint.map((v) => v * radiance) as RGB;
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
    const ambientIntensity = ambientLux * AMBIENT_FRACTION;
    const sunIntensity = renderSun(sunLux, ambientIntensity);
    // Exposure key: the rendered (compressed) sun and hemisphere plus the lamps, not the 87 klux of physical sun.
    const exposure = autoExposure(sunIntensity, ambientIntensity, lampLux) * Math.pow(2, lighting.exposureEV);
    if (!Number.isFinite(exposure) || exposure <= 0) throw new Error('exposure is not a positive number');
    return {
      ok: true,
      sun,
      sunActive,
      sunLux,
      ambientLux,
      sunIntensity,
      ambientIntensity,
      zenith: sky.zenithColor,
      horizon: sky.horizonColor,
      exposure,
      lamps: lit,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), lamps };
  }
}
