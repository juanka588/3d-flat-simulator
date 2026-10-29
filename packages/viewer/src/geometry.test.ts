import { MeshBuilder, emptyMesh, ownerAt } from '@flat/scene';
import { DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { entityGeometry, ownerIndices, toBufferGeometry } from './geometry';

function twoQuads() {
  const b = new MeshBuilder();
  const n: [number, number, number] = [0, 1, 0];
  const uv: [[number, number], [number, number], [number, number], [number, number]] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  b.quad([[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0]], n, uv, 'm-b', { kind: 'floor', entityId: 'r2' });
  b.quad([[2, 0, 0], [2, 0, 1], [3, 0, 1], [3, 0, 0]], n, uv, 'm-a', { kind: 'floor', entityId: 'r1' });
  return b.build();
}

describe('toBufferGeometry', () => {
  it('maps attributes, index and groups', () => {
    const mesh = twoQuads();
    const g = toBufferGeometry(mesh);
    expect(g.getAttribute('position').count).toBe(8);
    expect(g.getAttribute('position').itemSize).toBe(3);
    expect(g.getAttribute('normal').count).toBe(8);
    expect(g.getAttribute('uv').itemSize).toBe(2);
    expect(g.getIndex()?.count).toBe(12);
    expect(g.groups).toEqual(mesh.groups.map((grp, i) => ({ start: grp.start, count: grp.count, materialIndex: i })));
    expect(g.groups).toHaveLength(2);
  });

  it('handles an empty mesh', () => {
    const g = toBufferGeometry(emptyMesh());
    expect(g.getIndex()?.count).toBe(0);
    expect(g.groups).toHaveLength(0);
  });
});

describe('entity geometry', () => {
  it('selects only the triangles of one entity', () => {
    const mesh = twoQuads();
    expect(ownerIndices(mesh, 'r1')).toHaveLength(6);
    expect(ownerIndices(mesh, 'nope')).toHaveLength(0);
    expect(entityGeometry(mesh, 'nope')).toBeNull();
    const g = entityGeometry(mesh, 'r2');
    expect(g?.getIndex()?.count).toBe(6);
  });
});

describe('picking through material groups', () => {
  it('maps raycast face indices back to owners with several groups and a material array', () => {
    const b = new MeshBuilder();
    const n: [number, number, number] = [0, 1, 0];
    const uv: [[number, number], [number, number], [number, number], [number, number]] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const quadAt = (x: number, material: string, entityId: string, kind: 'floor' | 'ceiling' = 'floor') =>
      b.quad([[x, 0, 0], [x, 0, 1], [x + 1, 0, 1], [x + 1, 0, 0]], n, uv, material, { kind, entityId });
    // Interleaved materials: the builder regroups triangles, so insertion order != triangle order.
    quadAt(0, 'm-b', 'r-b1');
    quadAt(2, 'm-a', 'r-a');
    quadAt(4, 'm-b', 'r-b2');
    quadAt(6, 'm-c', 'r-c');
    const data = b.build();
    expect(data.groups.length).toBeGreaterThanOrEqual(3);

    const mesh = new Mesh(
      toBufferGeometry(data),
      data.groups.map(() => new MeshBasicMaterial({ side: DoubleSide })),
    );
    mesh.updateMatrixWorld();
    const ray = new Raycaster();
    const down = new Vector3(0, -1, 0);
    const expected: [number, string][] = [
      [0.5, 'r-b1'],
      [2.5, 'r-a'],
      [4.5, 'r-b2'],
      [6.5, 'r-c'],
    ];
    for (const [x, entityId] of expected) {
      ray.set(new Vector3(x + 0.3, 2, 0.3), down);
      const hits = ray.intersectObject(mesh);
      expect(hits).toHaveLength(1);
      const hit = hits[0]!;
      expect(hit.faceIndex).toBeDefined();
      expect(ownerAt(data.owners, hit.faceIndex!)).toMatchObject({ kind: 'floor', entityId });
      // The hit face lies in the material group of the owner's material.
      const group = data.groups.find((g) => hit.faceIndex! * 3 >= g.start && hit.faceIndex! * 3 < g.start + g.count)!;
      expect(group.materialId).toBe({ 'r-b1': 'm-b', 'r-a': 'm-a', 'r-b2': 'm-b', 'r-c': 'm-c' }[entityId]);
    }
    ray.set(new Vector3(1.5, 2, 0.3), down); // gap between quads
    expect(ray.intersectObject(mesh)).toHaveLength(0);
  });

  it('shares attribute objects between the shell geometry and entity highlights', () => {
    const mesh = twoQuads();
    const shell = toBufferGeometry(mesh);
    const highlight = entityGeometry(mesh, 'r1')!;
    expect(highlight.getAttribute('position')).toBe(shell.getAttribute('position'));
    expect(highlight.getAttribute('normal')).toBe(shell.getAttribute('normal'));
  });
});
