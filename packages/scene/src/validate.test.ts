import { describe, expect, it } from 'vitest';
import charme from '../fixtures/charme-3205.flat.json';
import sample from '../fixtures/sample.flat.json';
import { parseScene } from './parse';
import type { Scene } from './schema';
import { polygonOverlapArea, pointInPolygon, validateScene } from './validate';

function load(input: unknown): Scene {
  const r = parseScene(input);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.scene;
}
const clone = <T>(v: T): T => structuredClone(v);
const codes = (scene: Scene) => validateScene(scene).warnings.map((w) => w.code);

/** Minimal 4 x 3 room with four 0.2 m walls (centrelines on the polygon offset by 0.1). */
function room(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    name: 't',
    site: { latitude: 0, longitude: 0 },
    walls: [
      { id: 'n', start: [0, 0], end: [4.2, 0], thickness: 0.2 },
      { id: 'e', start: [4.2, 0], end: [4.2, 3.2], thickness: 0.2 },
      { id: 's', start: [4.2, 3.2], end: [0, 3.2], thickness: 0.2 },
      { id: 'w', start: [0, 3.2], end: [0, 0], thickness: 0.2 },
    ],
    rooms: [{ id: 'r', name: 'R', type: 'living', polygon: [[0.1, 0.1], [4.1, 0.1], [4.1, 3.1], [0.1, 3.1]] }],
    ...extra,
  };
}

describe('validateScene on fixtures', () => {
  it('Charme 3205 is clean: every room edge is backed, no overlaps, lights inside, no openings near junctions (bar the placard of Chambre 2)', () => {
    // The closet of Chambre 2 is in the wall thickness and opens onto the Entrée: Chambre 2 keeps its polygon (the official
    // area includes the closet) and neither room has a wall along the closet doors. That is the only thing reported.
    expect(validateScene(load(charme)).warnings.map((w) => [w.code, ...w.entityIds])).toEqual([
      ['room-edge-unwalled', 'ch2'],
      ['room-edge-unwalled', 'entree'],
    ]);
  });

  it('sample flat: doors flush against the bathroom wall T-junction and two open-plan edges', () => {
    const w = validateScene(load(sample)).warnings;
    expect(w.map((x) => [x.code, x.entityIds[0]])).toEqual([
      ['opening-near-junction', 'door-bed1'],
      ['opening-near-junction', 'door-bed2'],
      ['room-edge-unwalled', 'hall'],
      ['room-edge-unwalled', 'living'],
    ]);
  });

  it('catches problems injected into Charme', () => {
    const bad = clone(charme) as any;
    bad.openings.find((o: any) => o.id === 'door-alcove').offset = 0.42; // 2 cm from the wall end
    bad.lights.push({ id: 'l-out', type: 'point', position: [30, 30], elevation: 2, lumens: 100 });
    bad.lights.push({ id: 'l-hi', type: 'point', position: [2, 1], elevation: 3, lumens: 100, roomId: 'alcove' });
    bad.walls = bad.walls.filter((w: any) => w.id !== 'w-ch2-ch1');
    const w = validateScene(load(bad)).warnings;
    const found = new Set(w.map((x) => x.code));
    expect(found).toContain('opening-near-junction');
    expect(found).toContain('light-outside-rooms');
    expect(found).toContain('light-above-ceiling');
    expect(found).toContain('room-edge-unwalled');
  });
});

describe('opening-near-junction', () => {
  const withOpening = (offset: number, width = 0.8) =>
    load(room({ openings: [{ id: 'd', wallId: 'n', type: 'door', offset, width, height: 2 }] }));

  it('is silent for a well-placed opening', () => {
    expect(codes(withOpening(2))).toEqual([]);
  });
  it('warns within half a thickness of a wall end', () => {
    // wall n is 4.2 long; opening 0.4..1.2 leaves 0.4 m, fine; 0.45..1.25 -> still fine; shift to 0.05 gap
    const w = validateScene(withOpening(0.45)).warnings;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'opening-near-junction', entityIds: ['d', 'n'], path: 'openings[0]' });
  });
  it('warns when an opening sits flush against the far end', () => {
    expect(codes(withOpening(3.8))).toEqual(['opening-near-junction']);
  });
  it('warns near a T-junction on the wall', () => {
    const scene = load({
      ...room(),
      walls: [
        { id: 'n', start: [0, 0], end: [4.2, 0], thickness: 0.2 },
        { id: 'p', start: [2, 0], end: [2, 3], thickness: 0.1 },
      ],
      rooms: [],
      openings: [{ id: 'd', wallId: 'n', type: 'door', offset: 2.5, width: 0.8, height: 2 }],
    });
    expect(codes(scene)).toContain('opening-near-junction');
  });
});

