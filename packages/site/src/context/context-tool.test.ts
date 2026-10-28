import { describe, expect, it } from 'vitest';
import { SiteContext } from '@flat/scene';
import charmeContext from '@flat/scene/fixtures/charme-3205.context.json';
import charmeFlat from '@flat/scene/fixtures/charme-3205.flat.json';
import { anchorOrigin, envelopeSamples, fitFlatToFootprint, hostRings, overhang, refitContext } from '../fit/fit';
import type { FlatLike } from '../fit/fit';
import { fromEnu, planBasis, toEnu } from '../geo/enu';
import { dominantBearing, subtractRect } from '../geo/polygon';
import type { Pt } from '../geo/polygon';
import { extractRings, hostBands } from './bdtopo';
import type { ContextBuildingLike } from './bdtopo';
import { validateContext } from './validate';

const area = (p: Pt[]) => Math.abs(p.reduce((a, q, i) => a + q[0] * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * q[1], 0) / 2);
const sq = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

describe('toEnu / fromEnu', () => {
  it('maps the origin to zero and north/east to the right axes', () => {
    expect(toEnu(48.8, 2.3, 48.8, 2.3)).toEqual([0, 0]);
    const [e, n] = toEnu(48.8 + 0.001, 2.3, 48.8, 2.3);
    expect(e).toBeCloseTo(0, 9);
    expect(n).toBeCloseTo(111.19, 1);
    const [e2] = toEnu(48.8, 2.3 + 0.001, 48.8, 2.3);
    expect(e2).toBeCloseTo(111.19 * Math.cos((48.8 * Math.PI) / 180), 1);
  });
  it('round-trips', () => {
    const [e, n] = toEnu(48.79, 2.31, 48.785, 2.304);
    const [lat, lon] = fromEnu(e, n, 48.785, 2.304);
    expect(lat).toBeCloseTo(48.79, 9);
    expect(lon).toBeCloseTo(2.31, 9);
  });
});

describe('planBasis', () => {
  it('bearing 90 (plan x = east): x -> E, y (down) -> south', () => {
    const { ex, ey } = planBasis(90);
    expect(ex[0]).toBeCloseTo(1, 12);
    expect(ex[1]).toBeCloseTo(0, 12);
    expect(ey[0]).toBeCloseTo(0, 12);
    expect(ey[1]).toBeCloseTo(-1, 12);
  });
  it('is orthonormal for any bearing, with y a clockwise quarter turn of x', () => {
    for (const bx of [0, 31.5, 91.5, 200]) {
      const { ex, ey } = planBasis(bx);
      expect(Math.hypot(...ex)).toBeCloseTo(1, 12);
      expect(ex[0] * ey[0] + ex[1] * ey[1]).toBeCloseTo(0, 12);
      expect(ex[0] * ey[1] - ex[1] * ey[0]).toBeCloseTo(-1, 12);
    }
  });
});

describe('subtractRect', () => {
  const r = { minX: 4, maxX: 6, minY: 4, maxY: 6 };
  it('returns the polygon unchanged when the rectangle misses it', () => {
    const p = sq(0, 0, 3, 3);
    expect(subtractRect(p, r)).toEqual([p]);
  });
  it('cuts a hole: four disjoint pieces whose areas add up', () => {
    const pieces = subtractRect(sq(0, 0, 10, 10), r);
    expect(pieces).toHaveLength(4);
    expect(pieces.reduce((s, p) => s + area(p), 0)).toBeCloseTo(100 - 4, 6);
  });
  it('a rectangle at the edge leaves fewer pieces; a covering rectangle leaves none', () => {
    const edge = subtractRect(sq(0, 0, 10, 10), { minX: -1, maxX: 11, minY: 4, maxY: 6 });
    expect(edge).toHaveLength(2);
    expect(edge.reduce((s, p) => s + area(p), 0)).toBeCloseTo(80, 6);
    expect(subtractRect(sq(0, 0, 10, 10), { minX: -1, maxX: 11, minY: -1, maxY: 11 })).toEqual([]);
  });
});

