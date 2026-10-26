import { MeshBuilder, emptyMesh } from '@flat/scene';
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
