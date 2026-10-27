import { describe, expect, it } from 'vitest';
import charme from '../../fixtures/charme-3205.flat.json';
import charmeContext from '../../fixtures/charme-3205.context.json';
import { SiteContext } from '../context/schema';
import { Scene } from '../schema';
import { sunAtInstant, sunDirection } from './sun';
import { sunPatches, sunlightHours } from './sunpatch';

const site = { latitude: 48.8566, longitude: 2.3522, northAngle: 0, timezone: 'Europe/Paris', floorElevation: 0 };

/** 6 x 5 m room with a 2 m wide window (sill 0.8, head 2.2) in its south (plan y = 5) or north wall. */
function box(windowWall: 's' | 'n' = 's', extraOpenings: object[] = []): Scene {
  return Scene.parse({
    version: 1,
    name: 'box',
    site,
    walls: [
      { id: 'n', start: [0, 0], end: [6, 0], thickness: 0.2 },
      { id: 's', start: [6, 5], end: [0, 5], thickness: 0.2 },
      { id: 'w', start: [0, 5], end: [0, 0], thickness: 0.2 },
      { id: 'e', start: [6, 0], end: [6, 5], thickness: 0.2 },
    ],
    openings: [
      { id: 'win', wallId: windowWall, type: 'window', offset: 3, width: 2, height: 1.4, sill: 0.8 },
      ...extraOpenings,
    ],
    rooms: [{ id: 'r', name: 'R', type: 'living', polygon: [[0.1, 0.1], [5.9, 0.1], [5.9, 4.9], [0.1, 4.9]] }],
  });
}

const south = (alt: number) => sunDirection(180, alt, 0);
const bbox = (p: [number, number][]) => ({
  minY: Math.min(...p.map((v) => v[1])),
  maxY: Math.max(...p.map((v) => v[1])),
  minX: Math.min(...p.map((v) => v[0])),
  maxX: Math.max(...p.map((v) => v[0])),
});

