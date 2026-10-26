import { SiteContext } from '@flat/scene';
import type { Site } from '@flat/scene';

// Context files are generated offline (tools/site-context) next to the fixtures. They may be
// absent, so they are discovered with a glob rather than imported by name.
const files = import.meta.glob('../../../../packages/scene/fixtures/*.context.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const cache = new Map<string, SiteContext | null>();

/** Site context for a fixture id (e.g. `charme-3205`), or null when none exists or it is invalid. */
export function contextFor(fixtureId: string): SiteContext | null {
  if (cache.has(fixtureId)) return cache.get(fixtureId) ?? null;
  const key = Object.keys(files).find((k) => k.endsWith(`/${fixtureId}.context.json`));
  const parsed = key ? SiteContext.safeParse(files[key]) : null;
  const context = parsed?.success ? parsed.data : null;
  if (parsed && !parsed.success) console.warn(`invalid site context for ${fixtureId}`, parsed.error.issues.slice(0, 3));
  cache.set(fixtureId, context);
  return context;
}

/** Site edits that move the flat by more than this (metres) make the generated context unusable. */
export const CONTEXT_MAX_DRIFT_M = 50;

const M_PER_DEG = 111_320;

/** Horizontal distance in metres between the context's origin and the site (small-distance approximation). */
export function originDriftMeters(context: Pick<SiteContext, 'origin'>, site: Pick<Site, 'latitude' | 'longitude'>): number {
  const dLat = (site.latitude - context.origin.latitude) * M_PER_DEG;
  const dLon = (site.longitude - context.origin.longitude) * M_PER_DEG * Math.cos((site.latitude * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/** Ground level of a context in flat coordinates: its lowest building base. */
export function contextGround(context: Pick<SiteContext, 'buildings'>): number {
  return context.buildings.reduce((m, b) => Math.min(m, b.base), Infinity);
}

/**
 * Brings a generated context in line with edits made to the scene's site afterwards:
 *  - `northAngle`: the context's plan frame has true north at plan bearing `context.northAngle`
 *    (clockwise from plan up, y down); the site now says `site.northAngle`, so every footprint
 *    is rotated clockwise (as drawn on the plan) about the flat origin by the difference.
 *    `(x, y) -> (x cos t - y sin t, x sin t + y cos t)`; plan up (0, -1) turns to (sin t, -cos t).
 *  - `floorElevation`: the ground sits at `-site.floorElevation` below the flat's floor, so
 *    all bases shift by the difference to the context's own ground.
 *  - latitude/longitude: the buildings cannot be moved sensibly; when the site is more than
 *    `CONTEXT_MAX_DRIFT_M` from the context's origin the context is `stale` and must be hidden.
 * The same context object is returned when nothing differs.
 */
export function alignContext(context: SiteContext, site: Pick<Site, 'latitude' | 'longitude' | 'northAngle' | 'floorElevation'>): { context: SiteContext | null; stale: boolean } {
  if (originDriftMeters(context, site) > CONTEXT_MAX_DRIFT_M) return { context: null, stale: true };
  const rotationDeg = site.northAngle - context.northAngle;
  const ground = contextGround(context);
  const lift = Number.isFinite(ground) ? -site.floorElevation - ground : 0;
  if (Math.abs(rotationDeg) < 1e-9 && Math.abs(lift) < 1e-9) return { context, stale: false };
  const t = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return {
    stale: false,
    context: {
      ...context,
      northAngle: site.northAngle,
      buildings: context.buildings.map((b) => ({
        ...b,
        base: b.base + lift,
        footprint: b.footprint.map(([x, y]): [number, number] => [x * cos - y * sin, x * sin + y * cos]),
      })),
    },
  };
}
