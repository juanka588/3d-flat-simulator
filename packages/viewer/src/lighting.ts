import {
  autoExposure,
  gridClusters,
  gridFixtures,
  kelvinToLinearRgb,
  lightFixtureCount,
  lightLumens,
  pointCandela,
  polygonArea,
  roomBounceLux,
  roomIdOfLight,
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
 *            (with the baked light probes, the default, the hemisphere is only a small fill and the sky comes through the
 *            windows: see probe-light.ts and docs/photometry.md "Indirect light: baked light probes")
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

/**
 * Automatic white balance, like a camera's AWB. A room lit by 2700 K lamps alone would render orange, because the
 * display is neutral; the eye adapts. The colour of every lamp is shifted towards `AWB_TARGET_KELVIN` (in mired, so the
 * step is perceptually even) by `AWB_STRENGTH` x the lamp share of the light the view is exposed for (see `awbWeight`):
 * a lamp-only night view moves a 2700 K lamp to about 4000 K (still warm), while daylight dominated views are untouched,
 * so a lamp next to a sunny window keeps its warm cast against the daylight. The lamp's real photometry (lumens,
 * kelvin in the UI and in the scene) is never changed: only the colour it is drawn with.
 */
export const AWB_TARGET_KELVIN = 4300;
export const AWB_STRENGTH = 0.9;

/** Share of the rendered illuminance (`sun + sky + lamps`) that the lamps deliver, 0 (daylight) to 1 (lamps only). */
export function awbWeight(sunIntensity: number, ambientIntensity: number, lampLux: number): number {
  const total = sunIntensity + ambientIntensity + lampLux;
  return total > 0 ? Math.min(1, Math.max(0, lampLux / total)) : 0;
}

/** The colour temperature a lamp is drawn with after white balance (`weight` from `awbWeight`). */
export function whiteBalancedKelvin(kelvin: number, weight: number): number {
  const mired = 1e6 / kelvin;
  const target = 1e6 / AWB_TARGET_KELVIN;
  return 1e6 / (mired + (target - mired) * AWB_STRENGTH * Math.min(1, Math.max(0, weight)));
}

/**
 * Image-based light. The environment map is a neutral interior; it carries `ENV_SHARE` of the sky's diffuse light and
 * the hemisphere light the rest, so the total ambient (and so the exposure model) is unchanged while glossy surfaces
 * get something to reflect. An environment pixel of radiance L lights a diffuse surface like a hemisphere of intensity
 * pi x L, hence the division by pi x the map's mean radiance.
 */
export const ENV_SHARE = 0.4;

export function environmentLight(ambientIntensity: number, meanRadiance: number): { hemisphere: number; environment: number } {
  return {
    hemisphere: ambientIntensity * (1 - ENV_SHARE),
    environment: meanRadiance > 0 ? (ENV_SHARE * ambientIntensity) / (Math.PI * meanRadiance) : 0,
  };
}

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
  /** Candela (point/spot, and the point proxy of an area panel: lm / 2pi); 0 when the lamp is off. Grids: see `planRenderLights`. */
  intensity: number;
  /** Spot half-angle in radians (three's `angle`). */
  angle: number;
  width: number;
  depth: number;
  /** Plan rotation of an area panel, degrees. */
  rotation: number;
  /** True for the light of a lamp item (it has its own model, so no fixture mesh is drawn). */
  linked: boolean;
  /** Grids: the layout. `fixtures` are world positions `[x, y, z]`; `lumens` is the TOTAL, `lumensEach` the per-fixture figure. */
  grid?: { rows: number; cols: number; lumensEach: number; beam: number; width: number; depth: number; fixtures: [number, number, number][] };
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
      /** Mean illuminance the lamps add over the habitable area (lux) and the open-air total the exposure above is keyed on (rendered sun + sky + lamps). */
      lampLux: number;
      keyLux: number;
      /** Lamp share of the light (see `awbWeight`): how far lamp colours are white-balanced. */
      awb: number;
      lamps: LampSpec[];
    }
  | { ok: false; error: string; lamps: LampSpec[] };

