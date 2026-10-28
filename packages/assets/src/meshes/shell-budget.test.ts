import charme from '@flat/scene/fixtures/charme-3205.flat.json';
import { buildShell, parseScene } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { buildItems } from './build-items';

// The budget of scene's geometry/shell.test.ts, with the items built (scene's own shell has an empty items mesh since A4).
describe('buildShell with buildItems: performance budget', () => {
  const r = parseScene(charme);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  const scene = r.scene;
  const build = () => buildShell(scene, { items: buildItems });

  it('builds Charme in under 30 ms on average and at most 60k triangles', () => {
    for (let i = 0; i < 3; i++) build(); // warm-up
    const runs = 10;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) build();
    const avg = (performance.now() - t0) / runs;
    expect(avg).toBeLessThan(process.env.CI ? 90 : 30);

    const triangles = Object.values(build()).reduce((sum, m) => sum + m.indices.length / 3, 0);
    expect(triangles).toBeLessThanOrEqual(60000);
  });
});
