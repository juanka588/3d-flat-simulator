import { describe, expect, it } from 'vitest';
import { MeshBuilder, ownerAt } from './builder';

describe('MeshBuilder', () => {
  it('groups indices by material and keeps owners contiguous', () => {
    const b = new MeshBuilder();
    const quad = (x: number, mat: string, id: string) =>
      b.quad(
        [[x, 0, 0], [x + 1, 0, 0], [x + 1, 1, 0], [x, 1, 0]],
        [0, 0, 1],
        [[0, 0], [1, 0], [1, 1], [0, 1]],
        mat,
        { kind: 'wall', entityId: id, face: 'left' },
      );
    quad(0, 'paint', 'w1');
    quad(1, 'tile', 'w2');
    quad(2, 'paint', 'w3');
    const mesh = b.build();

    expect(mesh.indices).toHaveLength(18);
    expect(mesh.groups).toEqual([
      { start: 0, count: 12, materialId: 'paint' },
      { start: 12, count: 6, materialId: 'tile' },
    ]);
    expect(mesh.owners.map((o) => [o.entityId, o.start, o.count])).toEqual([
      ['w1', 0, 2],
      ['w3', 2, 2],
      ['w2', 4, 2],
    ]);
    expect(ownerAt(mesh.owners, 3)?.entityId).toBe('w3');
    expect(ownerAt(mesh.owners, 6)).toBeUndefined();
  });
});
