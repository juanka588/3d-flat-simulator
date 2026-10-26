import { describe, expect, it } from 'vitest';
import { commandJsonSchema, migrateCommand, parseCommand } from './parse';

const base = { v: 1, id: 'a', ts: 1, author: { kind: 'user' } };

describe('parseCommand', () => {
  it('accepts a valid command and never throws on junk', () => {
    const r = parseCommand({ ...base, cmd: { type: 'wall.setFinish', wallId: 'w', side: 'both', materialId: null } });
    expect(r.ok).toBe(true);
    for (const junk of [null, 1, 'x', [], {}, { v: 1 }, { ...base, cmd: 5 }, { ...base, cmd: { type: 3 } }]) {
      expect(parseCommand(junk).ok).toBe(false);
    }
  });

  it('lists valid types for an unknown type', () => {
    const r = parseCommand({ ...base, cmd: { type: 'wall.paint' } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.message).toContain('unknown command type');
      expect(r.errors[0]!.hint).toContain('wall.setFinish');
    }
  });

  it('rejects unknown keys, bad enums and v:2', () => {
    expect(parseCommand({ ...base, cmd: { type: 'wall.setFinish', wallId: 'w', side: 'up', materialId: null } }).ok).toBe(false);
    expect(parseCommand({ ...base, cmd: { type: 'room.setFloor', roomId: 'r', materialId: null, extra: 1 } }).ok).toBe(false);
    const r = parseCommand({ ...base, v: 2, cmd: { type: 'batch', label: 'x', commands: [] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toContain('newer than supported');
    expect(migrateCommand({ v: 3 }).ok).toBe(false);
  });

  it('rejects nested batches with a path', () => {
    const r = parseCommand({ ...base, cmd: { type: 'batch', label: 'x', commands: [{ type: 'batch', label: 'y', commands: [] }] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.path).toBe('cmd/commands/0/type');
  });

  it('answers not_supported with a hint for reserved geometry commands', () => {
    for (const type of ['wall.move', 'wall.remove', 'opening.add']) {
      const r = parseCommand({ ...base, cmd: { type } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors[0]!.code).toBe('not_supported');
        expect(r.errors[0]!.hint).toBeTruthy();
      }
    }
  });

  it('allows an optional light id and patches via nulls', () => {
    expect(parseCommand({ ...base, cmd: { type: 'light.add', light: { type: 'point', position: [1, 1], elevation: 2, lumens: 800 } } }).ok).toBe(true);
    expect(parseCommand({ ...base, cmd: { type: 'light.update', id: 'l', patch: { roomId: null } } }).ok).toBe(true);
  });
});

describe('commandJsonSchema', () => {
  it('matches the committed contract snapshot and mentions structural', async () => {
    const json = JSON.stringify(commandJsonSchema(), null, 2) + '\n';
    expect(json).toContain('wall.setStructural');
    await expect(json).toMatchFileSnapshot('./__snapshots__/command.schema.json');
  });
});