describe('sunPatches', () => {
  const scene = box('s');
  it('south window at 64.6 deg: far edge ~1.04 m from the wall', () => {
    const patches = sunPatches(scene, south(64.6));
    expect(patches).toHaveLength(1);
    const p = patches[0]!;
    expect(p.openingId).toBe('win');
    expect(p.roomId).toBe('r');
    const b = bbox(p.polygon);
    expect(5 - b.minY).toBeCloseTo(2.2 / Math.tan((64.6 * Math.PI) / 180), 3);
    expect(5 - b.minY).toBeCloseTo(1.04, 1);
    expect(b.minX).toBeCloseTo(2, 6);
    expect(b.maxX).toBeCloseTo(4, 6);
    // 2 m wide x (1.4 / tan) deep
    expect(p.area).toBeCloseTo(2 * (1.4 / Math.tan((64.6 * Math.PI) / 180)), 6);
  });
  it('south window at 17.7 deg: 6.9 m deep, clipped to the room', () => {
    const p = sunPatches(scene, south(17.7))[0]!;
    expect(5 - 2.2 / Math.tan((17.7 * Math.PI) / 180)).toBeLessThan(-1.8); // unclipped depth ~ 6.9 m
    const b = bbox(p.polygon);
    expect(b.minY).toBeCloseTo(0.1, 6); // clipped at the far (north) wall face
    expect(b.maxY).toBeCloseTo(5 - 0.8 / Math.tan((17.7 * Math.PI) / 180), 3);
    expect(p.area).toBeCloseTo(2 * (b.maxY - 0.1), 6);
  });
  it('the patch shifts sideways for a sun off the wall normal', () => {
    const b = bbox(sunPatches(scene, sunDirection(180 + 45, 30, 0))[0]!.polygon); // south-west sun
    // sun in the south-west: light travels north-east, so the patch is displaced towards +x
    expect(b.minX).toBeGreaterThan(2.5);
    expect(b.maxX).toBeGreaterThan(4.5);
  });
  it('north window with a southern sun: nothing', () => {
    expect(sunPatches(box('n'), south(40))).toEqual([]);
  });
  it('north window with a northern sun lights the floor', () => {
    const p = sunPatches(box('n'), sunDirection(0, 50, 0));
    expect(p).toHaveLength(1);
    expect(p[0]!.area).toBeGreaterThan(0.5);
  });
  it('sun below the horizon or at the horizon: nothing', () => {
    expect(sunPatches(scene, south(-5))).toEqual([]);
    expect(sunPatches(scene, south(0))).toEqual([]);
  });
  it('grazing sun along the wall: nothing', () => {
    expect(sunPatches(scene, sunDirection(90, 30, 0))).toEqual([]);
  });
  it('northAngle rotates the world direction consistently', () => {
    // Rotate the plan 90 degrees: the south wall of the flat now faces plan-left, so the same
    // geometry would need a different wall. Instead check the south window stays dark when the
    // sun is at plan-north (compass south with northAngle 180).
    expect(sunPatches(scene, sunDirection(180, 40, 180))).toEqual([]);
    expect(sunPatches(scene, sunDirection(0, 40, 180))).toHaveLength(1);
  });
  it('unglazed doors and passages give nothing; glazed doors do', () => {
    const door = { wallId: 's', type: 'door', offset: 1, width: 0.8, height: 2.0 };
    const withDoors = box('s', [
      { id: 'd1', ...door },
      { id: 'p1', ...door, type: 'passage', offset: 5 },
    ]);
    expect(sunPatches(withDoors, south(40)).map((p) => p.openingId)).toEqual(['win']);
    const glazed = box('s', [{ id: 'd2', ...door, glazed: true }]);
    expect(sunPatches(glazed, south(40)).map((p) => p.openingId).sort()).toEqual(['d2', 'win']);
  });
  it('glazed openings in interior walls (sun side is a room) let nothing through', () => {
    const two = Scene.parse({
      version: 1,
      name: 'two',
      site,
      walls: [
        { id: 'a', start: [0, 0], end: [4, 0] },
        { id: 'mid', start: [4, 0], end: [4, 5], thickness: 0.1 },
        { id: 'b', start: [8, 0], end: [4, 0] },
      ],
      openings: [{ id: 'gd', wallId: 'mid', type: 'door', glazed: true, offset: 2.5, width: 1, height: 2, sill: 0 }],
      rooms: [
        { id: 'L', name: 'L', type: 'living', polygon: [[0, 0.1], [3.95, 0.1], [3.95, 4.9], [0, 4.9]] },
        { id: 'R', name: 'R', type: 'bedroom', polygon: [[4.05, 0.1], [8, 0.1], [8, 4.9], [4.05, 4.9]] },
      ],
    });
    expect(sunPatches(two, sunDirection(90, 30, 0))).toEqual([]);
    expect(sunPatches(two, sunDirection(270, 30, 0))).toEqual([]);
  });
  it('clips to concave rooms and never outside them', () => {
    // L-shaped room (notch at x > 4, y < 3), window in the south wall over x in [4.5, 6.5]; a low
    // sun throws the patch far to the north, where the notch is not part of the room.
    const l = Scene.parse({
      version: 1,
      name: 'L',
      site,
      walls: [{ id: 's', start: [8, 6], end: [0, 6], thickness: 0.2 }],
      openings: [{ id: 'win', wallId: 's', type: 'window', offset: 2.5, width: 2, height: 1.4, sill: 0.8 }],
      rooms: [
        {
          id: 'L',
          name: 'L',
          type: 'living',
          polygon: [[0, 0], [4, 0], [4, 3], [8, 3], [8, 5.9], [0, 5.9]],
        },
      ],
    });
    const patches = sunPatches(l, south(20));
    expect(patches.length).toBeGreaterThan(0);
    for (const p of patches) {
      for (const [x, y] of p.polygon) {
        expect(y).toBeGreaterThanOrEqual(3 - 1e-9); // the notch above y = 3 is outside the room
        expect(x).toBeGreaterThanOrEqual(4.5 - 1e-9);
        expect(x).toBeLessThanOrEqual(6.5 + 1e-9);
      }
    }
    const total = patches.reduce((s, p) => s + p.area, 0);
    expect(total).toBeCloseTo(2 * (6 - 0.8 / Math.tan((20 * Math.PI) / 180) - 3), 6);
  });
});

