import { describe, expect, it } from 'vitest';
import { loadSceneText, pointInPolygon } from '@flat/scene';
import type { Scene } from '@flat/scene';
import charme from '@flat/scene/fixtures/charme-3205.flat.json';
import { partyWallIds } from './derived-geometry';
import { LEVELS, bakeRuns, buildVisibility, keyOf, outOfWalls, planPointInWall, probeCount, probeIndex, probeIndoor, probeLayout, probePosition, probeValidity, segmentHitsSolid, visibilitySize, wallSolids } from './probe-grid';

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

describe('outOfWalls', () => {
  const [mid] = wallSolids(twoRooms()).filter((s) => Math.abs(s.cx - 4) < 0.01 && Math.abs(s.ux) < 0.5);
  it('moves a point inside a wall out through the nearest face, to just beyond it', () => {
    const [x, z] = outOfWalls([mid!], 3.99, 2);
    expect(x).toBeLessThan(3.965);
    expect(x).toBeGreaterThan(3.95);
    expect(z).toBeCloseTo(2);
    expect(outOfWalls([mid!], 4.02, 2)[0]).toBeGreaterThan(4.035);
  });
  it('leaves a free point alone', () => {
    expect(outOfWalls([mid!], 3.9, 2.2)).toEqual([3.9, 2.2]);
  });
  it('leaves a point where two flush walls overlap through the face that leads out of both (no ping-pong between them)', () => {
    // A 24 cm column whose east face is the inner face of a 20 cm wall (x 6.39), its ends extended by half the thickness.
    const plan = {
      walls: [
        { id: 'east', start: [6.49, 6], end: [6.49, 9], thickness: 0.2, height: 2.5, finish: {} },
        { id: 'column', start: [6.27, 6.9], end: [6.27, 7.66], thickness: 0.24, height: 2.5, finish: {} },
      ],
      openings: [],
    } as unknown as Pick<Scene, 'walls' | 'openings'>;
    const solids = wallSolids(plan);
    // The extended cap of the column (z 6.78 .. 6.9) is only a phantom solid: a point in it leaves to the north, not into the east wall.
    const [x, z] = outOfWalls(solids, 6.38, 6.85);
    expect(solids.some((s) => segmentHitsSolid(s, x, z, x, z + 1e-9))).toBe(false);
    expect(x).toBeCloseTo(6.38);
    expect(z).toBeLessThan(6.78);
  });
});

