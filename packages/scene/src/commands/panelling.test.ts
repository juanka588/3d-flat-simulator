import { describe, expect, it } from 'vitest';
import { parseScene } from '../parse';
import { Scene } from '../schema';
import { serializeScene } from '../serialize';
import { applyCommand, type ApplyOk } from './apply';
import { createHistory, recordCommand, redo, undo } from './history';
import type { Command } from './schema';
import { FIXTURES, deepFreeze, env } from './testUtil';

const charme = FIXTURES.charme!;
const ok = (scene: Scene, cmd: Command): ApplyOk => {
  const r = applyCommand(deepFreeze(scene), deepFreeze(env(cmd)));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const fail = (scene: Scene, cmd: Command) => {
  const r = applyCommand(scene, env(cmd));
  if (r.ok) throw new Error('expected a failure');
  return r.errors[0]!;
};
const define = (id: string): Command => ({ type: 'material.define', material: { id, name: id, kind: 'paint', color: '#aabbcc', roughness: 0.9 } });
const wallOf = (s: Scene, id: string) => s.walls.find((w) => w.id === id)!;
const roomOf = (s: Scene, id: string) => s.rooms.find((r) => r.id === id)!;

describe('wall.setFinish panelling', () => {
  const cmd = { type: 'wall.setFinish', wallId: 'w-north', side: 'right', panelling: 'frames+dado', panelColour: '#ffffff' } as const;

  it('sets the mouldings on one side and undoes exactly', () => {
    const r = ok(charme, cmd);
    const wall = wallOf(r.scene, 'w-north');
    expect(wall.panelling).toStrictEqual({ right: { style: 'frames+dado', colour: '#ffffff' } });
    expect(wall.finish).toStrictEqual(wallOf(charme, 'w-north').finish);
    expect(r.changed.walls).toEqual(['w-north']);
    expect(ok(r.scene, r.inverse).scene).toStrictEqual(charme);
    expect(Scene.safeParse(r.scene).success).toBe(true);
  });

  it('both sides, null removes (and drops the empty record), same value is a noop', () => {
    const both = ok(charme, { ...cmd, side: 'both' });
    expect(Object.keys(wallOf(both.scene, 'w-north').panelling!)).toEqual(['left', 'right']);
    expect(ok(both.scene, both.inverse).scene).toStrictEqual(charme);
    const cleared = ok(both.scene, { type: 'wall.setFinish', wallId: 'w-north', side: 'both', panelling: null });
    expect('panelling' in wallOf(cleared.scene, 'w-north')).toBe(false);
    expect(ok(cleared.scene, cleared.inverse).scene).toStrictEqual(both.scene);
    expect(ok(both.scene, { ...cmd, side: 'both' }).noop).toBe(true);
  });

  it('changing the style or colour keeps the rest and undoes to the exact previous mouldings', () => {
    const a = ok(charme, cmd);
    const b = ok(a.scene, { type: 'wall.setFinish', wallId: 'w-north', side: 'right', panelling: 'dado', panelColour: null });
    expect(wallOf(b.scene, 'w-north').panelling).toStrictEqual({ right: { style: 'dado' } });
    expect(ok(b.scene, b.inverse).scene).toStrictEqual(a.scene);
    const c = ok(a.scene, { type: 'wall.setFinish', wallId: 'w-north', side: 'right', panelColour: '#eeeeee' });
    expect(wallOf(c.scene, 'w-north').panelling?.right).toStrictEqual({ style: 'frames+dado', colour: '#eeeeee' });
    expect(ok(c.scene, c.inverse).scene).toStrictEqual(a.scene);
  });

  it('keeps sizes written in a file when the style changes', () => {
    const sized = { ...charme, rooms: charme.rooms.map((r) => (r.id === 'sejour' ? { ...r, panelling: { style: 'frames' as const, depthMm: 30, dadoHeightMm: 1000 } } : r)) };
    const r = ok(sized, { type: 'room.setWallFinish', roomId: 'sejour', panelling: 'dado' });
    expect(roomOf(r.scene, 'sejour').panelling).toStrictEqual({ style: 'dado', depthMm: 30, dadoHeightMm: 1000 });
    expect(ok(r.scene, r.inverse).scene).toStrictEqual(sized);
  });

  it('combines with paint in one command and undoes both', () => {
    const withMat = ok(charme, define('m')).scene;
    const r = ok(withMat, { ...cmd, materialId: 'm' });
    const wall = wallOf(r.scene, 'w-north');
    expect(wall.finish.right).toBe('m');
    expect(wall.panelling?.right?.style).toBe('frames+dado');
    expect(ok(r.scene, r.inverse).scene).toStrictEqual(withMat);
  });

  it('needs a material or panelling, a known wall, and mouldings before a colour', () => {
    expect(fail(charme, { type: 'wall.setFinish', wallId: 'w-north', side: 'left' })).toMatchObject({ code: 'invalid_command' });
    expect(fail(charme, { ...cmd, wallId: 'nope' })).toMatchObject({ code: 'unknown_entity' });
    expect(fail(charme, { type: 'wall.setFinish', wallId: 'w-north', side: 'left', panelColour: '#ffffff' })).toMatchObject({ code: 'precondition_failed', path: 'panelColour' });
  });

  it('rejects unknown styles and bad colours', () => {
    expect(applyCommand(charme, env({ type: 'wall.setFinish', wallId: 'w-north', side: 'left', panelling: 'baroque' } as unknown as Command)).ok).toBe(false);
    expect(applyCommand(charme, env({ ...cmd, panelColour: 'white' })).ok).toBe(false);
  });

  it('undo and redo through history', () => {
    const e = env(cmd);
    const result = applyCommand(charme, e);
    if (!result.ok) throw new Error('apply failed');
    const history = recordCommand(createHistory(), e, result);
    const ctx = { id: 'u1', ts: 5000, author: { kind: 'user' as const } };
    const u = undo(history, result.scene, ctx);
    expect(u.ok && u.scene).toStrictEqual(charme);
    if (!u.ok) return;
    const again = redo(u.history, u.scene, { ...ctx, id: 'r1' });
    expect(again.ok && again.scene).toStrictEqual(result.scene);
  });
});

describe('room.setWallFinish panelling and cornice', () => {
  it('sets room mouldings and a cornice without touching paint, and undoes', () => {
    const r = ok(charme, { type: 'room.setWallFinish', roomId: 'sejour', panelling: 'frames', corniceMm: 100 });
    const room = roomOf(r.scene, 'sejour');
    expect(room.panelling).toStrictEqual({ style: 'frames' });
    expect(room.cornice).toStrictEqual({ heightMm: 100 });
    expect(room.wallFinish).toBe(roomOf(charme, 'sejour').wallFinish);
    expect(ok(r.scene, r.inverse).scene).toStrictEqual(charme);
    const cleared = ok(r.scene, { type: 'room.setWallFinish', roomId: 'sejour', corniceMm: null });
    expect(roomOf(cleared.scene, 'sejour').cornice).toBeUndefined();
    expect(roomOf(cleared.scene, 'sejour').panelling).toStrictEqual({ style: 'frames' });
    expect(ok(cleared.scene, cleared.inverse).scene).toStrictEqual(r.scene);
  });

  it('paint plus mouldings together undo to the original', () => {
    const withMat = ok(charme, define('m')).scene;
    const r = ok(withMat, { type: 'room.setWallFinish', roomId: 'sejour', materialId: 'm', panelling: 'dado' });
    expect(roomOf(r.scene, 'sejour').wallFinish).toBe('m');
    expect(ok(r.scene, r.inverse).scene).toStrictEqual(withMat);
  });

  it('needs something to change', () => {
    expect(fail(charme, { type: 'room.setWallFinish', roomId: 'sejour' })).toMatchObject({ code: 'invalid_command' });
  });
});

describe('schema round trip', () => {
  it('keeps panelling, cornice and a floor pattern through serialize and parse; old files are untouched', () => {
    const a = ok(charme, { type: 'wall.setFinish', wallId: 'w-north', side: 'right', panelling: 'frames' }).scene;
    const b = ok(a, { type: 'room.setWallFinish', roomId: 'sejour', corniceMm: 90 }).scene;
    const material = { id: 'parquet', name: 'Chevron', kind: 'paint', color: '#a47a4d', roughness: 0.5, pattern: 'chevron', plankWidthMm: 80 } as const;
    const withAll = ok(b, { type: 'material.define', material }).scene;
    const parsed = parseScene(JSON.parse(serializeScene(withAll)));
    expect(parsed.ok && serializeScene(parsed.scene)).toBe(serializeScene(withAll));
    expect(parsed.ok && wallOf(parsed.scene, 'w-north').panelling?.right?.style).toBe('frames');
    expect(parsed.ok && parsed.scene.materials.find((m) => m.id === 'parquet')?.pattern).toBe('chevron');
    expect(JSON.stringify(charme)).not.toContain('panelling');
    expect(Scene.safeParse(JSON.parse(serializeScene(charme))).success).toBe(true);
  });

  it('a pattern needs a paint material', () => {
    const material = { id: 'x', name: 'x', kind: 'texture', color: '#ffffff', roughness: 1, textureUrl: 'lib:oak', pattern: 'herringbone' };
    expect(Scene.safeParse({ ...charme, materials: [...charme.materials, material] }).success).toBe(false);
  });
});