describe('rooms', () => {
  it('flags an edge with no wall', () => {
    const scene = load(room({ walls: [{ id: 'n', start: [0, 0], end: [4.2, 0], thickness: 0.2 }] }));
    const w = validateScene(scene).warnings.filter((x) => x.code === 'room-edge-unwalled');
    expect(w.map((x) => x.path)).toEqual(['rooms[0].polygon[1]', 'rooms[0].polygon[2]', 'rooms[0].polygon[3]']);
  });

  it('flags overlapping rooms but not touching rooms', () => {
    const base = room() as any;
    const second = (polygon: number[][]) => load({ ...base, rooms: [...base.rooms, { id: 'r2', name: 'R2', type: 'office', polygon }] });
    const overlapping = validateScene(second([[3, 1], [6, 1], [6, 2], [3, 2]])).warnings.filter((w) => w.code === 'rooms-overlap');
    expect(overlapping).toHaveLength(1);
    expect(overlapping[0]!.entityIds).toEqual(['r', 'r2']);
    expect(overlapping[0]!.message).toContain('1.10 m²'); // x 3..4.1, y 1..2
    const touching = validateScene(second([[4.1, 0.1], [6, 0.1], [6, 3.1], [4.1, 3.1]])).warnings;
    expect(touching.some((w) => w.code === 'rooms-overlap')).toBe(false);
  });
});

describe('polygonOverlapArea', () => {
  const L: [number, number][] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
  it('is exact for concave and mixed-winding polygons', () => {
    const square: [number, number][] = [[1, 1], [3, 1], [3, 3], [1, 3]];
    // L covers (1..3,1..2) fully (area 2) and (1..2, 2..3) (area 1) of the square.
    expect(polygonOverlapArea(L, square)).toBeCloseTo(3, 9);
    expect(polygonOverlapArea([...L].reverse(), square)).toBeCloseTo(3, 9);
    expect(polygonOverlapArea(square, [...L].reverse())).toBeCloseTo(3, 9);
  });
  it('is zero for disjoint polygons', () => {
    expect(polygonOverlapArea(L, [[5, 5], [6, 5], [6, 6]])).toBe(0);
  });
  it('a polygon fully overlaps itself', () => {
    expect(polygonOverlapArea(L, L)).toBeCloseTo(12, 9);
  });
});

describe('pointInPolygon', () => {
  const sq: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
  it('handles inside, outside and boundary', () => {
    expect(pointInPolygon([1, 1], sq)).toBe(true);
    expect(pointInPolygon([3, 1], sq)).toBe(false);
    expect(pointInPolygon([2, 1], sq)).toBe(true);
  });
});

describe('lights', () => {
  const lamp = (over: Record<string, unknown>) => ({ id: 'l', type: 'point', position: [2, 1.5], elevation: 2, lumens: 800, ...over });
  it('is silent for a lamp inside its room below the ceiling', () => {
    expect(codes(load(room({ lights: [lamp({ roomId: 'r' })] })))).toEqual([]);
  });
  it('warns outside every room', () => {
    expect(codes(load(room({ lights: [lamp({ position: [9, 9], roomId: undefined })] })))).toEqual(['light-outside-rooms']);
  });
  it('warns above the ceiling (default 2.6 m from the walls)', () => {
    expect(codes(load(room({ lights: [lamp({ elevation: 2.7 })] })))).toEqual(['light-above-ceiling']);
  });
  it('warns when the declared room does not contain the lamp', () => {
    const scene = load(
      room({
        rooms: [
          { id: 'r', name: 'R', type: 'living', polygon: [[0.1, 0.1], [2, 0.1], [2, 3.1], [0.1, 3.1]] },
          { id: 'q', name: 'Q', type: 'living', polygon: [[2, 0.1], [4.1, 0.1], [4.1, 3.1], [2, 3.1]] },
        ],
        lights: [lamp({ position: [3, 1], roomId: 'r' })],
      }),
    );
    expect(codes(scene)).toContain('light-room-mismatch');
  });
});

describe('coordinates', () => {
  it('warns beyond +-1000 m', () => {
    const scene = load(room({ walls: [{ id: 'far', start: [0, 0], end: [4000, 0] }], rooms: [] }));
    const w = validateScene(scene).warnings;
    expect(w).toEqual([expect.objectContaining({ code: 'coordinates-out-of-range', entityIds: ['far'], path: 'walls[0]' })]);
  });
});

describe('validateScene layout warnings', () => {
  const item = (id: string, over: Record<string, unknown> = {}) => ({ id, assetId: 'param:t', position: [7.5, 1], dims: { w: 0.5, d: 0.5, h: 0.5 }, roomId: 'ch1', ...over });
  const withItems = (items: unknown[]) => {
    const c = clone(charme) as { items: unknown[] };
    c.items = items;
    return load(c);
  };

  it('reports overlap, items outside rooms and tall items under windows with layout_* codes', () => {
    const w = validateScene(withItems([item('a'), item('b', { position: [7.6, 1] }), item('c', { position: [30, 30], roomId: 'ch1' }), item('d', { position: [9.29, 0.3], dims: { w: 0.8, d: 0.5, h: 2 } })])).warnings;
    const layout = w.filter((x) => x.code.startsWith('layout_')).map((x) => [x.code, x.entityIds[0]]);
    expect(layout).toEqual(expect.arrayContaining([['layout_overlap', 'b'], ['layout_outside_room', 'c'], ['layout_window_blocked', 'd']]));
    expect(w.find((x) => x.code === 'layout_overlap')!.path).toBe('items[1]');
  });

  it('is quiet for a well placed item and for locked furniture', () => {
    expect(validateScene(withItems([item('a')])).warnings.filter((x) => x.code.startsWith('layout_'))).toEqual([]);
    expect(validateScene(withItems([item('p', { position: [30, 30], locked: true })])).warnings.filter((x) => x.code.startsWith('layout_'))).toEqual([]);
  });
});
