import { describe, expect, it } from 'vitest';
import charme from '../../fixtures/charme-3205.flat.json';
import { parseScene } from '../parse';
import { buildShell } from './shell';

describe('buildShell performance budget', () => {
  const r = parseScene(charme);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  const scene = r.scene;

  it('builds Charme in under 30 ms on average and at most 60k triangles', () => {
    for (let i = 0; i < 3; i++) buildShell(scene); // warm-up
    const runs = 10;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) buildShell(scene);
    const avg = (performance.now() - t0) / runs;
    const budget = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CI ? 90 : 30;
    expect(avg).toBeLessThan(budget);

    const shell = buildShell(scene);
    const triangles = Object.values(shell).reduce((sum, m) => sum + m.indices.length / 3, 0);
    expect(triangles).toBeLessThanOrEqual(60000);
  });
});
