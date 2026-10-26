import { describe, expect, it } from 'vitest';
import charme from '../../fixtures/charme-3205.flat.json';
import sample from '../../fixtures/sample.flat.json';
import { parseScene } from '../parse';
import { wallLeftNormal, type Scene } from '../schema';
import { computeWallJunctions } from './junctions';
import { bounds, makeScene, triangles } from './testUtil';
import type { MeshData } from './types';
import { buildWalls } from './walls';

const wall = (id: string, start: [number, number], end: [number, number], thickness = 0.2, height = 2.5) => ({
  id,
  start,
  end,
  thickness,
  height,
});

function load(fixture: unknown): Scene {
  const r = parseScene(fixture);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.scene;
}

function checkMeshConsistency(mesh: MeshData) {
  const triCount = mesh.indices.length / 3;
  expect(Number.isInteger(triCount)).toBe(true);
  expect(mesh.positions.every(Number.isFinite)).toBe(true);
  expect(mesh.normals.every(Number.isFinite)).toBe(true);
  expect(mesh.uvs.every(Number.isFinite)).toBe(true);
  expect(mesh.positions.length / 3).toBe(mesh.normals.length / 3);
  expect(mesh.uvs.length / 2).toBe(mesh.positions.length / 3);
  // Owners cover every triangle, sorted and contiguous.
  let next = 0;
  for (const o of mesh.owners) {
    expect(o.start).toBe(next);
    expect(o.count).toBeGreaterThan(0);
    next += o.count;
  }
  expect(next).toBe(triCount);
  // Groups cover every index.
  let nextIdx = 0;
  for (const g of mesh.groups) {
    expect(g.start).toBe(nextIdx);
    expect(g.count % 3).toBe(0);
    nextIdx += g.count;
  }
  expect(nextIdx).toBe(mesh.indices.length);
  // Normals are unit and agree with the winding; no degenerate triangles.
  for (let v = 0; v < mesh.normals.length / 3; v++) {
    expect(Math.hypot(mesh.normals[v * 3]!, mesh.normals[v * 3 + 1]!, mesh.normals[v * 3 + 2]!)).toBeCloseTo(1, 5);
  }
  for (let t = 0; t < triCount; t++) {
    const tri = triangles(mesh, () => true)[t]!;
    expect(tri.area).toBeGreaterThan(1e-9);
    const i = mesh.indices[t * 3]!;
    const dotN = tri.n[0]! * mesh.normals[i * 3]! + tri.n[1]! * mesh.normals[i * 3 + 1]! + tri.n[2]! * mesh.normals[i * 3 + 2]!;
    expect(dotN).toBeGreaterThan(0.999);
  }
}

