import { describe, expect, it } from 'vitest';
import charme from '../../fixtures/charme-3205.flat.json';
import { roomArea } from '../measure';
import { parseScene } from '../parse';
import type { Scene, Wall } from '../schema';
import { buildCeilings, buildFloors, edgeCoverage, roomCeilingHeight } from './floors';
import type { MeshData } from './types';

function load(input: unknown): Scene {
  const r = parseScene(input);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.scene;
}

function box(polygon: [number, number][], extra: object = {}): Scene {
  return load({
    version: 1,
    name: 't',
    site: { latitude: 0, longitude: 0 },
    walls: [{ id: 'w', start: [0, 0], end: [1, 0] }],
    rooms: [{ id: 'r', name: 'R', type: 'living', polygon, ...extra }],
  });
}

/** Signed triangle areas projected on the xz plane, plus summed normal direction. */
function analyse(mesh: MeshData, owner?: string) {
  let area = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  let facing = 0;
  const p = mesh.positions;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!];
    const e1 = [p[b * 3]! - p[a * 3]!, p[b * 3 + 1]! - p[a * 3 + 1]!, p[b * 3 + 2]! - p[a * 3 + 2]!];
    const e2 = [p[c * 3]! - p[a * 3]!, p[c * 3 + 1]! - p[a * 3 + 1]!, p[c * 3 + 2]! - p[a * 3 + 2]!];
    const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    area += Math.abs(ny) / 2;
    facing += Math.sign(ny);
    for (const v of [a, b, c]) {
      minY = Math.min(minY, p[v * 3 + 1]!);
      maxY = Math.max(maxY, p[v * 3 + 1]!);
    }
  }
  void owner;
  return { area, minY, maxY, facing, triangles: mesh.indices.length / 3 };
}

describe('buildFloors', () => {
  it('triangulates a rectangle facing up at y = 0 with metre UVs', () => {
    const mesh = buildFloors(box([[0, 0], [4, 0], [4, 3], [0, 3]]));
    const a = analyse(mesh);
    expect(a.triangles).toBe(2);
    expect(a.area).toBeCloseTo(12, 9);
    expect(a.facing).toBe(2); // both triangles wind to +Y
    expect(a.minY).toBe(0);
    expect(a.maxY).toBe(0);
    expect([...mesh.normals].every((v, i) => (i % 3 === 1 ? v === 1 : v === 0))).toBe(true);
    expect([...mesh.uvs.slice(0, 2)]).toEqual([0, 0]);
    expect(Math.max(...mesh.uvs)).toBe(4);
    expect(mesh.owners).toEqual([{ start: 0, count: 2, kind: 'floor', entityId: 'r' }]);
    expect(mesh.groups).toEqual([{ start: 0, count: 6, materialId: 'builtin:floor' }]);
  });

  it('handles clockwise and counter-clockwise windings of a concave L room', () => {
    const ccw: [number, number][] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
    const cw = [...ccw].reverse();
    for (const poly of [ccw, cw]) {
      const mesh = buildFloors(box(poly));
      const a = analyse(mesh);
      expect(a.area).toBeCloseTo(12, 9);
      expect(a.facing).toBe(a.triangles);
    }
  });

  it('uses room, then default, then builtin materials', () => {
    const scene = load({
      version: 1,
      name: 't',
      site: { latitude: 0, longitude: 0 },
      materials: [
        { id: 'a', name: 'A', kind: 'paint', color: '#ffffff' },
        { id: 'b', name: 'B', kind: 'paint', color: '#000000' },
      ],
      defaults: { floor: 'a' },
      walls: [{ id: 'w', start: [0, 0], end: [1, 0] }],
      rooms: [
        { id: 'r1', name: 'R1', type: 'living', polygon: [[0, 0], [1, 0], [1, 1], [0, 1]] },
        { id: 'r2', name: 'R2', type: 'living', polygon: [[2, 0], [3, 0], [3, 1], [2, 1]], floorMaterial: 'b' },
      ],
    });
    expect(buildFloors(scene).groups.map((g) => g.materialId).sort()).toEqual(['a', 'b']);
  });

  it('is empty without rooms', () => {
    const scene = box([[0, 0], [1, 0], [1, 1]]);
    expect(buildFloors({ ...scene, rooms: [] }).indices.length).toBe(0);
  });
});