describe('visibility never lets a point read a probe behind a wall (the strips of light along every wall)', () => {
  /**
   * The real flat: for a fine grid of free points in the plan, the corners the shader would read must be in exact view (no wall in the
   * way) from the point, except where no corner of the cell is in view at all. Before the fix the 3 cm band beside every wall read the
   * sky-lit probes on the other side of it.
   */
  const result = loadSceneText(JSON.stringify(charme));
  if (!result.ok) throw new Error('fixture does not load');
  const flat = result.scene;
  const layout = probeLayout(flat, { spacing: 0.5 })!;
  const solids = wallSolids(flat, partyWallIds(flat));
  const habitable = flat.rooms.filter((r) => r.type !== 'balcony').map((r) => r.polygon);
  const visibility = buildVisibility(layout, solids, [], Infinity, habitable);
  const [nx] = layout.res;
  const corners = (x: number, z: number) => {
    const cx = Math.floor((x - layout.min[0]) / layout.spacing[0]);
    const cz = Math.floor((z - layout.min[2]) / layout.spacing[2]);
    return { cx, cz, pos: [0, 1, 2, 3].map((i) => [layout.min[0] + (cx + (i & 1)) * layout.spacing[0], layout.min[2] + (cz + (i >> 1)) * layout.spacing[2]] as [number, number]) };
  };
  const read = (x: number, z: number): number[] => {
    const gx = (x - layout.min[0]) / layout.spacing[0];
    const gz = (z - layout.min[2]) / layout.spacing[2];
    const cx = Math.floor(gx);
    const cz = Math.floor(gz);
    const sx = Math.min(visibility.subdiv - 1, Math.floor((gx - cx) * visibility.subdiv));
    const sz = Math.min(visibility.subdiv - 1, Math.floor((gz - cz) * visibility.subdiv));
    const index = 1 + ((cz * (nx - 1) + cx) * visibility.subdiv + sz) * visibility.subdiv + sx;
    return Array.from(visibility.data.subarray(index * 4, index * 4 + 4));
  };
  const free = (x: number, z: number) => !planPointInWall(x, z, solids);
  const inRoom = (x: number, z: number) => habitable.some((p) => pointInPolygon([x, z], p));
  // The probes standing in a doorway are part of the opening, not outside: the walls without their cut-outs tell.
  const uncut = wallSolids({ ...flat, openings: [] });
  const inAnyRoom = (x: number, z: number) => flat.rooms.some((r) => pointInPolygon([x, z], r.polygon));

  it('a point in a room, however close to a wall, never reads a probe outside the flat that it cannot see (the landing, the neighbours, the street)', () => {
    let checked = 0;
    let anyLeak = 0;
    const outdoors: string[] = [];
    // Every 1.5 cm over the whole flat: the bands beside every wall, door jamb, column and corner are in it.
    for (let x = -0.2; x <= 10.2; x += 0.015) {
      for (let z = -0.2; z <= 8.4; z += 0.015) {
        if (!free(x, z) || !inRoom(x, z)) continue;
        const v = read(x, z);
        const { pos } = corners(x, z);
        const visible = pos.map(([qx, qz]) => !solids.some((s) => segmentHitsSolid(s, x, z, qx, qz)));
        checked++;
        v.forEach((w, i) => {
          if (w !== 1 || visible[i]) return;
          anyLeak++;
          if (!inAnyRoom(pos[i]![0], pos[i]![1]) && !planPointInWall(pos[i]![0], pos[i]![1], uncut)) outdoors.push(`(${x.toFixed(3)}, ${z.toFixed(3)}) reads the outdoor corner (${pos[i]![0].toFixed(2)}, ${pos[i]![1].toFixed(2)})`);
        });
      }
    }
    expect(checked).toBeGreaterThan(100000);
    expect(outdoors.slice(0, 5)).toEqual([]);
    // Rooms next to each other keep a rare deviation at wall ends (a 6 cm subcell is tested from its centre), not a band along every wall.
    expect(anyLeak / checked).toBeLessThan(0.02);
  });

  it('a point in a room never reads a probe outdoors when it has no corner in view (the landing never lights the bathroom)', () => {
    const outdoors: string[] = [];
    for (let x = 3.8; x <= 6.4; x += 0.02) {
      for (let z = 6.1; z <= 8.28; z += 0.02) {
        if (!free(x, z) || !inRoom(x, z)) continue;
        const v = read(x, z);
        const { pos } = corners(x, z);
        v.forEach((w, i) => {
          if (w === 1 && !inRoom(pos[i]![0], pos[i]![1]) && !planPointInWall(pos[i]![0], pos[i]![1], solids)) outdoors.push(`(${x.toFixed(2)}, ${z.toFixed(2)}) reads (${pos[i]![0].toFixed(2)}, ${pos[i]![1].toFixed(2)})`);
        });
      }
    }
    expect(outdoors.slice(0, 5)).toEqual([]);
  });

  it('the front door, in a party wall, is no gap for the probes of the landing', () => {
    const open = wallSolids(flat);
    const closed = wallSolids(flat, partyWallIds(flat));
    const doorCentre: [number, number] = [7.78, 6.115];
    const through = (list: typeof open) => list.some((s) => segmentHitsSolid(s, doorCentre[0], 5.9, doorCentre[0], 6.5));
    expect(through(open)).toBe(false);
    expect(through(closed)).toBe(true);
  });
});