describe('sunlightHours', () => {
  it('counts the sunny hours of the box (south window, 21 Jun)', () => {
    const h = sunlightHours(box('s'), '2026-06-21');
    expect(h.r).toBeGreaterThan(5);
    expect(h.r).toBeLessThan(10);
    expect(sunlightHours(box('s'), '2026-06-21', 5).r).toBeCloseTo(h.r!, 0);
  });
  it('is zero for every room at a missing-window scene', () => {
    expect(sunlightHours(box('n'), '2026-12-21').r).toBe(0);
  });
  it('rejects a bad step', () => {
    expect(() => sunlightHours(box('s'), '2026-06-21', 0)).toThrow(RangeError);
  });
});

describe('Charme 3205 sunlight hours (northAngle 355.5)', () => {
  const scene = Scene.parse(charme);
  const hours = (d: string) => sunlightHours(scene, d);
  const dec = hours('2026-12-21');
  const mar = hours('2026-03-21');
  const jun = hours('2026-06-21');

  it('lists every room', () => {
    expect(Object.keys(dec).sort()).toEqual(scene.rooms.map((r) => r.id).sort());
  });
  it('north bedrooms and alcove get no direct sun in December', () => {
    for (const id of ['ch1', 'ch2', 'alcove']) expect(dec[id]).toBe(0);
  });
  it('rooms without exterior glazing stay dark all year', () => {
    for (const id of ['entree', 'wc', 'sdb', 'balcon']) {
      expect(dec[id]).toBe(0);
      expect(jun[id]).toBe(0);
    }
  });
  it('the west-facing living room gets afternoon sun, no morning-only sun', () => {
    expect(dec.sejour).toBeGreaterThan(2);
    expect(mar.sejour).toBeGreaterThan(3);
    expect(jun.sejour).toBeGreaterThan(4);
  });
  it('north rooms only get a little low summer sun (NE/NW) around the solstice', () => {
    for (const id of ['ch1', 'ch2', 'alcove']) {
      expect(jun[id]).toBeGreaterThan(0);
      expect(jun[id]).toBeLessThan(5);
      expect(mar[id]).toBeLessThan(0.5);
    }
  });
  it('the living room is only lit once the sun is in the western half', () => {
    // 21 Jun 07:00 CEST: sun in the north-east -> nothing in the living room
    const morning = new Date('2026-06-21T05:00:00Z');
    expect(morning.getTime()).toBeGreaterThan(0);
    const sun = dir(morning);
    expect(sunPatches(scene, sun).some((p) => p.roomId === 'sejour')).toBe(false);
    const evening = dir(new Date('2026-06-21T16:00:00Z')); // 18:00 CEST, sun in the west
    expect(sunPatches(scene, evening).some((p) => p.roomId === 'sejour')).toBe(true);
  });
});

describe('balconies never receive sun patches', () => {
  it('a glazed opening into a balcony room reports nothing', () => {
    const b = box('s');
    const balcony = Scene.parse({ ...b, rooms: [{ ...b.rooms[0]!, type: 'balcony' }] });
    expect(sunPatches(box('s'), south(40))).toHaveLength(1);
    expect(sunPatches(balcony, south(40))).toEqual([]);
    expect(Object.values(sunlightHours(balcony, '2026-06-21')).every((h) => h === 0)).toBe(true);
  });
});

