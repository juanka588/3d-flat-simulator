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
}

export const FULL_PROFILE: PerfProfile = { low: false, maxDpr: 2, sunMap: 2048, pointMap: 512, areaMap: 1024, spotMap: 1024 };
export const LOW_PROFILE: PerfProfile = { low: true, maxDpr: 1.5, sunMap: 1024, pointMap: 256, areaMap: 512, spotMap: 512 };

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
  const override = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('quality') : null;
  cached = perfProfileFor({ coarsePointer: coarse, cores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined, override });
  return cached;
}
