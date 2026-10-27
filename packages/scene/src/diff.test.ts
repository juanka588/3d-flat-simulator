import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands/apply';
import type { Command } from './commands/schema';
import { FIXTURES, env } from './commands/testUtil';
import { diffScenes } from './diff';
import { DIFF_MAX_ENTRIES, SceneDiff } from './mcp-types';
import type { Scene } from './schema';

const charme = FIXTURES.charme!;
const green = { id: 'paint-green', name: 'Green', kind: 'paint' as const, color: '#00aa00', roughness: 0.9 };
const apply = (scene: Scene, cmd: Command): Scene => {
  const r = applyCommand(scene, env(cmd));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.scene;
};

describe('diffScenes', () => {
  it('is empty for a scene against itself and for equal copies', () => {
    for (const s of Object.values(FIXTURES)) {
      const d = diffScenes(s, s);
      expect(d).toEqual({ changes: [], summary: { added: 0, removed: 0, modified: 0 }, text: 'no changes' });
      expect(diffScenes(s, structuredClone(s)).changes).toEqual([]);
    }
  });

  it('names the room for room.setWallFinish, and the walls touched', () => {
    const withGreen = apply(charme, { type: 'material.define', material: green });
    const after = apply(withGreen, { type: 'room.setWallFinish', roomId: 'sejour', materialId: 'paint-green' });
    const d = SceneDiff.parse(diffScenes(withGreen, after));
    const room = d.changes.find((c) => c.kind === 'room')!;
    expect(room).toMatchObject({ id: 'sejour', change: 'modified', label: charme.rooms.find((r) => r.id === 'sejour')!.name });
    expect(room.fields).toEqual([{ field: 'wallFinish', after: 'paint-green' }]);
    expect(d.text).toContain('room modified');
    expect(d.text).toContain(room.label!);
    expect(d.summary.added).toBe(0);
  });

  it('reports materials added and scoped wall finishes with dotted paths', () => {
    const withGreen = apply(charme, { type: 'material.define', material: green });
    expect(diffScenes(charme, withGreen)).toMatchObject({
      changes: [{ kind: 'material', id: 'paint-green', change: 'added', label: 'Green' }],
      summary: { added: 1, removed: 0, modified: 0 },
    });
    const after = apply(withGreen, { type: 'wall.setFinish', wallId: 'w-west', side: 'right', materialId: 'paint-green', roomId: 'sejour' });
    const w = diffScenes(withGreen, after).changes.find((c) => c.kind === 'wall' && c.id === 'w-west')!;
    expect(w.fields).toEqual([{ field: 'roomFinishes.sejour.right', after: 'paint-green' }]);
    // and back
    expect(diffScenes(after, withGreen).changes.find((c) => c.id === 'w-west')!.fields).toEqual([
      { field: 'roomFinishes.sejour.right', before: 'paint-green' },
    ]);
  });

  it('covers structural, lights, site and defaults, and removals', () => {
    const after: Scene = {
      ...charme,
      walls: charme.walls.map((w) => (w.id === 'w-alcove' ? { ...w, structural: true } : w)).filter((w) => w.id !== 'w-balcony-screen'),
      lights: charme.lights.map((l) => (l.id === 'l-sejour' ? { ...l, lumens: 100, on: false } : l)),
      site: { ...charme.site, northAngle: 10 },
      defaults: { ...charme.defaults, floor: undefined },
    };
    const d = diffScenes(charme, after);
    const pick = (kind: string, id: string) => d.changes.find((c) => c.kind === kind && c.id === id)!;
    expect(pick('wall', 'w-alcove').fields).toEqual([{ field: 'structural', after: true }]);
    expect(pick('wall', 'w-balcony-screen').change).toBe('removed');
    expect(pick('light', 'l-sejour').fields.map((f) => f.field)).toEqual(['lumens', 'on']);
    expect(pick('site', 'site').fields).toEqual([{ field: 'northAngle', before: 355.5, after: 10 }]);
    expect(pick('defaults', 'defaults').fields).toEqual([{ field: 'floor', before: 'lib-parquet-light-oak' }]);
    // deterministic order: kind order then id
    const kinds = d.changes.map((c) => c.kind);
    expect(kinds).toEqual(['wall', 'wall', 'light', 'site', 'defaults']);
  });

  it('caps at 50 entries, flags truncated and still counts everything', () => {
    const after: Scene = { ...charme, rooms: charme.rooms, walls: [...charme.walls] };
    const extra = Array.from({ length: 70 }, (_, i) => ({ id: `m-${String(i).padStart(2, '0')}`, name: `M${i}`, kind: 'paint' as const, color: '#112233', roughness: 0.5 }));
    const d = diffScenes(charme, { ...after, materials: [...charme.materials, ...extra] });
    expect(d.changes).toHaveLength(DIFF_MAX_ENTRIES);
    expect(d.truncated).toBe(true);
    expect(d.summary.added).toBe(70);
    expect(d.text).toContain('more not listed');
    expect(diffScenes(charme, charme).truncated).toBeUndefined();
  });
});
