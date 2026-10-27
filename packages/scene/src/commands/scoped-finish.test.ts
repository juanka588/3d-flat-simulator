import { describe, expect, it } from 'vitest';
import { wallFaceMaterial } from '../geometry/materials';
import { Scene } from '../schema';
import { wallStats } from '../stats';
import { applyCommand, type ApplyOk } from './apply';
import type { Command, LeafCommand } from './schema';
import { FIXTURES, deepFreeze, env } from './testUtil';

const charme = FIXTURES.charme!;
const ok = (scene: Scene, cmd: Command): ApplyOk => {
  const r = applyCommand(deepFreeze(scene), deepFreeze(env(cmd)));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const mat = (id: string, color: string): LeafCommand => ({ type: 'material.define', material: { id, name: id, kind: 'paint', color, roughness: 0.9 } });
const withMats = ok(charme, { type: 'batch', label: 'm', commands: [mat('m-red', '#aa0000'), mat('m-blue', '#0000aa'), mat('m-green', '#00aa00')] }).scene;
const face = (s: Scene, wallId: string, side: 'left' | 'right', room: string) => wallFaceMaterial(s, s.walls.find((w) => w.id === wallId)!, side, room);
const paint = (wallId: string, side: 'left' | 'right' | 'both', materialId: string | null, roomId?: string): LeafCommand => ({
  type: 'wall.setFinish', wallId, side, materialId, ...(roomId ? { roomId } : {}),
});

describe('room-scoped wall finishes', () => {
  it('painting w-west right in the sejour leaves the alcove stretch alone', () => {
    const before = face(withMats, 'w-west', 'right', 'alcove');
    const r = ok(withMats, paint('w-west', 'right', 'm-red', 'sejour'));
    expect(face(r.scene, 'w-west', 'right', 'sejour')).toBe('m-red');
    expect(face(r.scene, 'w-west', 'right', 'alcove')).toBe(before);
    expect(r.scene.walls.find((w) => w.id === 'w-west')!.finish).toStrictEqual({ left: 'facade' });
    expect(r.scene.walls.find((w) => w.id === 'w-west')!.roomFinishes).toStrictEqual({ sejour: { right: 'm-red' } });
    const faces = wallStats(r.scene, 'w-west')!.faces.right;
    expect(faces.find((f) => f.roomId === 'sejour')!.material).toBe('m-red');
    expect(faces.find((f) => f.roomId === 'alcove')!.material).toBe(before);
    expect(ok(r.scene, r.inverse).scene).toStrictEqual(withMats);
  });

  it('painting w-north right in ch1 leaves the alcove and ch2 stretches alone', () => {
    const r = ok(withMats, paint('w-north', 'right', 'm-blue', 'ch1'));
    expect(face(r.scene, 'w-north', 'right', 'ch1')).toBe('m-blue');
    for (const room of ['alcove', 'ch2', 'balcon']) expect(face(r.scene, 'w-north', 'right', room)).toBe(face(withMats, 'w-north', 'right', room));
    expect(ok(r.scene, r.inverse).scene).toStrictEqual(withMats);
  });

  it('both sides of w-alcove can take different colours per room', () => {
    const a = ok(withMats, paint('w-alcove', 'both', 'm-red', 'sejour'));
    const b = ok(a.scene, paint('w-alcove', 'both', 'm-blue', 'alcove'));
    // the sejour is on the right of w-alcove and the alcove on its left
    expect(face(b.scene, 'w-alcove', 'right', 'sejour')).toBe('m-red');
    expect(face(b.scene, 'w-alcove', 'left', 'alcove')).toBe('m-blue');
    expect(b.scene.walls.find((w) => w.id === 'w-alcove')!.roomFinishes).toStrictEqual({
      sejour: { right: 'm-red' }, alcove: { left: 'm-blue' },
    });
    expect(a.inverse).toStrictEqual(paint('w-alcove', 'right', null, 'sejour'));
    expect(ok(b.scene, b.inverse).scene).toStrictEqual(a.scene);
    expect(Scene.safeParse(b.scene).success).toBe(true);
  });

  it('refuses a room that does not border the side, and unknown rooms', () => {
    const wrongSide = applyCommand(withMats, env(paint('w-west', 'left', 'm-red', 'sejour')));
    expect(!wrongSide.ok && wrongSide.errors[0]).toMatchObject({ code: 'precondition_failed', path: 'roomId' });
    expect(!wrongSide.ok && wrongSide.errors[0]!.message).toContain('sejour');
    expect(!wrongSide.ok && wrongSide.errors[0]!.hint).toContain('"alcove"');
    const far = applyCommand(withMats, env(paint('w-sdb-east', 'both', 'm-red', 'ch1')));
    expect(!far.ok && far.errors[0]!.code).toBe('precondition_failed');
    const ghost = applyCommand(withMats, env(paint('w-west', 'right', 'm-red', 'nope')));
    expect(!ghost.ok && ghost.errors[0]!.code).toBe('unknown_entity');
  });

  it('a whole-side finish and a scoped finish coexist; scoped wins; null clears scoped only', () => {
    const whole = ok(withMats, paint('w-west', 'right', 'm-green'));
    const scoped = ok(whole.scene, paint('w-west', 'right', 'm-red', 'sejour'));
    expect(face(scoped.scene, 'w-west', 'right', 'sejour')).toBe('m-red');
    expect(face(scoped.scene, 'w-west', 'right', 'alcove')).toBe('m-green');
    const cleared = ok(scoped.scene, paint('w-west', 'right', null, 'sejour'));
    expect(cleared.scene).toStrictEqual(whole.scene);
    expect('roomFinishes' in cleared.scene.walls.find((w) => w.id === 'w-west')!).toBe(false);
  });

  it('room.setWallFinish after a per-wall paint: the room wins and the neighbours keep their look', () => {
    const wall = ok(withMats, paint('w-west', 'right', 'm-red', 'sejour'));
    const whole = ok(wall.scene, paint('w-alcove', 'right', 'm-green'));
    const roomPaint = ok(whole.scene, { type: 'room.setWallFinish', roomId: 'sejour', materialId: 'm-blue' });
    for (const [w, side] of [['w-west', 'right'], ['w-alcove', 'right']] as const) expect(face(roomPaint.scene, w, side, 'sejour')).toBe('m-blue');
    // the alcove keeps what it showed on the shared w-west stretch
    expect(face(roomPaint.scene, 'w-west', 'right', 'alcove')).toBe(face(whole.scene, 'w-west', 'right', 'alcove'));
    expect(roomPaint.scene.walls.find((w) => w.id === 'w-west')!.roomFinishes).toBeUndefined();
    expect(ok(roomPaint.scene, roomPaint.inverse).scene).toStrictEqual(whole.scene);
  });

  it('a per-wall paint after room.setWallFinish: the wall wins, whole-side or scoped', () => {
    const roomPaint = ok(withMats, { type: 'room.setWallFinish', roomId: 'sejour', materialId: 'm-blue' });
    const scoped = ok(roomPaint.scene, paint('w-west', 'right', 'm-red', 'sejour'));
    expect(face(scoped.scene, 'w-west', 'right', 'sejour')).toBe('m-red');
    expect(face(scoped.scene, 'w-south', 'right', 'sejour')).toBe('m-blue');
    const whole = ok(roomPaint.scene, paint('w-alcove', 'right', 'm-green'));
    expect(face(whole.scene, 'w-alcove', 'right', 'sejour')).toBe('m-green');
  });

  it('a shared whole-side finish keeps showing in the other rooms after one room paints over it', () => {
    const shared = ok(withMats, paint('w-north', 'right', 'm-green'));
    const r = ok(shared.scene, { type: 'room.setWallFinish', roomId: 'ch1', materialId: 'm-red' });
    expect(face(r.scene, 'w-north', 'right', 'ch1')).toBe('m-red');
    for (const room of ['alcove', 'ch2', 'balcon']) expect(face(r.scene, 'w-north', 'right', room)).toBe('m-green');
    expect(ok(r.scene, r.inverse).scene).toStrictEqual(shared.scene);
  });

  it('batches of scoped paints undo exactly', () => {
    const r = ok(withMats, {
      type: 'batch', label: 'scoped',
      commands: [paint('w-west', 'right', 'm-red', 'sejour'), paint('w-west', 'right', 'm-blue', 'sejour'), paint('w-west', 'right', 'm-green', 'alcove'),
        { type: 'room.setWallFinish', roomId: 'sejour', materialId: 'm-green' }, paint('w-alcove', 'both', 'm-red', 'sejour')],
    });
    expect(ok(r.scene, r.inverse).scene).toStrictEqual(withMats);
  });

  it('schema rejects roomFinishes for unknown rooms and materials', () => {
    const wall = charme.walls[0]!;
    const bad = (rf: unknown) => Scene.safeParse({ ...charme, walls: [{ ...wall, roomFinishes: rf }, ...charme.walls.slice(1)] }).success;
    expect(bad({ sejour: { left: 'paint-white' } })).toBe(true);
    expect(bad({ nope: { left: 'paint-white' } })).toBe(false);
    expect(bad({ sejour: { left: 'nope' } })).toBe(false);
  });
});