describe('dominantBearing', () => {
  const rot = (ring: Pt[], deg: number): Pt[] => {
    const a = (deg * Math.PI) / 180;
    // bearing of an ENU vector (e, n) is atan2(e, n): rotating clockwise by deg adds deg to bearings
    return ring.map(([e, n]) => [e * Math.cos(a) + n * Math.sin(a), -e * Math.sin(a) + n * Math.cos(a)]);
  };
  it('finds the axis of a rotated rectangle modulo 90', () => {
    for (const d of [0, 12.5, 31, 44, 60, 88]) {
      const b = dominantBearing(rot(sq(0, 0, 30, 10), d));
      const diff = Math.abs(((b - d) % 90 + 135) % 90 - 45);
      expect(diff).toBeLessThan(1e-6);
    }
  });
  it('ignores a small chamfer', () => {
    const ring: Pt[] = [[0, 0], [30, 0], [30, 8], [28, 10], [0, 10]];
    expect(dominantBearing(ring)).toBeCloseTo(90 % 90, 0);
  });
});

describe('anchorOrigin', () => {
  const box = { minX: 100, maxX: 130, minY: 50, maxY: 70 };
  it('nw honours a non-zero envelope origin', () => {
    expect(anchorOrigin(box, 'nw', 0.2, { minX: 0, maxX: 8, minY: 0, maxY: 6 })).toEqual([100.2, 50.2]);
    const [ox, oy] = anchorOrigin(box, 'nw', 0.2, { minX: 1.5, maxX: 9, minY: -2, maxY: 6 });
    expect(ox).toBeCloseTo(100.2 - 1.5, 9);
    expect(oy).toBeCloseTo(50.2 + 2, 9);
    // the outer corner of the flat (envelope.min - inset) lands on the box corner
    expect(ox + 1.5 - 0.2).toBeCloseTo(box.minX, 9);
    expect(oy - 2 - 0.2).toBeCloseTo(box.minY, 9);
  });
  it('se pins the max corner', () => {
    const env = { minX: 1, maxX: 9, minY: 2, maxY: 8 };
    const [ox, oy] = anchorOrigin(box, 'se', 0.2, env);
    expect(ox + env.maxX + 0.2).toBeCloseTo(box.maxX, 9);
    expect(oy + env.maxY + 0.2).toBeCloseTo(box.maxY, 9);
  });
});

describe('hostBands', () => {
  const flatCut = { minX: 4, maxX: 6, minY: 4, maxY: 6 };
  const common = { id: 'H', footprint: sq(0, 0, 10, 10), storeyBase: -0.05, storeyTop: 2.8, flatCut };
  const zod = (buildings: ContextBuildingLike[]) =>
    SiteContext.parse({ version: 1, source: 't', origin: { latitude: 1, longitude: 2 }, northAngle: 0, buildings });

  it('upper floor: below + storey pieces + above, every band positive and valid', () => {
    const bands = hostBands({ ...common, base: -5.8, height: 18.3 });
    expect(bands.map((b) => b.id.split(':')[1]!.replace(/-\d$/, ''))).toEqual(['below', 'flat-storey', 'flat-storey', 'flat-storey', 'flat-storey', 'above']);
    expect(bands[0]).toMatchObject({ base: -5.8 });
    expect(bands[0]!.height).toBeCloseTo(5.75, 9);
    expect(bands.every((b) => b.height > 0 && b.host)).toBe(true);
    zod(bands);
  });
  it('ground-floor flat (base 0): no :below band, no negative height, storey starts at the ground', () => {
    const bands = hostBands({ ...common, base: 0, height: 12 });
    expect(bands.some((b) => b.id.endsWith(':below'))).toBe(false);
    expect(bands.every((b) => b.height > 0)).toBe(true);
    const storey = bands.filter((b) => b.id.includes('flat-storey'));
    expect(storey.every((b) => b.base === 0 && Math.abs(b.base + b.height - 2.8) < 1e-9)).toBe(true);
    zod(bands);
  });
  it('a host barely taller than the storey has no :above band', () => {
    expect(hostBands({ ...common, base: 0, height: 2.85 }).some((b) => b.id.endsWith(':above'))).toBe(false);
  });
  it('keeps courtyards on the bands they lie inside and drops those touching the cut-away', () => {
    const court: Pt[] = sq(1, 1, 2, 2);
    const bands = hostBands({ ...common, base: 0, height: 12, holes: [court, sq(3.5, 3.5, 4.5, 4.5)] });
    const above = bands.find((b) => b.id.endsWith(':above'))!;
    expect(above.holes).toHaveLength(2);
    const withCourt = bands.filter((b) => b.id.includes('flat-storey') && b.holes);
    expect(withCourt).toHaveLength(1);
    expect(withCourt[0]!.holes).toEqual([court]);
    zod(bands);
  });
});