/** Scene lights with the lighting view's overrides applied; photometry is filled in separately. */
export function resolveLamps(scene: Scene, lighting: LightingView): LampSpec[] {
  return scene.lights.map((light) => {
    const o = lighting.lamps[light.id] ?? {};
    const total = o.lumens ?? lightLumens(light);
    const count = lightFixtureCount(light);
    const base: LampSpec = {
      id: light.id,
      name: light.name ?? light.id,
      type: light.type,
      roomId: light.roomId,
      position: [light.position[0], light.elevation, light.position[1]],
      on: o.on ?? light.on,
      lumens: total,
      kelvin: o.kelvin ?? light.kelvin,
      color: [1, 1, 1],
      intensity: 0,
      angle: light.type === 'spot' ? (light.angle * Math.PI) / 360 : 0,
      width: light.type === 'area' || light.type === 'grid' ? light.width : 0,
      depth: light.type === 'area' || light.type === 'grid' ? light.depth : 0,
      rotation: light.type === 'area' || light.type === 'grid' ? light.rotation : 0,
      linked: light.itemId !== undefined,
    };
    if (light.type === 'grid') {
      return {
        ...base,
        angle: (light.angle * Math.PI) / 360,
        grid: {
          rows: light.rows,
          cols: light.cols,
          lumensEach: total / count,
          beam: light.angle,
          width: light.width,
          depth: light.depth,
          fixtures: gridFixtures(light).map(([x, z]) => [x, light.elevation, z]),
        },
      };
    }
    return base;
  });
}

function withPhotometry(lamp: LampSpec, light: Light, awb: number): LampSpec {
  const color = kelvinToLinearRgb(whiteBalancedKelvin(lamp.kelvin, awb));
  let candela = 0;
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
    case 'grid':
      // A grid is lit by a few cluster lights (see `planRenderLights`); this is the candela of ONE fixture at its beam angle.
      candela = spotCandela(lamp.lumens / lightFixtureCount(light), light.angle);
      break;
  }
  return { ...lamp, color, intensity: lamp.on ? candela : 0 };
}

/**
 * An area panel is lit as a point light this far below the panel (metres), clear of the panel's own mesh and of the
 * ceiling slab, so the cube shadow map sees the room and not the panel.
 */
export const AREA_LIGHT_DROP_M = 0.06;

/** Unshadowed lights are cut off at this distance (three's smooth `distance` window), to limit light through walls. */
export const UNSHADOWED_REACH_M = 5;

/** One real three.js light of the rig. */
export interface RenderLight {
  /** Unique, stable per scene structure: `<lampId>` or `<lampId>#<tile>` for a grid tile. */
  key: string;
  lampId: string;
  kind: 'point' | 'spot';
  /** World position `[x, y, z]`. */
  position: [number, number, number];
  /** Candela; 0 when the lamp is off (the light still exists, so toggling never changes the shaders). */
  intensity: number;
  /** Spot half-angle, radians. */
  angle: number;
  color: RGB;
  /** Casts a shadow. Decided by the position in the lamp list, never by `on`, so toggling cannot recompile. */
  shadow: boolean;
  /** Cut-off distance (0 = none). Set for unshadowed lights. */
  reach: number;
}

export interface RenderBudget {
  /** Shadow-casting lights allowed in total (see `shadowLampBudget`). */
  shadowLamps: number;
  /** Real lights a grid is split into. */
  gridTiles: number;
}

/**
 * Turns the lamps into the real lights the renderer draws, with a constant structure: one light per lamp (a grid:
 * `gridTiles` tiles of neighbouring fixtures, each lit as one spot at the tile centroid with the tile's flux, so a grid's
 * TOTAL flux is exact and only its distribution is approximate). The first `shadowLamps` lights, in scene order, cast
 * shadows; the others are unshadowed with a cut-off (`UNSHADOWED_REACH_M`). Lamps are never reordered by `on`.
 */
export function planRenderLights(lamps: readonly LampSpec[], budget: RenderBudget): RenderLight[] {
  const out: RenderLight[] = [];
  const push = (l: Omit<RenderLight, 'shadow' | 'reach'>) => {
    const shadow = out.length < budget.shadowLamps;
    out.push({ ...l, shadow, reach: shadow ? 0 : UNSHADOWED_REACH_M });
  };
  for (const lamp of lamps) {
    if (lamp.grid) {
      const g = lamp.grid;
      const tiles = gridClusters({ position: [0, 0], rows: g.rows, cols: g.cols, width: g.width, depth: g.depth, rotation: lamp.rotation }, budget.gridTiles);
      const [cx, cy, cz] = lamp.position;
      tiles.forEach((t, k) =>
        push({
          key: `${lamp.id}#${k}`,
          lampId: lamp.id,
          kind: 'spot',
          position: [cx + t.position[0], cy, cz + t.position[1]],
          intensity: lamp.on ? spotCandela(t.count * g.lumensEach, g.beam) : 0,
          angle: lamp.angle,
          color: lamp.color,
        }),
      );
    } else {
      const [x, y, z] = lamp.position;
      push({
        key: lamp.id,
        lampId: lamp.id,
        kind: lamp.type === 'spot' ? 'spot' : 'point',
        position: [x, lamp.type === 'area' ? y - AREA_LIGHT_DROP_M : y, z],
        intensity: lamp.intensity,
        angle: lamp.angle,
        color: lamp.color,
      });
    }
  }
  return out;
}

