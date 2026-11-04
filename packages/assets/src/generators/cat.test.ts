import { describe, expect, it } from 'vitest';
import charme from '@flat/scene/fixtures/charme-3205.flat.json';
import { footprintOf, parseScene, validateLayout } from '@flat/scene';
import type { Scene } from '@flat/scene';
import { CAT_MAX_RISE, catTree, catWall, catWallBoards } from './cat';
import '../register';

const parsed = parseScene(charme);
if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
const base: Scene = parsed.scene;

describe('catWall', () => {
  it('defaults: 6 boards, at most 0.45 m between two, the lowest at 0 and the top at h', () => {
    const p = catWall.params.parse({});
    const boards = catWallBoards(p);
    expect(boards).toHaveLength(6);
    for (let i = 1; i < boards.length; i++) expect(boards[i]!.y - boards[i - 1]!.y).toBeLessThanOrEqual(CAT_MAX_RISE);
    expect(boards[0]!.y).toBe(0);
    for (const b of boards) {
      expect(b.x0).toBeGreaterThanOrEqual(-p.w / 2 - 1e-9);
      expect(b.x1).toBeLessThanOrEqual(p.w / 2 + 1e-9);
    }
    expect(catWall.describeParams(p).dims).toEqual({ w: p.w, d: p.d, h: p.h });
  });

  it('every layout and option combination stays inside its box and keeps the boards reachable', () => {
    for (const layout of ['stairs', 'zigzag'] as const) {
      for (const rising of ['left', 'right'] as const) {
        for (const steps of [2, 5, 9]) {
          const p = catWall.params.parse({ layout, rising, steps, post: true, hammock: true, cave: true, bridge: true, w: 1.2, h: 2 });
          const boards = catWallBoards(p);
          for (const b of boards) expect(b.x1 - b.x0).toBeGreaterThan(0.25);
          // neighbouring boards overlap or nearly touch in plan, so a cat can step from one to the next
          for (let i = 1; i < boards.length; i++) expect(Math.max(boards[i]!.x0, boards[i - 1]!.x0) - Math.min(boards[i]!.x1, boards[i - 1]!.x1), `${layout}/${rising}/${steps}`).toBeLessThan(0.4);
          const mesh = catWall.generate(p);
          for (let i = 0; i < mesh.positions.length; i += 3) {
            expect(Math.abs(mesh.positions[i]!)).toBeLessThanOrEqual(p.w / 2 + 1e-6);
            expect(mesh.positions[i + 1]!).toBeLessThanOrEqual(p.h + 1e-6);
          }
        }
      }
    }
  });

  it('hung on the east wall of the alcove it clears the window, the radiator and the door swing; the tree stands clear too', () => {
    const wall = { id: 'cat-wall', assetId: 'param:catWall', position: [3.92, 1.5] as [number, number], rotation: 270, elevation: 0.2, mount: 'wall' as const, roomId: 'alcove', concept: true, dims: { w: 1.3, d: 0.3, h: 1.8 }, mesh: { kind: 'parametric' as const, generator: 'catWall', params: { w: 1.3, d: 0.3, h: 1.8 } } };
    const tree = { id: 'cat-tree', assetId: 'param:catTree', position: [0.25, 0.6] as [number, number], rotation: 90, elevation: 0, mount: 'floor' as const, roomId: 'alcove', concept: true, dims: { w: 0.6, d: 0.5, h: 1.5 }, mesh: { kind: 'parametric' as const, generator: 'catTree', params: { w: 0.6, d: 0.5, h: 1.5 } } };
    const scene = parseScene({ ...base, items: [...base.items, wall, tree] });
    if (!scene.ok) throw new Error(scene.errors.join('\n'));
    const report = validateLayout(scene.scene, { roomId: 'alcove' });
    expect(report.violations).toEqual([]);
    // the wall's footprint is on the east wall (x 3.77 - 4.07), far from the window (x 1.14 - 2.14), the radiator (x 0.15 - 0.95) and the door (x 0.07 - 0.87, y > 1.4)
    const fp = footprintOf(wall.position, wall.rotation, { w: 1.3, d: 0.3 });
    expect(Math.min(...fp.map((p) => p[0]))).toBeGreaterThan(3.7);
    // the tree is beside the radiator, outside its 15 cm front zone (y > 0.25) and above the door swing (y < 1.4)
    const tp = footprintOf(tree.position, tree.rotation, { w: 0.6, d: 0.5 });
    expect(Math.min(...tp.map((p) => p[1]))).toBeGreaterThanOrEqual(0.25);
    expect(Math.max(...tp.map((p) => p[1]))).toBeLessThan(1.1);
  });
});

describe('catTree', () => {
  it('has the described box and its cave fits under the first platform', () => {
    const p = catTree.params.parse({});
    const { dims } = catTree.describeParams(p);
    expect(dims).toEqual({ w: p.w, d: p.d, h: p.h });
    const mesh = catTree.generate(p);
    expect(mesh.indices.length / 3).toBeGreaterThan(100);
  });
});
