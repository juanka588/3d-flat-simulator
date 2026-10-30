import { readFileSync } from 'node:fs';
import { buildItems } from '@flat/assets';
import { buildShell, loadSceneText } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { shadowCasterGeometry } from './derived-geometry';

const loaded = loadSceneText(readFileSync(new URL('../../scene/fixtures/charme-3205.flat.json', import.meta.url), 'utf8'));
if (!loaded.ok) throw new Error('fixture does not load');

describe('shadow casters', () => {
  it('leave out the clear glass of the bath screen (it casts no shadow) and keep everything else', () => {
    const shell = buildShell(loaded.scene, { items: buildItems });
    const glass = shell.items.groups.filter((g) => g.materialId === 'builtin:furniture-glass-clear').reduce((n, g) => n + g.count, 0);
    expect(glass).toBeGreaterThan(0);
    const all = [shell.walls, shell.fittings, shell.items, shell.ceilings, shell.floors, shell.ceilings].reduce((n, m) => n + m.indices.length, 0);
    expect(shadowCasterGeometry(shell).getIndex()!.count).toBe(all - glass);
  });
});
