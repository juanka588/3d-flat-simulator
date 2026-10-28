import type { SiteContext } from './schema';

/** Ground level of a context in flat coordinates: its lowest building base. */
export function contextGround(context: Pick<SiteContext, 'buildings'>): number {
  return context.buildings.reduce((m, b) => Math.min(m, b.base), Infinity);
}