describe('buildWalls: single wall', () => {
  const scene = makeScene([wall('w', [0, 0], [4, 0])]);
  const mesh = buildWalls(scene);

  it('has exact bounds', () => {
    const b = bounds(triangles(mesh));
    expect(b.min[0]).toBeCloseTo(0, 3);
    expect(b.max[0]).toBeCloseTo(4, 3);
    expect(b.min[1]).toBeCloseTo(0, 3);
    expect(b.max[1]).toBeCloseTo(2.5, 3);
    expect(b.min[2]).toBeCloseTo(-0.1, 3);
    expect(b.max[2]).toBeCloseTo(0.1, 3);
  });

  it('is a consistent mesh with every triangle owned by the wall', () => {
    checkMeshConsistency(mesh);
    expect(mesh.owners.every((o) => o.kind === 'wall' && o.entityId === 'w' && o.face)).toBe(true);
    expect(new Set(mesh.owners.map((o) => o.face))).toEqual(new Set(['left', 'right', 'top', 'end']));
    // A box without a bottom: 5 quads.
    expect(mesh.indices.length / 3).toBe(10);
  });

  it('points left faces along wallLeftNormal and right faces against it', () => {
    const [nx, nz] = wallLeftNormal({ start: [0, 0], end: [4, 0] });
    const left = triangles(mesh, (o) => o.face === 'left');
    const right = triangles(mesh, (o) => o.face === 'right');
    for (const t of left) expect([t.n[0], t.n[2]]).toEqual([nx, nz].map((v) => expect.closeTo(v!, 6)));
    for (const t of right) expect([t.n[0], t.n[2]]).toEqual([-nx, -nz].map((v) => expect.closeTo(v!, 6)));
    for (const t of triangles(mesh, (o) => o.face === 'top')) expect(t.n[1]).toBeCloseTo(1, 6);
  });

  it('uses side materials for faces and the default wall material for edges', () => {
    const s = makeScene(
      [{ ...wall('w', [0, 0], [4, 0]), finish: { left: 'a', right: 'b' } }],
      [],
      {
        materials: ['a', 'b', 'edge'].map((id) => ({ id, name: id, kind: 'paint' as const, color: '#ffffff' })),
        defaults: { wall: 'edge' },
      },
    );
    const m = buildWalls(s);
    const mat = (face: string) => {
      const o = m.owners.find((x) => x.face === face)!;
      return m.groups.find((g) => g.start <= o.start * 3 && o.start * 3 < g.start + g.count)!.materialId;
    };
    expect(mat('left')).toBe('a');
    expect(mat('right')).toBe('b');
    expect(mat('top')).toBe('edge');
    expect(mat('end')).toBe('edge');
  });

  it('uses uvs in metres along the wall and up', () => {
    const left = triangles(mesh, (o) => o.face === 'left');
    expect(left.length).toBeGreaterThan(0);
    const o = mesh.owners.find((x) => x.face === 'left')!;
    const us = new Set<number>();
    const vs = new Set<number>();
    for (let t = o.start; t < o.start + o.count; t++) {
      for (let k = 0; k < 3; k++) {
        const i = mesh.indices[t * 3 + k]!;
        us.add(Math.round(mesh.uvs[i * 2]! * 1000) / 1000);
        vs.add(Math.round(mesh.uvs[i * 2 + 1]! * 1000) / 1000);
      }
    }
    expect([...us].sort()).toEqual([0, 4]);
    expect([...vs].sort()).toEqual([0, 2.5]);
  });
});

describe('buildWalls: openings', () => {
  const walls = [wall('w', [0, 0], [6, 0], 0.2, 2.5)];
  const openings = [
    { id: 'win', wallId: 'w', type: 'window' as const, offset: 1.5, width: 1.0, height: 1.2, sill: 0.9 },
    { id: 'door', wallId: 'w', type: 'door' as const, offset: 3.5, width: 0.9, height: 2.1 },
    { id: 'tall', wallId: 'w', type: 'passage' as const, offset: 5.2, width: 0.8, height: 2.5 },
  ];
  const scene = makeScene(walls, openings);
  const mesh = buildWalls(scene);

  it('is consistent', () => checkMeshConsistency(mesh));

  it('cuts holes at offset +/- width/2 and sill..sill+height', () => {
    const jambs = triangles(mesh, (o) => o.face === 'jamb');
    const xs = new Set(jambs.flatMap((t) => t.p.map((p) => Math.round(p[0]! * 1000) / 1000)));
    for (const x of [1.0, 2.0, 3.05, 3.95, 4.8, 5.6]) expect(xs).toContain(x);
    // Window sill and head heights.
    const horizontal = jambs.filter((t) => Math.abs(t.n[1]!) > 0.99);
    const ys = new Set(horizontal.map((t) => Math.round(t.p[0][1]! * 1000) / 1000));
    expect(ys).toContain(0.9);
    expect(ys).toContain(2.1);
  });

  it('keeps per-side area equal to length x height minus the openings', () => {
    const net = 6 * 2.5 - (1.0 * 1.2 + 0.9 * 2.1 + 0.8 * 2.5);
    for (const face of ['left', 'right'] as const) {
      const area = triangles(mesh, (o) => o.face === face).reduce((s, t) => s + t.area, 0);
      expect(area).toBeCloseTo(net, 4);
    }
  });

  it('leaves nothing below sill-0 doors and passages, and nothing above a full-height passage', () => {
    for (const t of triangles(mesh, (o) => o.face === 'left' || o.face === 'right')) {
      const cx = (t.p[0][0]! + t.p[1][0]! + t.p[2][0]!) / 3;
      const cy = (t.p[0][1]! + t.p[1][1]! + t.p[2][1]!) / 3;
      if (cx > 3.05 && cx < 3.95) expect(cy).toBeGreaterThan(2.1);
      if (cx > 4.8 && cx < 5.6) expect.fail('passage reaching the wall top must leave no wall');
    }
  });

  it('puts no top face over a hole that reaches the wall top', () => {
    const tops = triangles(mesh, (o) => o.face === 'top');
    for (const t of tops) {
      const cx = (t.p[0][0]! + t.p[1][0]! + t.p[2][0]!) / 3;
      expect(cx < 4.8 || cx > 5.6).toBe(true);
    }
  });

  it('puts top faces over lintels (head pieces) with a jamb-labelled underside', () => {
    const down = triangles(mesh, (o) => o.face === 'jamb').filter((t) => t.n[1]! < -0.99);
    expect(down.length).toBeGreaterThan(0);
  });
});

