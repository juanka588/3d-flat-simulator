import { describe, expect, it } from 'vitest';
import { applyCommand, type ApplyOk } from './apply';
import { canCutOpening, canRemoveWall } from './guards';
import { FIXTURES, deepFreeze, env } from './testUtil';
import type { Command } from './schema';
import { Scene } from '../schema';

const charme = FIXTURES.charme!;
const ok = (scene: typeof charme, cmd: Command): ApplyOk => {
  const r = applyCommand(deepFreeze(scene), deepFreeze(env(cmd)));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const green = { id: 'paint-green', name: 'Green', kind: 'paint' as const, color: '#00aa00', roughness: 0.9 };

describe('applyCommand', () => {
  it('wall.setFinish changes one wall, shares the rest, and undoes exactly', () => {
    const r = ok(charme, { type: 'wall.setFinish', wallId: 'w-north', side: 'right', materialId: 'floor-tile' });
    expect(r.scene.walls.find((w) => w.id === 'w-north')!.finish.right).toBe('floor-tile');
    expect(r.scene.walls[1]).toBe(charme.walls[1]);
    expect(r.scene.rooms).toBe(charme.rooms);
    expect(r.changed.walls).toEqual(['w-north']);
    const back = ok(r.scene, r.inverse);
    expect(back.scene).toEqual(charme);
  });

  it('reports unknown ids with nearest suggestions', () => {
    const r = applyCommand(charme, env({ type: 'wall.setFinish', wallId: 'w-nort', side: 'left', materialId: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.code).toBe('unknown_entity');
      expect(r.errors[0]!.hint).toContain('w-north');
    }
    const m = applyCommand(charme, env({ type: 'wall.setFinish', wallId: 'w-north', side: 'left', materialId: 'paint-sag' }));
    expect(!m.ok && m.errors[0]!.code).toBe('unknown_material');
    expect(!m.ok && m.errors[0]!.hint).toContain('paint-white');
  });

  it('no-ops are ok with an empty inverse', () => {
    const r = ok(charme, { type: 'wall.setFinish', wallId: 'w-north', side: 'left', materialId: 'facade' });
    expect(r.noop).toBe(true);
    expect(r.scene).toBe(charme);
    expect(r.inverse).toEqual({ type: 'batch', label: 'noop', commands: [] });
  });

  it('material.define is an idempotent upsert and rejects kind changes', () => {
    const a = ok(charme, { type: 'material.define', material: green });
    expect(a.scene.materials).toHaveLength(charme.materials.length + 1);
    expect(ok(a.scene, { type: 'material.define', material: green }).noop).toBe(true);
    const upd = ok(a.scene, { type: 'material.define', material: { ...green, color: '#112233' } });
    expect(ok(upd.scene, upd.inverse).scene).toEqual(a.scene);
    const bad = applyCommand(a.scene, env({ type: 'material.define', material: { ...green, kind: 'texture', textureUrl: 'lib:oak' } }));
    expect(!bad.ok && bad.errors[0]!.code).toBe('precondition_failed');
    expect(ok(a.scene, a.inverse).scene).toEqual(charme);
  });

  it('material.remove refuses used materials', () => {
    const r = applyCommand(charme, env({ type: 'material.remove', id: 'paint-white' }));
    expect(r.ok === false || charme.defaults.wall !== 'paint-white').toBe(true);
  });

  it('textureUrl accepts lib: and relative paths only', () => {
    const t = (u: string) => applyCommand(charme, env({ type: 'material.define', material: { ...green, kind: 'texture', textureUrl: u } })).ok;
    expect(t('lib:oak-parquet')).toBe(true);
    expect(t('materials/oak/')).toBe(true);
    expect(t('https://evil.example/x')).toBe(false);
    expect(t('/abs/path')).toBe(false);
    expect(t('../up')).toBe(false);
    expect(t('data:image/png;base64,AAAA')).toBe(false);
  });

  it('room.setWallFinish sets room.wallFinish, clears full sides, leaves shared sides, undoes exactly', () => {
    const pre = ok(charme, { type: 'wall.setFinish', wallId: 'w-north', side: 'right', materialId: 'paint-white' });
    const r = ok(pre.scene, { type: 'room.setWallFinish', roomId: 'ch2', materialId: 'floor-tile' });
    expect(r.scene.rooms.find((x) => x.id === 'ch2')!.wallFinish).toBe('floor-tile');
    expect(r.warnings.map((w) => w.code)).toEqual(['shared_wall_side_override']);
    // shared side untouched, other rooms untouched
    expect(r.scene.walls.find((w) => w.id === 'w-north')!.finish.right).toBe('paint-white');
    expect(r.scene.rooms.find((x) => x.id === 'sejour')!.wallFinish).toBeUndefined();
    expect(ok(r.scene, r.inverse).scene).toEqual(pre.scene);
    // explicit finish on a full side is cleared, and restored on undo
    const withFull = ok(charme, { type: 'wall.setFinish', wallId: 'w-ch2-ch1', side: 'right', materialId: 'paint-white' });
    const r2 = ok(withFull.scene, { type: 'room.setWallFinish', roomId: 'ch2', materialId: 'floor-tile' });
    expect(r2.scene.walls.find((w) => w.id === 'w-ch2-ch1')!.finish.right).toBeUndefined();
    expect(r2.changed.walls).toContain('w-ch2-ch1');
    expect(ok(r2.scene, r2.inverse).scene).toEqual(withFull.scene);
    // clearing
    const cleared = ok(r2.scene, { type: 'room.setWallFinish', roomId: 'ch2', materialId: null });
    expect(cleared.scene.rooms.find((x) => x.id === 'ch2')!.wallFinish).toBeUndefined();
    expect(ok(cleared.scene, cleared.inverse).scene).toEqual(r2.scene);
  });

  it('room.setWallFinish on an unwalled room gives no_wall_sides', () => {
    const scene = { ...charme, rooms: [...charme.rooms, { id: 'ghost', name: 'g', type: 'other' as const, polygon: [[20, 20], [22, 20], [22, 22]] as [number, number][] }] };
    const r = applyCommand(scene, env({ type: 'room.setWallFinish', roomId: 'ghost', materialId: null }));
    expect(!r.ok && r.errors[0]!.code).toBe('no_wall_sides');
  });

  it('floor, ceiling, defaults, site, structural round-trip', () => {
    for (const cmd of [
      { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' },
      { type: 'room.setCeiling', roomId: 'sejour', materialId: 'ceiling-white' },
      { type: 'scene.setDefaults', wall: 'floor-tile', floor: null },
      { type: 'site.set', site: { northAngle: 33, address: '1 rue X' } },
      { type: 'wall.setStructural', wallId: 'w-alcove', structural: true },
      { type: 'wall.setStructural', wallId: 'w-north', structural: false },
    ] as Command[]) {
      const r = ok(charme, cmd);
      expect(r.noop, JSON.stringify(cmd)).toBeUndefined();
      expect(ok(r.scene, r.inverse).scene).toEqual(charme);
      expect(Scene.safeParse(r.scene).success).toBe(true);
    }
  });

  it('lights: add derives ids deterministically, update and remove invert', () => {
    const cmd: Command = { type: 'light.add', light: { type: 'point', position: [1, 1], elevation: 2, lumens: 800 } };
    const a = ok(charme, cmd);
    const id = a.scene.lights.at(-1)!.id;
    expect(id).toBe(`light-${charme.lights.length + 1}`);
    expect(ok(charme, cmd).scene).toEqual(a.scene);
    expect(ok(a.scene, a.inverse).scene).toEqual(charme);
    const u = ok(a.scene, { type: 'light.update', id, patch: { on: false, name: 'x' } });
    expect(ok(u.scene, u.inverse).scene).toEqual(a.scene);
    const bad = applyCommand(a.scene, env({ type: 'light.update', id, patch: { width: 2 } }));
    expect(bad.ok).toBe(false);
    const first = charme.lights[0]!;
    const rm = ok(charme, { type: 'light.remove', id: first.id });
    expect(ok(rm.scene, rm.inverse).scene).toEqual(charme);
  });

  it('batch is atomic with commands/N paths, one inverse', () => {
    const good: Command = { type: 'wall.setFinish', wallId: 'w-north', side: 'both', materialId: 'floor-tile' };
    const bad: Command = { type: 'wall.setFinish', wallId: 'nope', side: 'both', materialId: null };
    const r = applyCommand(charme, env({ type: 'batch', label: 'b', commands: [good, bad] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.path).toMatch(/^commands\/1\//);
    const g = ok(charme, { type: 'batch', label: 'b', commands: [good, { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' }] });
    expect(ok(g.scene, g.inverse).scene).toEqual(charme);
  });

  it('ifRev mismatch fails', () => {
    const r = applyCommand(charme, env({ type: 'batch', label: 'x', commands: [] }, { ifRev: 3 }), { rev: 4 });
    expect(!r.ok && r.errors[0]!.code).toBe('precondition_failed');
  });

  it('structural guards', () => {
    const r = canRemoveWall(charme, 'w-north');
    expect(r).toMatchObject({ ok: false, code: 'precondition_failed', hint: 'structural wall' });
    expect(canRemoveWall(charme, 'w-alcove')).toEqual({ ok: true });
    expect(canCutOpening(charme, 'w-west')).toMatchObject({ ok: false, hint: 'structural wall' });
    expect(canRemoveWall(charme, 'zzz')).toMatchObject({ ok: false, code: 'unknown_entity' });
  });
});

describe('wallStats with room-scoped finishes', () => {
  it('reports mixed faces on a shared side', async () => {
    const { wallStats } = await import('../stats');
    const r = ok(charme, { type: 'room.setWallFinish', roomId: 'sejour', materialId: 'floor-tile' });
    const s = wallStats(r.scene, 'w-south')!;
    expect(s.mixed.right).toBe(true);
    expect(s.faces.right.some((f) => f.roomId === 'sejour' && f.material === 'floor-tile')).toBe(true);
    expect(s.faces.right.some((f) => f.roomId === 'sdb' && f.material !== 'floor-tile')).toBe(true);
    expect(wallStats(charme, 'w-south')!.mixed.right).toBe(false);
  });
});
