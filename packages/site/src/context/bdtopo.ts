import { pointInRing, polygonIntersectsRect, subtractRect } from '../geo/polygon';
import type { Pt, Rect } from '../geo/polygon';

/** A context building as the generator builds it (the shape of scene's `ContextBuilding`, with `host` always set). */
export interface ContextBuildingLike {
  id: string;
  footprint: Pt[];
  holes?: Pt[][];
  base: number;
  height: number;
  host: boolean;
}

/** One polygon part of a WFS feature: `lonlat` is the outer ring and `holes` the inner rings ([lon, lat] pairs). */
export interface RingEntry {
  key: string;
  featureId: string;
  part: number | null;
  props: Record<string, unknown>;
  lonlat: Pt[];
  holes: Pt[][];
}

/**
 * Flattens WFS features into one entry per polygon part: `{key, featureId, part, props, lonlat,
 * holes}` with `lonlat` the outer ring and `holes` the inner rings ([lon, lat] pairs). Features
 * with null or unsupported geometry are skipped (and counted in `skipped.length`).
 */
export function extractRings(geojson: unknown): { rings: RingEntry[]; skipped: unknown[] } {
  const rings: RingEntry[] = [];
  const skipped: unknown[] = [];
  // The WFS response is untrusted JSON: read it loosely, exactly as the original untyped tool did.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const features: any[] = (geojson as any)?.features ?? [];
  for (const f of features) {
    const g = f?.geometry;
    const polys: any[][][] = g?.type === 'MultiPolygon' ? g.coordinates : g?.type === 'Polygon' ? [g.coordinates] : [];
    const valid = polys.filter((poly) => Array.isArray(poly) && Array.isArray(poly[0]) && poly[0].length >= 4);
    if (valid.length === 0) {
      skipped.push(f?.id ?? f?.properties?.cleabs ?? '?');
      continue;
    }
    valid.forEach((poly, k) => {
      rings.push({
        key: f.properties?.cleabs ?? f.id,
        featureId: f.id,
        part: valid.length > 1 ? k : null,
        props: f.properties ?? {},
        lonlat: poly[0]!.map((c): Pt => [c[0], c[1]]),
        holes: poly.slice(1).map((h) => h.map((c): Pt => [c[0], c[1]])),
      });
    });
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { rings, skipped };
}

/**
 * Splits a host building into context bands: `:below` (only when there is something below the
 * flat's storey, i.e. `storeyBase > base`), `:flat-storey-k` (the footprint minus the cut-away
 * rectangle, from max(base, storeyBase) to `storeyTop`) and `:above` (when the roof is more than
 * 10 cm above `storeyTop`). Inner rings (`holes`) are kept on the full-footprint bands, and on a
 * storey piece when they lie wholly inside it and clear of the cut-away; otherwise they are
 * dropped there (conservatively solid).
 */
export function hostBands({
  id,
  footprint,
  holes = [],
  base,
  height,
  storeyBase,
  storeyTop,
  flatCut,
}: {
  id: string;
  footprint: Pt[];
  holes?: Pt[][];
  base: number;
  height: number;
  storeyBase: number;
  storeyTop: number;
  flatCut: Rect;
}): ContextBuildingLike[] {
  const out: ContextBuildingLike[] = [];
  const roofTop = base + height;
  const withHoles = (b: ContextBuildingLike, hs: Pt[][]): ContextBuildingLike => (hs.length ? { ...b, holes: hs } : b);
  if (storeyBase - base > 1e-6) {
    out.push(withHoles({ id: `${id}:below`, footprint, base, height: storeyBase - base, host: true }, holes));
  }
  const bandBase = Math.max(base, storeyBase);
  const cutHit = (h: Pt[]) =>
    polygonIntersectsRect(h, flatCut) > 0 || h.some((p) => p[0] >= flatCut.minX && p[0] <= flatCut.maxX && p[1] >= flatCut.minY && p[1] <= flatCut.maxY);
  subtractRect(footprint, flatCut).forEach((piece, k) => {
    const hs = holes.filter((h) => !cutHit(h) && h.every((p) => pointInRing(p, piece)));
    out.push(withHoles({ id: `${id}:flat-storey-${k}`, footprint: piece, base: bandBase, height: storeyTop - bandBase, host: true }, hs));
  });
  if (roofTop > storeyTop + 0.1) {
    out.push(withHoles({ id: `${id}:above`, footprint, base: storeyTop, height: roofTop - storeyTop, host: true }, holes));
  }
  return out;
}
