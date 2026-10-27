import { describe, expect, it } from 'vitest';
import { applyCommand } from './apply';
import { canRedo, canUndo, clearHistory, coalesceSignature, createHistory, dropEntry, recordCommand, redo, undo, type History } from './history';
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
    expect(u2.scene).toStrictEqual(base);
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
    expect(u.ok && u.scene).toStrictEqual(base);
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
    expect(u3.ok && u3.scene).toStrictEqual(base);
    expect(u3.ok && redo(u3.history, u3.scene, ctx()).ok).toBe(true);
  });

  it('caps at 200', () => {
    let s = { h: createHistory(), scene: base };
    for (let i = 0; i < 230; i++) s = run(s.h, s.scene, { type: 'site.set', site: { northAngle: i + 1 } });
    expect(s.h.past).toHaveLength(200);
  });

  describe('coalescing only merges commands that overwrite the same fields (C1)', () => {
    const undoAll = (h: History, scene: typeof base) => {
      let cur = { h, scene };
      while (canUndo(cur.h)) {
        const u = undo(cur.h, cur.scene, ctx());
        if (!u.ok) throw new Error('undo failed');
        cur = { h: u.history, scene: u.scene };
      }
      return cur.scene;
    };

    it('different site fields under one key stay separate and undo restores both', () => {
      let s = run(createHistory(), base, { type: 'site.set', site: { latitude: 10 } }, { coalesceKey: 'site.set' }, 100);
      s = run(s.h, s.scene, { type: 'site.set', site: { northAngle: 77 } }, { coalesceKey: 'site.set' }, 200);
      expect(s.h.past).toHaveLength(2);
      expect(undoAll(s.h, s.scene)).toStrictEqual(base);
      const one = undo(s.h, s.scene, ctx());
      expect(one.ok && one.scene.site.northAngle).toBe(base.site.northAngle);
      expect(one.ok && one.scene.site.latitude).toBe(10);
    });

    it('the same field keeps merging, with the oldest inverse', () => {
      let s = run(createHistory(), base, { type: 'site.set', site: { latitude: 10 } }, { coalesceKey: 'site.set:latitude' }, 100);
      s = run(s.h, s.scene, { type: 'site.set', site: { latitude: 20 } }, { coalesceKey: 'site.set:latitude' }, 200);
      s = run(s.h, s.scene, { type: 'site.set', site: { latitude: 30 } }, { coalesceKey: 'site.set:latitude' }, 300);
      expect(s.h.past).toHaveLength(1);
      const u = undo(s.h, s.scene, ctx());
      expect(u.ok && u.scene).toStrictEqual(base);
      const r = u.ok ? redo(u.history, u.scene, ctx()) : u;
      expect(r.ok && r.scene.site.latitude).toBe(30);
    });

    it('different walls (or sides, or rooms) under one drag key do not merge', () => {
      const wall = (id: string, side: 'left' | 'right' | 'both', m: string | null, roomId?: string): Command => ({ type: 'wall.setFinish', wallId: id, side, materialId: m, ...(roomId ? { roomId } : {}) });
      let s = run(createHistory(), base, wall('w-north', 'both', 'floor-tile'), { coalesceKey: 'drag' }, 100);
      s = run(s.h, s.scene, wall('w-south', 'both', 'floor-tile'), { coalesceKey: 'drag' }, 150);
      s = run(s.h, s.scene, wall('w-south', 'left', 'floor-oak'), { coalesceKey: 'drag' }, 160);
      s = run(s.h, s.scene, wall('w-west', 'right', 'floor-oak', 'sejour'), { coalesceKey: 'drag' }, 170);
      s = run(s.h, s.scene, wall('w-west', 'right', 'floor-tile', 'sejour'), { coalesceKey: 'drag' }, 180);
      s = run(s.h, s.scene, wall('w-west', 'right', 'floor-tile', 'alcove'), { coalesceKey: 'drag' }, 190);
      expect(s.h.past).toHaveLength(5);
      expect(undoAll(s.h, s.scene)).toStrictEqual(base);
    });

    it('structural changes (add / remove) never coalesce, and batches compare their members', () => {
      const add: Command = { type: 'light.add', light: { type: 'point', position: [1, 1], elevation: 2, lumens: 100 } };
      let s = run(createHistory(), base, add, { coalesceKey: 'k' }, 100);
      s = run(s.h, s.scene, add, { coalesceKey: 'k' }, 150);
      expect(s.h.past).toHaveLength(2);
      expect(undoAll(s.h, s.scene)).toStrictEqual(base);
      const b1: Command = { type: 'batch', label: 'a', commands: [paint('floor-tile'), { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' }] };
      const b2: Command = { type: 'batch', label: 'b', commands: [paint('paint-white'), { type: 'room.setFloor', roomId: 'ch1', materialId: 'floor-oak' }] };
      let t = run(createHistory(), base, b1, { coalesceKey: 'k' }, 100);
      t = run(t.h, t.scene, b2, { coalesceKey: 'k' }, 150);
      expect(t.h.past).toHaveLength(2);
      expect(coalesceSignature({ type: 'batch', label: 'x', commands: [] })).toBeUndefined();
    });
  });

  describe('un-undoable entries (C2)', () => {
    it('500 side:both commands whose inverse is bigger than 500 still undo and redo', () => {
      const walls = base.walls.slice(0, 10).map((w) => w.id);
      const commands: LeafCommand[] = [];
      for (let i = 0; i < 500; i++) {
        const wallId = walls[i % walls.length]!;
        commands.push(i % 2 === 0
          ? { type: 'wall.setFinish', wallId, side: 'left', materialId: 'floor-tile' }
          : { type: 'wall.setFinish', wallId, side: 'both', materialId: i % 4 === 1 ? 'floor-oak' : 'paint-white' });
      }
      const batch: Command = { type: 'batch', label: 'big', commands };
      const s = run(createHistory(), base, batch);
      expect(s.r.ok).toBe(true);
      const inverse = s.h.past[0]!.inverse;
      expect(inverse.type).toBe('batch');
      // collapsed to at most one command per wall side
      if (inverse.type === 'batch') expect(inverse.commands.length).toBeLessThanOrEqual(walls.length * 2);
      const u = undo(s.h, s.scene, ctx());
      expect(u.ok && u.scene).toStrictEqual(base);
      const r = u.ok ? redo(u.history, u.scene, ctx()) : u;
      expect(r.ok && r.scene).toStrictEqual(s.scene);
    });

    it('the trusted path accepts batches above the external cap; the external path does not', () => {
      const big: Command = {
        type: 'batch',
        label: 'big',
        commands: Array.from({ length: 600 }, (_, i): LeafCommand => ({ type: 'site.set', site: { northAngle: i } })),
      };
      const external = applyCommand(base, env(big));
      expect(!external.ok && external.errors[0]!.code).toBe('invalid_command');
      const trusted = applyCommand(base, env(big), { trusted: true });
      expect(trusted.ok && trusted.scene.site.northAngle).toBe(599);
      // payloads are still validated on the trusted path
      const bad = { ...big, commands: [...(big as { commands: LeafCommand[] }).commands, { type: 'wall.setFinish', wallId: 'w', side: 'up', materialId: null }] } as unknown as Command;
      expect(applyCommand(base, env(bad), { trusted: true }).ok).toBe(false);
    });

    it('truncates long inverse labels to the 200-character limit', () => {
      const label = 'x'.repeat(200);
      const s = run(createHistory(), base, { type: 'batch', label, commands: [paint('floor-tile'), { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' }] });
      const inv = s.h.past[0]!.inverse;
      expect(inv.type === 'batch' && inv.label.length).toBeLessThanOrEqual(200);
      const u = undo(s.h, s.scene, ctx());
      expect(u.ok && u.scene).toStrictEqual(base);
    });

    it('a failing entry reports apply_failed, never wedges silently, and can be dropped explicitly', () => {
      let s = run(createHistory(), base, { type: 'site.set', site: { northAngle: 10 } });
      s = run(s.h, s.scene, paint('floor-tile'));
      // corrupt the newest entry so its inverse can never apply
      const bad: History = {
        ...s.h,
        past: [...s.h.past.slice(0, -1), { ...s.h.past[1]!, inverse: { type: 'wall.setFinish', wallId: 'gone', side: 'both', materialId: null } }],
      };
      const u = undo(bad, s.scene, ctx());
      expect(u.ok).toBe(false);
      if (!u.ok && u.reason === 'apply_failed') {
        expect(u.errors[0]!.code).toBe('unknown_entity');
        expect(u.entryId).toBe(bad.past[1]!.envelope.id);
        expect(u.history).toBe(bad); // nothing was skipped
      } else throw new Error('expected apply_failed');
      // retrying keeps failing: no silent skipping
      expect(undo(bad, s.scene, ctx()).ok).toBe(false);
      // an explicit drop unblocks the entry below it
      const dropped = dropEntry(bad, 'undo');
      expect(dropped.past).toHaveLength(1);
      const next = undo(dropped, s.scene, ctx());
      expect(next.ok).toBe(true);
      // dropping with nothing to drop changes nothing
      expect(dropEntry(createHistory(), 'undo').past).toHaveLength(0);
      expect(dropEntry(createHistory(), 'redo').future).toHaveLength(0);
    });

    it('a failing redo can be dropped too', () => {
      let s = run(createHistory(), base, paint('floor-tile'));
      const u = undo(s.h, s.scene, ctx());
      if (!u.ok) throw new Error('undo');
      const bad: History = { ...u.history, future: [{ ...u.history.future[0]!, envelope: { ...u.history.future[0]!.envelope, cmd: paint('nope') } }] };
      const r = redo(bad, u.scene, ctx());
      expect(!r.ok && r.reason).toBe('apply_failed');
      expect(dropEntry(bad, 'redo').future).toHaveLength(0);
      s = run(dropEntry(bad, 'redo'), u.scene, paint('paint-white'));
      expect(s.h.past).toHaveLength(1);
    });
  });

  describe('locked items and non-user undo / redo', () => {
    const llm = { kind: 'llm' as const, name: 'claude' };
    const cabinet = { assetId: 'param:wardrobe', id: 'cab', position: [7.71, 1] as [number, number], roomId: 'ch1', dims: { w: 0.6, d: 0.6, h: 1 }, locked: true };
    const place = (item: Record<string, unknown>): Command => ({ type: 'item.place', item: item as never });
    const bare = { ...base, items: [] };

    it('an LLM cannot undo the user placing a locked item (nor redo its removal); the user can', () => {
      const s = run(createHistory(), bare, place(cabinet));
      const refused = undo(s.h, s.scene, { id: 'x1', ts: 1, author: llm });
      expect(!refused.ok && refused.reason).toBe('apply_failed');
      if (!refused.ok && refused.reason === 'apply_failed') {
        expect(refused.errors[0]).toMatchObject({ code: 'precondition_failed', hint: 'locked item: ask the user' });
        expect(refused.history).toBe(s.h);
      }
      const byUser = undo(s.h, s.scene, { id: 'x2', ts: 2, author });
      expect(byUser.ok && byUser.scene.items).toHaveLength(0);
      if (!byUser.ok) return;
      // redo of the creation re-creates a locked item: refused for an LLM
      expect(redo(byUser.history, byUser.scene, { id: 'x3', ts: 3, author: llm }).ok).toBe(false);
      expect(redo(byUser.history, byUser.scene, { id: 'x4', ts: 4, author }).ok).toBe(true);
    });

    it('an LLM cannot undo a user move of a locked item; unlocked items stay undoable', () => {
      let s = run(createHistory(), bare, place(cabinet));
      s = run(s.h, s.scene, { type: 'item.move', id: 'cab', position: [7.9, 1] });
      expect(undo(s.h, s.scene, { id: 'm1', ts: 1, author: llm }).ok).toBe(false);
      const free = run(createHistory(), bare, place({ ...cabinet, locked: undefined, id: 'free' }));
      expect(undo(free.h, free.scene, { id: 'm2', ts: 2, author: llm }).ok).toBe(true);
    });

    it('also inside a batch', () => {
      const s = run(createHistory(), bare, { type: 'batch', label: 'b', commands: [place(cabinet) as LeafCommand] });
      expect(undo(s.h, s.scene, { id: 'b1', ts: 1, author: llm }).ok).toBe(false);
    });
  });
});