/** Per-room bounce of the lamps for the viewer: the room's mean inter-reflected illuminance and the lamps' mean colour. */
export interface RoomBounce {
  /** Bounce illuminance in lux. */
  lux: number;
  /** Flux-weighted mean lamp colour (linear, luminance 1). */
  color: RGB;
}

/**
 * Approximate indirect light of the lamps per room (see `lampBounceLux`): only the lamps of a room light that room. `awb` white-balances the colour as the lamps themselves are.
 * Rooms without a lit lamp are absent.
 */
export function roomLampBounce(scene: Scene, lamps: readonly LampSpec[], awb = 0): Record<string, RoomBounce> {
  const lux = roomBounceLux(scene, lamps.map((l) => ({ roomId: l.roomId, position: [l.position[0], l.position[2]], lumens: l.lumens, on: l.on })));
  const colors: Record<string, { sum: RGB; weight: number }> = {};
  for (const lamp of lamps) {
    if (!lamp.on || !(lamp.lumens > 0)) continue;
    const id = roomIdOfLight(scene, { roomId: lamp.roomId, position: [lamp.position[0], lamp.position[2]] });
    if (!id) continue;
    const c = (colors[id] ??= { sum: [0, 0, 0], weight: 0 });
    const rgb = kelvinToLinearRgb(whiteBalancedKelvin(lamp.kelvin, awb));
    for (let k = 0; k < 3; k++) c.sum[k] = c.sum[k]! + rgb[k]! * lamp.lumens;
    c.weight += lamp.lumens;
  }
  const out: Record<string, RoomBounce> = {};
  for (const [id, e] of Object.entries(lux)) {
    const c = colors[id];
    out[id] = { lux: e, color: c && c.weight > 0 ? (c.sum.map((v) => v / c.weight) as RGB) : [1, 1, 1] };
  }
  return out;
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

/** Hard bounds of the auto exposure (before the user's EV): a noon is ~3e-4, a starlit night ~3 (see `autoExposure`); nothing outside may reach the renderer. */
export const EXPOSURE_MIN = 1e-4;
export const EXPOSURE_MAX = 4;
/**
 * How many stops brighter than the exposure the DISPLAYED probe grid was baked for the image may be exposed. Probes lag the lighting
 * (debounce plus bake time, longer while the sun animates); an exposure that races ahead of a grid baked for a much brighter
 * light (noon grid, sunrise sky: x100) burns the interior as if the EV were at maximum. Darker than the grid's exposure is never limited.
 */
export const STALE_GRID_MAX_EV = 1;

/** `exposure` (for the live light `keyLux`) limited by the light the displayed probe grid was baked for (`gridKeyLux`, null = no grid yet). */
export function gridLimitedExposure(exposure: number, keyLux: number, gridKeyLux: number | null): number {
  if (gridKeyLux === null || !Number.isFinite(gridKeyLux) || !Number.isFinite(keyLux)) return exposure;
  const ratio = (Math.pow(2, STALE_GRID_MAX_EV) * autoExposure(gridKeyLux, 0, 0)) / autoExposure(keyLux, 0, 0);
  return exposure * Math.min(1, ratio);
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
    // Mean illuminance the lamps add over the habitable area (lumens per square metre).
    const area = Math.max(interiorArea(scene), 1);
    const lampLux = lamps.reduce((sum, l) => sum + (l.on ? l.lumens : 0), 0) / area;
    const ambientIntensity = ambientLux * AMBIENT_FRACTION;
    const sunIntensity = renderSun(sunLux, ambientIntensity);
    const awb = awbWeight(sunIntensity, ambientIntensity, lampLux);
    const lit = lamps.map((lamp, i) => withPhotometry(lamp, scene.lights[i]!, awb));
    // Exposure key: the rendered (compressed) sun and hemisphere plus the lamps, not the 87 klux of physical sun.
    const ev = Number.isFinite(lighting.exposureEV) ? lighting.exposureEV : 0;
    const exposure = Math.min(EXPOSURE_MAX, Math.max(EXPOSURE_MIN, autoExposure(sunIntensity, ambientIntensity, lampLux))) * Math.pow(2, ev);
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
      lampLux,
      keyLux: sunIntensity + ambientIntensity + lampLux,
      awb,
      lamps: lit,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), lamps };
  }
}
