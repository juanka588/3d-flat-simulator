import { GROUND_ALBEDO, hemisphereColors, luminance } from './lighting';
import type { RGB } from './lighting';

/**
 * Light of the sky as the probe bake sees it, in scene units (radiance, so that a dome of radiance L lights an open
 * horizontal surface with E = pi L lux, the unit of the hemisphere light it replaces).
 */
export interface BakeSky {
  zenith: RGB;
  horizon: RGB;
  /** Radiance below the horizon: the ground lit by sun and sky. */
  ground: RGB;
}

/**
 * Share of the sky's illuminance that reaches the surfaces OUTSIDE the probe grid (the neighbouring buildings, the ground, the host
 * facade) as plain ambient fill when the probes carry the sky. Inside the grid (the flat plus a margin) the fill is switched off by
 * the shader (`probeFillWeight`, probe-shader.ts): windows and walls decide, a windowless room is dark.
 */
export const PROBE_SKY_FILL = 0.06;
/**
 * Share of the ambient that the environment map delivers when probes carry the sky. The map is kept for the reflections of glossy
 * surfaces, but three.js also lights diffuse surfaces with it (unoccluded; inside the probe grid that part is switched off like the
 * hemisphere fill, see `probeFillWeight`), hence a small share for what lies outside the grid.
 */
export const PROBE_ENV_SHARE = 0.03;

/** Brightness of the sky dome the probes see relative to the real sky (1 = physical), for probes outdoors. */
export const PROBE_SKY_GAIN = 1;
/**
 * Screen tuning of the daylight in rooms (like AMBIENT_FRACTION): the exposure is keyed on the open-sky ambient, and a room that
 * only sees the sky through a window gets a few per cent of it, which would render every day interior near black. The sky seen by
 * probes INDOORS (inside a habitable room) is therefore brighter than the sky it stands for; outdoors, the balcony and the ground
 * stay physical and lamp light is never scaled. The principled alternative, an exposure that adapts to the light at the camera,
 * is available behind `?exposure=adapt` (ExposureAdapt.tsx).
 */
export const PROBE_INDOOR_SKY_GAIN = 10;

/** The environment/hemisphere split of the ambient when the probes carry the sky and bounce. */
/** `?name=N` in the URL (tuning and debugging only), else undefined. */
export function tuning(name: string): number | undefined {
  const v = typeof location !== 'undefined' ? new URLSearchParams(location.search).get(name) : null;
  return v !== null && Number.isFinite(Number(v)) ? Number(v) : undefined;
}

export function probeAmbientSplit(ambientIntensity: number, meanRadiance: number | null): { hemisphere: number; environment: number } {
  return {
    hemisphere: ambientIntensity * (tuning('skyfill') ?? PROBE_SKY_FILL),
    environment: meanRadiance && meanRadiance > 0 ? ((tuning('envshare') ?? PROBE_ENV_SHARE) * ambientIntensity) / (Math.PI * meanRadiance) : 0,
  };
}

/**
 * The sky dome for the bake. Gradient: horizon to zenith as `lumH + (lumZ - lumH) sqrt(h)` (the shape of the displayed dome),
 * scaled so that an unobstructed horizontal surface receives exactly `ambientIntensity` lux:
 * E = 2 pi k (lumH / 2 + 0.4 (lumZ - lumH)) for L(h) = k (lumH + (lumZ - lumH) sqrt(h)).
 */
export function bakeSky(input: { zenith: RGB; horizon: RGB; ambientIntensity: number; sunIntensity: number; sunAltitudeDeg: number; gain?: number }): BakeSky {
  const finite = (v: number): number => (Number.isFinite(v) ? v : 0);
  input = { ...input, ambientIntensity: Math.max(0, finite(input.ambientIntensity)), sunIntensity: Math.max(0, finite(input.sunIntensity)), sunAltitudeDeg: finite(input.sunAltitudeDeg), zenith: input.zenith.map(finite) as RGB, horizon: input.horizon.map(finite) as RGB };
  const lumZ = Math.max(luminance(input.zenith), 1e-4);
  const lumH = Math.max(luminance(input.horizon), 1e-4);
  const norm = 2 * Math.PI * (lumH / 2 + 0.4 * (lumZ - lumH));
  const k = norm > 0 ? (input.ambientIntensity * (input.gain ?? PROBE_SKY_GAIN)) / norm : 0;
  const tints = hemisphereColors(input.zenith, input.horizon);
  const scale = (tint: RGB, lum: number): RGB => tint.map((v) => v * lum * k) as RGB;
  const irradiance = input.ambientIntensity + input.sunIntensity * Math.max(Math.sin((input.sunAltitudeDeg * Math.PI) / 180), 0);
  const groundRadiance = (GROUND_ALBEDO * irradiance) / Math.PI;
  return { zenith: scale(tints.sky, lumZ), horizon: scale(tints.sky, lumH), ground: [groundRadiance, groundRadiance, groundRadiance] };
}

/** Radiance (cd/m2) a diffuse surface of `albedo` lit by the open sky gives off: what the bake adds to context buildings and ground. */
export const skyLitRadiance = (albedo: number, ambientIntensity: number, share = 1): number => (albedo * ambientIntensity * share) / Math.PI;