describe('extractRings', () => {
  it('skips null geometry, splits multipolygons and keeps inner rings', () => {
    const ring = (x: number) => [[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]];
    const { rings, skipped } = extractRings({
      features: [
        { id: 'a', properties: { cleabs: 'A' }, geometry: null },
        { id: 'b', properties: { cleabs: 'B' }, geometry: { type: 'Polygon', coordinates: [ring(0), ring(0.2).map(([x, y]) => [x! * 0.3, y! * 0.3])] } },
        { id: 'c', properties: { cleabs: 'C' }, geometry: { type: 'MultiPolygon', coordinates: [[ring(5)], [ring(8)]] } },
        { id: 'd', geometry: { type: 'Point', coordinates: [0, 0] } },
      ],
    });
    expect(skipped).toEqual(['a', 'd']);
    expect(rings.map((r) => [r.key, r.part, r.holes.length])).toEqual([['B', null, 1], ['C', 0, 0], ['C', 1, 0]]);
  });
});

describe('validateContext', () => {
  const ok = {
    version: 1,
    source: 's',
    origin: { latitude: 1, longitude: 2 },
    northAngle: 3,
    buildings: [{ id: 'a', footprint: sq(0, 0, 1, 1), base: 0, height: 1, host: false }],
  };
  it('accepts a valid context and agrees with the zod schema on invalid ones', () => {
    expect(validateContext(ok)).toEqual([]);
    expect(SiteContext.safeParse(ok).success).toBe(true);
    const bad = [
      { ...ok, version: 2 },
      { ...ok, buildings: [{ ...ok.buildings[0], height: -0.05 }] },
      { ...ok, buildings: [{ ...ok.buildings[0], footprint: [[0, 0], [1, 1]] }] },
      { ...ok, buildings: [{ ...ok.buildings[0], holes: [[[0, 0]]] }] },
      { ...ok, buildings: [{ ...ok.buildings[0], extra: 1 }] },
      { ...ok, origin: { latitude: 'x', longitude: 2 } },
    ];
    for (const b of bad) {
      expect(validateContext(b).length).toBeGreaterThan(0);
      expect(SiteContext.safeParse(b).success).toBe(false);
    }
  });
});