describe('sunPatches with site context', () => {
  const scene = box('s');
  const wallOf = (id: string, y0: number, y1: number, height: number, host = false, base = 0, holes?: [number, number][][]) => ({
    id,
    footprint: [[-500, y0], [500, y0], [500, y1], [-500, y1]] as [number, number][],
    ...(holes ? { holes } : {}),
    base,
    height,
    host,
  });
  const ctx = (buildings: ReturnType<typeof wallOf>[]) =>
    SiteContext.parse({ version: 1, source: 't', origin: { latitude: 48.8, longitude: 2.3 }, northAngle: 0, buildings });
  const alt = 64.6;

  it('is identical without context, with an empty context, or with a building that is not in the way', () => {
    const base = sunPatches(scene, south(alt));
    expect(sunPatches(scene, south(alt), ctx([]))).toEqual(base);
    expect(sunPatches(scene, south(alt), ctx([wallOf('north', -12, -8, 30)]))).toEqual(base);
  });
  it('a tall building to the south blocks the window completely', () => {
    expect(sunPatches(scene, south(alt), ctx([wallOf('s', 8, 12, 30)]))).toEqual([]);
    // Only grazing sun (azimuth ~90 deg, ray travelling > 500 m before it reaches the building) gets through.
    const open = sunlightHours(scene, '2026-06-21')['r']!;
    const blocked = sunlightHours(scene, '2026-06-21', 10, ctx([wallOf('s', 8, 12, 30)]))['r']!;
    expect(open).toBeGreaterThan(3);
    expect(blocked).toBeLessThan(0.5);
  });
  it('a lower building blocks only the lower rows of the glass: the patch keeps the free cells', () => {
    const full = sunPatches(scene, south(alt))[0]!;
    const partial = sunPatches(scene, south(alt), ctx([wallOf('s', 8, 12, 7.6)]));
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.every((p) => p.openingId === 'win' && p.roomId === 'r')).toBe(true);
    const area = partial.reduce((a, p) => a + p.area, 0);
    expect(area).toBeCloseTo((full.area * 2) / 3, 6); // the 2 upper rows of 3 are free
    // The lit cells are the upper ones, i.e. the far part of the full patch.
    expect(Math.max(...partial.flatMap((p) => p.polygon.map((v) => 5 - v[1])))).toBeCloseTo(5 - Math.min(...full.polygon.map((v) => v[1])), 6);
  });
  it('a hole (courtyard) lets light through where the ray stays inside it', () => {
    // A slab (base 3, 1 m thick) south of the window: the ray crosses its height range at 5.5-6.4 m.
    const slab = (holes?: [number, number][][]) =>
      ctx([{ id: 'slab', footprint: [[-20, 5.2], [30, 5.2], [30, 12], [-20, 12]], ...(holes ? { holes } : {}), base: 3, height: 1, host: false }]);
    expect(sunPatches(scene, south(alt), slab())).toEqual([]);
    const withHole = slab([[[-10, 5.3], [20, 5.3], [20, 11], [-10, 11]]]);
    expect(sunPatches(scene, south(alt), withHole)).toEqual(sunPatches(scene, south(alt)));
  });
  it('host bands: the flat storey cut-away does not block, the band above the flat does', () => {
    const storey = wallOf('h:flat-storey-0', 5.05, 12, 3.15, true, -0.05);
    expect(sunPatches(scene, south(alt), ctx([storey]))).toEqual(sunPatches(scene, south(alt)));
    const above = wallOf('h:above', 5.05, 12, 12, true, 2.8);
    expect(sunPatches(scene, south(alt), ctx([storey, above]))).toEqual([]);
  });
});

describe('Charme 3205 sunlight hours with the neighbouring buildings', () => {
  const scene = Scene.parse(charme);
  const context = SiteContext.parse(charmeContext);
  const withCtx = (d: string) => sunlightHours(scene, d, 10, context);
  const without = (d: string) => sunlightHours(scene, d);
  const round = (h: Record<string, number>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Math.round(v * 100) / 100]));

  it('matches the reference table in docs/photometry.md', () => {
    expect(round(without('2026-03-21'))).toMatchObject({ sejour: 5.5, alcove: 0, ch1: 0, ch2: 0 });
    expect(round(without('2026-06-21'))).toMatchObject({ sejour: 7.5, alcove: 3.33, ch2: 2.17, ch1: 2.5 });
    expect(round(without('2026-12-21'))).toMatchObject({ sejour: 3.33, alcove: 0, ch1: 0, ch2: 0 });
    expect(round(withCtx('2026-03-21'))).toMatchObject({ sejour: 3.5, alcove: 0, ch1: 0, ch2: 0 });
    expect(round(withCtx('2026-06-21'))).toMatchObject({ sejour: 6.17, alcove: 3.33, ch2: 2, ch1: 2 });
    expect(round(withCtx('2026-12-21'))).toMatchObject({ sejour: 0.5, alcove: 0, ch1: 0, ch2: 0 });
  });
  it('context never adds sun, and the host cut-away does not block the flat itself', () => {
    for (const d of ['2026-03-21', '2026-06-21', '2026-12-21']) {
      const a = without(d);
      const b = withCtx(d);
      for (const id of Object.keys(a)) expect(b[id]!).toBeLessThanOrEqual(a[id]! + 1e-9);
    }
    expect(withCtx('2026-06-21')['sejour']).toBeGreaterThan(5);
  });
});

function dir(t: Date) {
  return sunAtInstant(
    { latitude: 48.7893, longitude: 2.3038, northAngle: 0, timezone: 'Europe/Paris', floorElevation: 5.8 },
    t,
  ).direction;
}
