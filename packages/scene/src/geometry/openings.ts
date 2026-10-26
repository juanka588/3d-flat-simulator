import type { Opening } from '../schema';
import type { WallFootprint } from './junctions';

const EPS = 1e-6;

/** Opening span in wall coordinates (not yet clamped to the footprint). */
export function openingSpan(o: Pick<Opening, 'offset' | 'width' | 'sill' | 'height'>, wallHeight: number) {
  return {
    from: o.offset - o.width / 2,
    to: o.offset + o.width / 2,
    sill: Math.min(o.sill, wallHeight),
    top: Math.min(o.sill + o.height, wallHeight),
  };
}

export interface Hole {
  openingId: string;
  /** Along the wall centreline, clamped to the trimmed footprint and to earlier holes. */
  from: number;
  to: number;
  sill: number;
  top: number;
}

/**
 * The single source of truth for where a wall is cut: opening spans clamped to the wall's
 * trimmed footprint (so a door on a T-stem stops at the host face), sorted, non-overlapping,
 * and without empty holes. Both the wall mesh and the fittings are built from this.
 */
export function clampedOpeningSpans(
  openings: readonly Opening[],
  footprint: WallFootprint,
  wallHeight: number,
): Hole[] {
  const lo = Math.max(footprint.startLeft, footprint.startRight);
  const hi = Math.min(footprint.endLeft, footprint.endRight);
  const spans = openings
    .map((o) => ({ id: o.id, ...openingSpan(o, wallHeight) }))
    .sort((p, q) => p.from - q.from);
  const holes: Hole[] = [];
  let cursor = lo;
  for (const sp of spans) {
    const from = Math.max(sp.from, cursor);
    const to = Math.min(sp.to, hi);
    if (to - from <= EPS || sp.top - sp.sill <= EPS) continue;
    holes.push({ openingId: sp.id, from, to, sill: sp.sill, top: sp.top });
    cursor = to;
  }
  return holes;
}