describe('auto-fit to the host footprint', () => {
  const box = { id: 'h', footprint: sq(0, 0, 20, 12), base: -3, height: 9, host: true };
  const tinyFlat: FlatLike = {
    rooms: [{ type: 'living', polygon: sq(0, 0, 4, 3) }, { type: 'balcony', polygon: sq(-1.2, 0, 0, 3) }],
    walls: [
      { id: 'w-north', start: [-1.2, -0.1], end: [4.1, -0.1], thickness: 0.2 },
      { id: 'w-west', start: [-0.1, 3.1], end: [-0.1, -0.1], thickness: 0.2 },
      { id: 'w-south', start: [-0.1, 3.1], end: [4.1, 3.1], thickness: 0.2 },
      { id: 'w-east', start: [4.1, -0.1], end: [4.1, 3.1], thickness: 0.2 },
    ],
  };

  it('samples the envelope without the balcony', () => {
    const { points, cell } = envelopeSamples(tinyFlat, 0.05);
    expect(points.length * cell * cell).toBeCloseTo(4.4 * 3.4, 0);
    expect(Math.min(...points.map((p) => p[0]))).toBeGreaterThan(-0.2);
  });

  it('pulls a flat that sticks out of the footprint back in, ignoring the balcony', () => {
    // The flat's NW corner sticks out by (-0.8, -0.5) metres; the balcony may project.
    const rings = [box.footprint];
    const moved = (p: Pt): Pt => [p[0] - 0.8, p[1] - 0.5];
    const before = overhang(envelopeSamples(tinyFlat, 0.05), rings, moved).area;
    expect(before).toBeGreaterThan(1.5);
    const fit = fitFlatToFootprint(
      {
        rooms: tinyFlat.rooms!.map((r) => ({ ...r, polygon: r.polygon.map(moved) })),
        walls: tinyFlat.walls!.map((w) => ({ ...w, start: moved(w.start), end: moved(w.end) })),
      },
      rings,
      {},
    );
    expect(fit.before.area).toBeGreaterThan(1.5);
    expect(fit.after.area).toBeLessThan(0.05);
    expect(Math.abs(fit.thetaDeg)).toBeLessThanOrEqual(3 + 1e-6);
    expect(fit.after.north!.mid).toBeLessThan(0.3);
  }, 60_000);

  it('refitContext applies the inverse transform and keeps the context valid', () => {
    const ctx = { version: 1 as const, source: 's', origin: { latitude: 48.8, longitude: 2.3 }, northAngle: 358.5, buildings: [{ ...box, host: false }, { ...box, id: 'x', host: false, footprint: sq(30, 0, 40, 5) }] };
    const out = refitContext(ctx, { dx: 2, dy: 1, thetaDeg: 2 }, { flatCut: { minX: -1, maxX: 5, minY: -1, maxY: 4 }, storeyTop: 2.8 });
    expect(out.northAngle).toBeCloseTo(356.5, 6);
    // The flat's old origin (0,0) moved to (2,1); a context point q is now R(-2deg)(q - t).
    const t = (2 * Math.PI) / 180;
    const q = ctx.buildings[1]!.footprint[0]!;
    const e = out.buildings[1]!.footprint[0]!;
    expect(e[0]).toBeCloseTo((q[0] - 2) * Math.cos(t) + (q[1] - 1) * Math.sin(t), 2);
    expect(e[1]).toBeCloseTo(-(q[0] - 2) * Math.sin(t) + (q[1] - 1) * Math.cos(t), 2);
    expect(out.origin.latitude).not.toBe(ctx.origin.latitude);
    expect(SiteContext.safeParse(out).success).toBe(true);
  });

  describe('committed Charme 3205 fixtures', () => {
    const flat = charmeFlat as unknown as Parameters<typeof envelopeSamples>[0];
    it('keep the non-balcony envelope inside the host footprint', () => {
      const result = overhang(envelopeSamples(flat, 0.025), hostRings(charmeContext as never), (p) => p, true);
      // Before the fit this was 17.5 m2 (max 3.2 m) because of the chamfered NW corner; the rest is sampling noise.
      expect(result.area).toBeLessThanOrEqual(0.2);
      expect(result.maxDistance).toBeLessThanOrEqual(0.5);
    });
    it('stay within 3 degrees of the original northAngle and consistent with each other', () => {
      expect(Math.abs(charmeFlat.site.northAngle - 358.5)).toBeLessThanOrEqual(3 + 1e-3);
      expect(charmeContext.northAngle).toBe(charmeFlat.site.northAngle);
      expect(SiteContext.safeParse(charmeContext).success).toBe(true);
      expect(validateContext(charmeContext)).toEqual([]);
      expect(Math.hypot(charmeContext.origin.latitude - charmeFlat.site.latitude, charmeContext.origin.longitude - charmeFlat.site.longitude)).toBeLessThan(1e-6);
    });
  });
});
