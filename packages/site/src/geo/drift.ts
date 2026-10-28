import type { Site, SiteContext } from '@flat/scene';

/** Site edits that move the flat by more than this (metres) make the generated context unusable. */
export const CONTEXT_MAX_DRIFT_M = 50;

const M_PER_DEG = 111_320;

/** Horizontal distance in metres between the context's origin and the site (small-distance approximation). */
export function originDriftMeters(context: Pick<SiteContext, 'origin'>, site: Pick<Site, 'latitude' | 'longitude'>): number {
  const dLat = (site.latitude - context.origin.latitude) * M_PER_DEG;
  const dLon = (site.longitude - context.origin.longitude) * M_PER_DEG * Math.cos((site.latitude * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}
