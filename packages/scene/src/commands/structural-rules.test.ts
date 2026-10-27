import { describe, expect, it } from 'vitest';
import { applyCommand, reduceCommand } from './apply';
import { createHistory, recordCommand, undo } from './history';
import { FIXTURES, env } from './testUtil';
import type { Author } from './schema';

const charme = FIXTURES.charme!;
const llm: Author = { kind: 'llm', name: 'claude' };
const user: Author = { kind: 'user' };

describe('structural rules in the reducer (C5)', () => {
  it('reserved wall.remove runs the structural guard before answering not_supported', () => {
    const structural = reduceCommand(charme, { type: 'wall.remove', wallId: 'w-north' });
    expect(structural).toMatchObject({ ok: false, errors: [{ code: 'precondition_failed', hint: 'structural wall' }] });
    const partition = reduceCommand(charme, { type: 'wall.remove', wallId: 'w-alcove' });
    expect(partition).toMatchObject({ ok: false, errors: [{ code: 'not_supported' }] });
    const unknown = reduceCommand(charme, { type: 'wall.remove', wallId: 'zzz' });
    expect(unknown).toMatchObject({ ok: false, errors: [{ code: 'unknown_entity' }] });
  });

  it('reserved opening.add runs canCutOpening', () => {
    expect(reduceCommand(charme, { type: 'opening.add', wallId: 'w-west' })).toMatchObject({ ok: false, errors: [{ code: 'precondition_failed', hint: 'structural wall' }] });
    expect(reduceCommand(charme, { type: 'opening.add', wallId: 'w-alcove' })).toMatchObject({ ok: false, errors: [{ code: 'not_supported' }] });
  });

  it('an llm cannot mark a default-structural wall removable', () => {
    const r = applyCommand(charme, env({ type: 'wall.setStructural', wallId: 'w-north', structural: false }, { author: llm }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toMatchObject({ code: 'precondition_failed', hint: 'only a user can mark a structural wall as removable' });
    }
    // a user can; an llm may still protect a wall or clear the mark; thin partitions are not restricted
    expect(applyCommand(charme, env({ type: 'wall.setStructural', wallId: 'w-north', structural: false }, { author: user })).ok).toBe(true);
    expect(applyCommand(charme, env({ type: 'wall.setStructural', wallId: 'w-alcove', structural: true }, { author: llm })).ok).toBe(true);
    expect(applyCommand(charme, env({ type: 'wall.setStructural', wallId: 'w-north', structural: null }, { author: llm })).ok).toBe(true);
    expect(applyCommand(charme, env({ type: 'wall.setStructural', wallId: 'w-alcove', structural: false }, { author: llm })).ok).toBe(true);
  });

  it('the batch [setStructural false, wall.remove] by an llm fails at the first command', () => {
    const batch = { type: 'batch', label: 'sneak', commands: [
      { type: 'wall.setStructural', wallId: 'w-north', structural: false },
      { type: 'wall.remove', wallId: 'w-north' },
    ] };
    const r = reduceCommand(charme, batch, { author: llm });
    expect(r).toMatchObject({ ok: false, errors: [{ code: 'precondition_failed', path: 'commands/0/structural' }] });
    // by a user the demotion works but the removal is still not supported (and never silently skipped)
    const u = reduceCommand(charme, batch, { author: user });
    expect(u).toMatchObject({ ok: false, errors: [{ code: 'not_supported', path: 'commands/1/type' }] });
    // the public API refuses it outright
    expect(applyCommand(charme, env(batch as never, { author: llm })).ok).toBe(false);
  });

  it('an llm may undo its own protective change even when the inverse demotes a wall', () => {
    const asUser = env({ type: 'wall.setStructural', wallId: 'w-north', structural: false }, { author: user });
    const r1 = applyCommand(charme, asUser);
    if (!r1.ok) throw new Error('setup');
    const asLlm = env({ type: 'wall.setStructural', wallId: 'w-north', structural: true }, { author: llm });
    const r2 = applyCommand(r1.scene, asLlm);
    if (!r2.ok) throw new Error('setup2');
    const h = recordCommand(createHistory(), asLlm, r2);
    const u = undo(h, r2.scene, { id: 'u1', ts: 1, author: llm });
    expect(u.ok && u.scene.walls.find((w) => w.id === 'w-north')!.structural).toBe(false);
  });
});