describe('buildWalls: junctions', () => {
  const topArea = (m: MeshData) => triangles(m, (o) => o.face === 'top').reduce((s, t) => s + t.area, 0);

  it('does not overlap wall tops at a T-junction', () => {
    const scene = makeScene([wall('host', [0, 0], [10, 0]), wall('stem', [5, 4], [5, 0], 0.1)]);
    expect(topArea(buildWalls(scene))).toBeCloseTo(10 * 0.2 + 3.9 * 0.1, 4);
  });

  it('does not overlap wall tops at a mitred L-corner', () => {
    const scene = makeScene([wall('a', [0, 0], [4, 0]), wall('b', [4, 0], [4, 3])]);
    // Two 0.2 m strokes sharing the mitred corner: 4 x 0.2 + 3 x 0.2.
    expect(topArea(buildWalls(scene))).toBeCloseTo(1.4, 4);
    const mesh = buildWalls(scene);
    checkMeshConsistency(mesh);
    const b = bounds(triangles(mesh));
    expect(b.max[0]).toBeCloseTo(4.1, 3);
    expect(b.min[2]).toBeCloseTo(-0.1, 3);
  });

  it('keeps per-side area with trimmed footprints and openings', () => {
    const scene = makeScene(
      [wall('host', [0, 0], [10, 0]), wall('stem', [5, 4], [5, 0], 0.1)],
      [{ id: 'd', wallId: 'stem', type: 'door', offset: 2, width: 0.9, height: 2.1 }],
    );
    const mesh = buildWalls(scene);
    checkMeshConsistency(mesh);
    const fp = computeWallJunctions(scene.walls).get('stem')!;
    const net = (fp.endLeft - fp.startLeft) * 2.5 - 0.9 * 2.1;
    expect(triangles(mesh, (o) => o.entityId === 'stem' && o.face === 'left').reduce((s, t) => s + t.area, 0)).toBeCloseTo(net, 4);
  });
});

