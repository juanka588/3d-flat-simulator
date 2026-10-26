import { describe, expect, it } from 'vitest';
import { applyCommand } from './apply';
import { canRedo, canUndo, clearHistory, createHistory, recordCommand, redo, undo, type History } from './history';
import { FIXTURES, env } from './testUtil';
import type { Command, LeafCommand } from './schema';

const base = FIXTURES.charme!;
const author = { kind: 'user' as const };
const paint = (m: string | null): LeafCommand => ({ type: 'wall.setFinish', wallId: 'w-north', side: 'both', materialId: m });

function run(h: History, scene: typeof base, cmd: Command, extra: Parameters<typeof env>[1] = {}, now?: number) {
  const e = env(cmd, extra);
  const r = applyCommand(scene, e);
  return { h: recordCommand(h, e, r, now), scene: r.ok ? r.scene : scene, r };
}
let n = 0;
const ctx = () => ({ id: `u${++n}`, ts: 5000 + n, author });

describe('history', () => {
  it('undo/redo round trip, new command clears future, failures not recorded', () => {
    let s = run(createHistory(), base, paint('floor-tile'));
    s = run(s.h, s.scene, { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' });
    const bad = run(s.h, s.scene, paint('nope'));
    expect(bad.h.past).toHaveLength(2);
    const u1 = undo(s.h, s.scene, ctx());
    if (!u1.ok) throw new Error('undo');
    expect(canRedo(u1.history)).toBe(true);
    expect(u1.envelope.undoOf).toBe(s.h.past[1]!.envelope.id);
    const u2 = undo(u1.history, u1.scene, ctx());
    if (!u2.ok) throw new Error('undo');
    expect(u2.scene).toEqual(base);
    expect(canUndo(u2.history)).toBe(false);
    expect(undo(u2.history, u2.scene, ctx()).ok).toBe(false);
    const r1 = redo(u2.history, u2.scene, ctx());
    if (!r1.ok) throw new Error('redo');
    expect(r1.history.past).toHaveLength(1);
    const fresh = run(r1.history, r1.scene, paint(null));
    expect(fresh.h.future).toHaveLength(0);
    expect(clearHistory(fresh.h).past).toHaveLength(0);
  });

  it('batch is one entry', () => {
    const s = run(createHistory(), base, { type: 'batch', label: 'b', commands: [paint('floor-tile'), { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' }] });
    expect(s.h.past).toHaveLength(1);
    const u = undo(s.h, s.scene, ctx());
    expect(u.ok && u.scene).toEqual(base);
  });

  it('coalesces by key, author and window; redo applies the final value', () => {
    let s = run(createHistory(), base, paint('floor-tile'), { coalesceKey: 'drag' }, 100);
    s = run(s.h, s.scene, paint('paint-white'), { coalesceKey: 'drag' }, 500);
    expect(s.h.past).toHaveLength(1);
    s = run(s.h, s.scene, paint('floor-tile'), { coalesceKey: 'drag' }, 5000);
    expect(s.h.past).toHaveLength(2);
    s = run(s.h, s.scene, paint('paint-white'), { coalesceKey: 'drag', author: { kind: 'llm' } }, 5100);
    expect(s.h.past).toHaveLength(3);
    const u = undo(s.h, s.scene, ctx());
    if (!u.ok) throw new Error('x');
    const u2 = undo(u.history, u.scene, ctx());
    const u3 = u2.ok ? undo(u2.history, u2.scene, ctx()) : u2;
    expect(u3.ok && u3.scene).toEqual(base);
    expect(u3.ok && redo(u3.history, u3.scene, ctx()).ok).toBe(true);
  });

  it('caps at 200', () => {
    let s = { h: createHistory(), scene: base };
    for (let i = 0; i < 230; i++) s = run(s.h, s.scene, { type: 'site.set', site: { northAngle: i + 1 } });
    expect(s.h.past).toHaveLength(200);
  });
});
