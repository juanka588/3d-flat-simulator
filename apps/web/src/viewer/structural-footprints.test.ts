import { describe, expect, it } from 'vitest';
import type { Scene } from '@flat/scene';
import { wallFootprints } from './structural-footprints';

describe('wallFootprints', () => {
  it('builds rectangles and resolves structural status', () => {
    const scene = {
      walls: [
        { id: 'a', start: [0, 0], end: [4, 0], thickness: 0.2, height: 2.6, finish: {} },
        { id: 'b', start: [0, 1], end: [4, 1], thickness: 0.08, height: 2.6, finish: {}, structural: false },
      ],
      rooms: [],
    } as unknown as Scene;
    const fps = wallFootprints(scene);
    expect(fps.map((f) => [f.wallId, f.structural])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    const ys = fps[0]!.corners.map((c) => Math.round(c[1] * 100) / 100).sort();
    expect(ys).toEqual([-0.1, -0.1, 0.1, 0.1]);
  });
});