describe('buildWalls: edge cases', () => {
  it('handles sill + height = wall height without zero-area triangles', () => {
    const scene = makeScene(
      [wall('w', [0, 0], [4, 0])],
      [{ id: 'o', wallId: 'w', type: 'window', offset: 2, width: 1, height: 1.6, sill: 0.9 }],
    );
    const mesh = buildWalls(scene);
    checkMeshConsistency(mesh);
    const net = 4 * 2.5 - 1.6;
    expect(triangles(mesh, (o) => o.face === 'left').reduce((s, t) => s + t.area, 0)).toBeCloseTo(net, 4);
  });

  it('handles openings touching the wall ends and each other', () => {
    const scene = makeScene(
      [wall('w', [0, 0], [4, 0])],
      [
        { id: 'a', wallId: 'w', type: 'window', offset: 0.5, width: 1, height: 1, sill: 1 },
        { id: 'b', wallId: 'w', type: 'door', offset: 1.5, width: 1, height: 2.1 },
        { id: 'c', wallId: 'w', type: 'passage', offset: 3.5, width: 1, height: 2.1 },
      ],
    );
    const mesh = buildWalls(scene);
    checkMeshConsistency(mesh);
    const net = 4 * 2.5 - (1 + 2.1 + 2.1);
    expect(triangles(mesh, (o) => o.face === 'right').reduce((s, t) => s + t.area, 0)).toBeCloseTo(net, 4);
  });

  it('handles an opening that runs into a T-junction trim', () => {
    const scene = makeScene(
      [wall('host', [0, 0], [10, 0]), wall('stem', [5, 4], [5, 0], 0.1)],
      [{ id: 'd', wallId: 'stem', type: 'door', offset: 3.7, width: 0.6, height: 2.1 }],
    );
    checkMeshConsistency(buildWalls(scene));
  });
});

describe('buildWalls: fixtures', () => {
  for (const [name, fixture] of [['charme-3205', charme], ['sample', sample]] as const) {
    it(`builds ${name} without NaN, within the triangle budget`, () => {
      const scene = load(fixture);
      const mesh = buildWalls(scene);
      checkMeshConsistency(mesh);
      expect(mesh.indices.length / 3).toBeLessThan(60000);
      expect(mesh.indices.length / 3).toBeGreaterThan(scene.walls.length * 10);
    });

    it(`${name}: wall bounds, hole spans and side areas match the JSON`, () => {
      const scene = load(fixture);
      const mesh = buildWalls(scene);
      const fps = computeWallJunctions(scene.walls);
      for (const w of scene.walls) {
        const own = triangles(mesh, (o) => o.entityId === w.id);
        expect(own.length).toBeGreaterThan(0);
        const b = bounds(own);
        expect(b.min[1]).toBeCloseTo(0, 3);
        expect(b.max[1]).toBeCloseTo(w.height, 3);
        const fp = fps.get(w.id)!;
        const len = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
        const u = [(w.end[0] - w.start[0]) / len, (w.end[1] - w.start[1]) / len];
        const sOf = (p: number[]) => (p[0]! - w.start[0]) * u[0]! + (p[2]! - w.start[1]) * u[1]!;
        const ss = own.flatMap((t) => t.p.map(sOf));
        expect(Math.min(...ss)).toBeCloseTo(Math.min(fp.startLeft, fp.startRight), 3);
        expect(Math.max(...ss)).toBeCloseTo(Math.max(fp.endLeft, fp.endRight), 3);

        const mine = scene.openings.filter((o) => o.wallId === w.id);
        const jambS = new Set(
          own.filter(() => true).flatMap((t) => t.p.map((p) => Math.round(sOf(p) * 1000) / 1000)),
        );
        for (const o of mine) {
          expect(jambS).toContain(Math.round((o.offset - o.width / 2) * 1000) / 1000);
          expect(jambS).toContain(Math.round((o.offset + o.width / 2) * 1000) / 1000);
        }
        const holeArea = mine.reduce((s, o) => s + o.width * o.height, 0);
        for (const face of ['left', 'right'] as const) {
          const area = triangles(mesh, (o) => o.entityId === w.id && o.face === face).reduce((s, t) => s + t.area, 0);
          const expected =
            (face === 'left' ? fp.endLeft - fp.startLeft : fp.endRight - fp.startRight) * w.height - holeArea;
          expect(area).toBeCloseTo(expected, 4);
        }
      }
    });
  }
});
