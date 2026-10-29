import { describe, expect, it } from 'vitest';
import type { Scene } from '@flat/scene';
import { LEVELS, bakeRuns, buildVisibility, keyOf, probeCount, probeIndex, probeIndoor, probeLayout, probePosition, probeValidity, segmentHitsSolid, visibilitySize, wallSolids } from './probe-grid';

type Plan = Pick<Scene, 'walls' | 'rooms' | 'openings'>;

/** Two 4 x 4 m rooms side by side, a 7 cm partition between them at x = 4, with an optional doorway in it. */
function twoRooms(door = false): Plan {
  const wall = (id: string, a: [number, number], b: [number, number], thickness = 0.2) => ({ id, start: a, end: b, thickness, height: 2.5, finish: {} });
  return {
    walls: [wall('n', [0, 0], [8, 0]), wall('s', [0, 4], [8, 4]), wall('w', [0, 0], [0, 4]), wall('e', [8, 0], [8, 4]), wall('mid', [4, 0], [4, 4], 0.07)],
    rooms: [
      { id: 'a', name: 'A', type: 'living', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
      { id: 'b', name: 'B', type: 'bedroom', polygon: [[4, 0], [8, 0], [8, 4], [4, 4]] },
    ],
    openings: door ? [{ id: 'd', wallId: 'mid', type: 'door', offset: 2, width: 0.9, height: 2.1, sill: 0 }] : [],
  } as unknown as Plan;
}

describe('probeLayout', () => {
  it('covers the walls plus a margin with three levels from near the floor to near the ceiling', () => {
    const l = probeLayout(twoRooms() as Scene, { spacing: 0.5 })!;
    expect(l.res[1]).toBe(LEVELS);
    expect(l.min[0]).toBeCloseTo(-0.5);
    expect(l.min[1]).toBeCloseTo(0.3);
    expect(l.min[0] + l.size[0]).toBeCloseTo(8.5);
    expect(l.min[1] + l.size[1]).toBeGreaterThan(2);
    // The spacing never exceeds the request.
    expect(Math.max(l.spacing[0], l.spacing[2])).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(probeCount(l)).toBe(l.res[0] * l.res[1] * l.res[2]);
  });
  it('indexes probes X fastest, then Z, then Y, and places them on the spacing', () => {
    const l = probeLayout(twoRooms() as Scene, { spacing: 1 })!;
    expect(probeIndex(l, 1, 0, 0)).toBe(1);
    expect(probeIndex(l, 0, 0, 1)).toBe(l.res[0]);
    expect(probeIndex(l, 0, 1, 0)).toBe(l.res[0] * l.res[2]);
    const p = probePosition(l, 2, 1, 3);
    expect(p[0]).toBeCloseTo(l.min[0] + 2 * l.spacing[0]);
    expect(p[2]).toBeCloseTo(l.min[2] + 3 * l.spacing[2]);
  });
  it('is null for an empty flat', () => {
    expect(probeLayout({ walls: [], rooms: [] }, { spacing: 0.5 })).toBeNull();
  });
});

describe('wall solids', () => {
  it('cuts doors out of a wall but keeps windows', () => {
    const plan = twoRooms(true);
    const partition = (p: Plan) => wallSolids(p).filter((s) => Math.abs(s.cx - 4) < 0.01 && Math.abs(s.ux) < 0.5);
    expect(partition(plan)).toHaveLength(2);
    const windowPlan = { ...plan, openings: [{ id: 'w', wallId: 'mid', type: 'window', offset: 2, width: 1, height: 1, sill: 1 }] } as unknown as Plan;
    expect(partition(windowPlan)).toHaveLength(1);
  });
  it('a segment crosses a wall solid only when it goes through it', () => {
    const [mid] = wallSolids(twoRooms()).filter((s) => Math.abs(s.cx - 4) < 0.01 && Math.abs(s.ux) < 0.5);
    expect(segmentHitsSolid(mid!, 3, 2, 5, 2)).toBe(true);
    expect(segmentHitsSolid(mid!, 3, 2, 3.9, 2)).toBe(false);
    expect(segmentHitsSolid(mid!, 3, 2, 3, 3)).toBe(false);
  });
});

describe('probe validity and bake runs', () => {
  it('skips probes inside a wall and always starts the first run at probe 0', () => {
    const plan = twoRooms();
    const l = probeLayout(plan as Scene, { spacing: 0.5 })!;
    const valid = probeValidity(l, wallSolids(plan));
    // The partition (x 3.965 .. 4.035) holds no probe at 0.5 m spacing from -0.5; the outer walls (x -0.1 .. 0.1) hold the probe at x = 0.
    const inWall = probeIndex(l, Math.round((0 - l.min[0]) / l.spacing[0]), 0, Math.round((2 - l.min[2]) / l.spacing[2]));
    expect(valid[inWall]).toBe(0);
    expect(valid[probeIndex(l, 3, 0, 3)]).toBe(1);
    const runs = bakeRuns(valid);
    expect(runs[0]![0]).toBe(0);
    const covered = runs.reduce((n, r) => n + r[1], 0);
    expect(covered).toBeGreaterThanOrEqual(valid.reduce((n, v) => n + v, 0));
    for (const [start, count] of runs.slice(1)) for (let i = start; i < start + count; i++) expect(valid[i]).toBe(1);
  });
  it('splits runs at the longest allowed length and where the group changes', () => {
    const valid = new Uint8Array(10).fill(1);
    expect(bakeRuns(valid, 4)).toEqual([[0, 4], [4, 4], [8, 2]]);
    expect(bakeRuns(valid, Infinity, Uint8Array.from([0, 0, 1, 1, 1, 0, 0, 0, 1, 1]))).toEqual([[0, 2], [2, 3], [5, 3], [8, 2]]);
  });
  it('knows which probes are indoors (the balcony is not)', () => {
    const plan = twoRooms();
    plan.rooms.push({ id: 'bal', name: 'Balcon', type: 'balcony', polygon: [[8, 0], [9, 0], [9, 4], [8, 4]] } as never);
    const l = probeLayout(plan as Scene, { spacing: 0.5 })!;
    const indoor = probeIndoor(l, plan);
    expect(indoor[probeIndex(l, Math.round((2 - l.min[0]) / l.spacing[0]), 1, Math.round((2 - l.min[2]) / l.spacing[2]))]).toBe(1);
    expect(indoor[probeIndex(l, Math.round((8.5 - l.min[0]) / l.spacing[0]), 1, Math.round((2 - l.min[2]) / l.spacing[2]))]).toBe(0);
  });
});

describe('plan visibility (the leak guard)', () => {
  const plan = twoRooms();
  const l = probeLayout(plan as Scene, { spacing: 0.5 })!;
  const vis = buildVisibility(l, wallSolids(plan), []);
  const [nx, ny] = l.res;
  /** The four corner visibilities at a plan point, read the way the shader reads them. */
  function at(x: number, z: number): number[] {
    const gx = (x - l.min[0]) / l.spacing[0];
    const gz = (z - l.min[2]) / l.spacing[2];
    const cx = Math.floor(gx);
    const cz = Math.floor(gz);
    const sx = Math.min(vis.subdiv - 1, Math.floor((gx - cx) * vis.subdiv));
    const sz = Math.min(vis.subdiv - 1, Math.floor((gz - cz) * vis.subdiv));
    const index = 1 + ((cz * (nx - 1) + cx) * vis.subdiv + sz) * vis.subdiv + sx;
    return Array.from(vis.data.subarray(index * 4, index * 4 + 4));
  }
  /** Which side of the partition each corner of the cell around a point is on: x < 4 or x > 4. */
  const cornersOf = (x: number, z: number) => {
    const cx = Math.floor((x - l.min[0]) / l.spacing[0]);
    const cz = Math.floor((z - l.min[2]) / l.spacing[2]);
    return [0, 1, 0, 1].map((dx) => l.min[0] + (cx + dx) * l.spacing[0]).map((px, i) => ({ px, z: l.min[2] + (cz + (i >> 1)) * l.spacing[2] }));
  };

  it('has a header texel and fits the atlas it asks for', () => {
    expect(vis.data[0]).toBe(vis.subdiv);
    expect(vis.slices * nx * ny * 4).toBe(vis.data.length);
    expect(visibilitySize(l).slices).toBe(vis.slices);
  });
  it('a point 3 cm beside the partition reads no probe on the other side of it', () => {
    for (const [x, side] of [[3.95, -1], [4.05, 1]] as const) {
      const v = at(x, 2.1);
      cornersOf(x, 2.1).forEach((c, i) => {
        if (Math.sign(c.px - 4) === -side) expect(v[i], `corner ${i} at x ${c.px.toFixed(2)} seen from x ${x}`).toBe(0);
      });
      expect(v.some((w) => w === 1)).toBe(true);
    }
  });
  it('sees all four corners in the open', () => {
    expect(at(1.2, 1.3)).toEqual([1, 1, 1, 1]);
  });
  it('through a doorway the line between the rooms is free, elsewhere the partition blocks it', () => {
    const through = (p: Plan, z: number) => wallSolids(p).some((w) => segmentHitsSolid(w, 3, z, 5, z));
    expect(through(twoRooms(), 2)).toBe(true);
    expect(through(twoRooms(true), 2)).toBe(false);
    expect(through(twoRooms(true), 0.8)).toBe(true);
  });
  it('furniture is a last resort, never an empty cell', () => {
    const everything = [{ x0: -1, z0: -1, x1: 9, z1: 5 }];
    const v3 = buildVisibility(l, [], everything);
    expect(v3.data.slice(4).some((w) => w === 1)).toBe(true);
  });
});

describe('keys', () => {
  it('ignore float noise and change with real changes', () => {
    expect(keyOf({ a: [1.00001, 2], b: 'x' })).toBe(keyOf({ a: [1.00002, 2], b: 'x' }));
    expect(keyOf({ a: [1.5, 2] })).not.toBe(keyOf({ a: [1.6, 2] }));
  });
});
