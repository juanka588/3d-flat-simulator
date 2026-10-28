import type { ProbeSettings } from './probe-grid';

/**
 * Rendering budget. Phones (coarse primary pointer) and weak machines (<= 2 logical cores) get a
 * lower pixel ratio cap and smaller shadow maps; everything else keeps the full quality.
 * `?quality=low|high` in the URL forces a profile (handy for testing and for debugging a device).
 */
export interface PerfProfile {
  low: boolean;
  /** Upper bound of the canvas device pixel ratio. */
  maxDpr: number;
  sunMap: number;
  pointMap: number;
  areaMap: number;
  spotMap: number;
  /** Most shadow-casting lamp lights (every one costs a shadow map and a texture unit); the rest are unshadowed. */
  maxShadowLamps: number;
  /** Real lights a `grid` lamp is split into (see `planRenderLights`). */
  gridTiles: number;
  /** Reflections of a neutral interior on glossy surfaces (an environment map, one more texture lookup per pixel). Off on low. */
  environment: boolean;
  /** Soft contact shadows under furniture (one extra plane over the floors). Off on low. */
  contactShadows: boolean;
  /** Baked light-probe grid for the indirect light (see probe-grid.ts); null = the old per-room bounce and ambient (`?gi=off`). */
  probes: ProbeSettings | null;
  /** Blur radius (texels) of the sun's and lamps' shadow edges; the filter always takes the same number of samples. */
  shadowRadius: number;
}

export const FULL_PROFILE: PerfProfile = { low: false, maxDpr: 2, sunMap: 2048, pointMap: 512, areaMap: 1024, spotMap: 1024, maxShadowLamps: 12, gridTiles: 4, environment: true, contactShadows: true, probes: { spacing: 0.5, cube: 8, bounces: 1 }, shadowRadius: 3 };
export const LOW_PROFILE: PerfProfile = { low: true, maxDpr: 1.5, sunMap: 1024, pointMap: 256, areaMap: 512, spotMap: 512, maxShadowLamps: 6, gridTiles: 2, environment: false, contactShadows: false, probes: { spacing: 1, cube: 8, bounces: 0 }, shadowRadius: 1.5 };

/**
 * Texture units a lit material needs besides the lamp shadow maps. The heaviest are streamed provider models (glTF
 * PBR): colour, normal, roughness, metalness, occlusion and emissive maps, plus the environment map and the sun's
 * shadow map (8), and the light-probe atlas (1: one `sampler3D` holds the spherical harmonics AND the wall visibility, see
 * probe-shader.ts; it replaces the shell's per-room `aoMap` and bounce `emissiveMap`, which glTF materials never had). A fragment shader cannot use more than the GPU's `MAX_TEXTURE_IMAGE_UNITS` (16 on
 * most desktops and phones): a material over it fails to compile and is not drawn at all (only its contact shadow
 * shows), so the lamp shadow maps get what is left (7 on such a GPU).
 */
export const RESERVED_TEXTURE_UNITS = 9;

/** Shadow-casting lamp lights the profile allows on a GPU with `maxTextures` fragment texture units (at least 2). */
export function shadowLampBudget(profile: PerfProfile, maxTextures: number): number {
  return Math.max(2, Math.min(profile.maxShadowLamps, Math.floor(maxTextures) - RESERVED_TEXTURE_UNITS));
}

/** Cores at or below which a desktop is treated as low-end. 4-core CI runners keep full quality. */
export const LOW_CORE_COUNT = 2;

export function perfProfileFor(input: { coarsePointer: boolean; cores?: number; override?: string | null }): PerfProfile {
  if (input.override === 'low') return LOW_PROFILE;
  if (input.override === 'high') return FULL_PROFILE;
  const weak = input.cores !== undefined && input.cores > 0 && input.cores <= LOW_CORE_COUNT;
  return input.coarsePointer || weak ? LOW_PROFILE : FULL_PROFILE;
}

let cached: PerfProfile | null = null;

/** The profile of this device, decided once per page load (shadow maps are allocated from it). */
export function getPerfProfile(): PerfProfile {
  if (cached) return cached;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  // The URL wins; then the build/dev-server default (`VITE_FLAT_QUALITY=low`, used by the nightly CI whose software GL
  // compiles the full profile's shaders 40% slower); then the device heuristics.
  const urlQuality = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('quality') : null;
  const override = urlQuality ?? (import.meta.env?.VITE_FLAT_QUALITY as string | undefined) ?? null;
  const base = perfProfileFor({ coarsePointer: coarse, cores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined, override });
  // `?ao=off` leaves out the contact shadows and wall creases (measurements of flat lighting, debugging).
  const aoOff = typeof location !== 'undefined' && ['0', 'off'].includes(new URLSearchParams(location.search).get('ao') ?? '');
  // `?gi=off` (or a build with `VITE_FLAT_GI=off`) falls back to the old per-room bounce and sky ambient (no probe grid).
  const gi = (typeof location !== 'undefined' ? new URLSearchParams(location.search).get('gi') : null) ?? (import.meta.env?.VITE_FLAT_GI as string | undefined) ?? '';
  const giOff = ['0', 'off'].includes(gi);
  cached = { ...base, ...(aoOff ? { contactShadows: false } : {}), ...(giOff ? { probes: null } : {}) };
  return cached;
}