describe('buildCeilings', () => {
  it('faces down at the explicit ceiling height', () => {
    const mesh = buildCeilings(box([[0, 0], [4, 0], [4, 3], [0, 3]], { ceilingHeight: 2.7 }));
    const a = analyse(mesh);
    expect(a.minY).toBeCloseTo(2.7, 5);
    expect(a.maxY).toBeCloseTo(2.7, 5);
    expect(a.facing).toBe(-a.triangles);
    expect(a.area).toBeCloseTo(12, 9);
    expect(mesh.normals[1]).toBe(-1);
    expect(mesh.owners[0]!.kind).toBe('ceiling');
  });

  it('defaults to the lowest wall along the room edges', () => {
    const scene = load({
      version: 1,
      name: 't',
      site: { latitude: 0, longitude: 0 },
      walls: [
        { id: 'a', start: [0, 0], end: [4, 0], thickness: 0.2, height: 2.6 },
        { id: 'b', start: [4, 0], end: [4, 3], thickness: 0.2, height: 2.4 },
        { id: 'c', start: [4, 3], end: [0, 3], thickness: 0.2, height: 2.6 },
        { id: 'd', start: [0, 3], end: [0, 0], thickness: 0.2, height: 2.6 },
        { id: 'far', start: [10, 10], end: [14, 10], height: 1.0 },
      ],
      rooms: [{ id: 'r', name: 'R', type: 'living', polygon: [[0.1, 0.1], [3.9, 0.1], [3.9, 2.9], [0.1, 2.9]] }],
    });
    expect(roomCeilingHeight(scene, scene.rooms[0]!)).toBe(2.4);
    expect(analyse(buildCeilings(scene)).minY).toBeCloseTo(2.4, 5);
  });

  it('falls back to 2.5 m when no wall bounds the room', () => {
    const scene = box([[0, 5], [4, 5], [4, 8], [0, 8]]);
    expect(roomCeilingHeight(scene, scene.rooms[0]!)).toBe(2.5);
  });

  it('gives balconies no ceiling', () => {
    const mesh = buildCeilings(box([[0, 0], [4, 0], [4, 3], [0, 3]], { type: 'balcony' }));
    expect(mesh.indices.length).toBe(0);
  });
});

describe('edgeCoverage', () => {
  const wall: Wall = { id: 'w', start: [0, 0], end: [4, 0], thickness: 0.2, height: 2.5, finish: {} };
  it('reports the uncovered part of an edge', () => {
    const c = edgeCoverage([{ ...wall, start: [0, 0], end: [2, 0] }], [0, 0.1], [4, 0.1]);
    expect(c.walls).toHaveLength(1);
    expect(c.uncovered).toBeCloseTo(4 - 2.1, 6);
  });
  it('ignores walls that are not parallel or too far away', () => {
    expect(edgeCoverage([wall], [0, 0.5], [4, 0.5]).walls).toHaveLength(0);
    expect(edgeCoverage([wall], [0, 0], [0, 3]).walls).toHaveLength(0);
  });
});

describe('Charme 3205 floors and ceilings', () => {
  const scene = load(charme);
  const floors = buildFloors(scene);
  const ceilings = buildCeilings(scene);

  it('floor triangle area per room equals the polygon area', () => {
    for (const room of scene.rooms) {
      const single = { ...scene, rooms: [room] };
      expect(analyse(buildFloors(single)).area).toBeCloseTo(roomArea(room), 4);
    }
    expect(analyse(floors).facing).toBe(analyse(floors).triangles);
  });

  it('ch1 is about 13.88 m²', () => {
    const ch1 = scene.rooms.find((r) => r.id === 'ch1')!;
    expect(roomArea(ch1)).toBeCloseTo(13.88, 1);
  });

  it('has a ceiling for every room except the balcony, at 2.5 m, facing down', () => {
    const ids = new Set(ceilings.owners.map((o) => o.entityId));
    expect(ids.size).toBe(scene.rooms.length - 1);
    expect(ids.has('balcon')).toBe(false);
    const a = analyse(ceilings);
    expect(a.minY).toBe(2.5);
    expect(a.maxY).toBe(2.5);
    expect(a.facing).toBe(-a.triangles);
  });

  it('derives 2.5 m for rooms without explicit height from the walls', () => {
    const { ceilingHeight: _drop, ...rest } = scene.rooms.find((r) => r.id === 'sejour')!;
    void _drop;
    expect(roomCeilingHeight(scene, rest)).toBe(2.5);
  });
});
