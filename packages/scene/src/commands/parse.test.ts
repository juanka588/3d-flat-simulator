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

describe('validation bounds (C6)', () => {
  const cmd = (c: unknown, extra: object = {}) => parseCommand({ ...base, ...extra, cmd: c });
  const long = (n: number) => 'x'.repeat(n);
  const green = { id: 'm', name: 'm', kind: 'paint', color: '#00aa00', roughness: 0.5 };

  it('prototype-chain type names give a clean invalid_command, not a crash or not_supported', () => {
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const r = cmd({ type });
      expect(r.ok, type).toBe(false);
      if (!r.ok) {
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0]).toMatchObject({ code: 'invalid_command', path: 'cmd/type' });
        expect(r.errors[0]!.message).toContain('unknown command type');
      }
    }
  });

  it('ids are at most 64 characters, on definition and on reference alike', () => {
    expect(cmd({ type: 'wall.setFinish', wallId: long(64), side: 'both', materialId: long(64) }).ok).toBe(true);
    expect(cmd({ type: 'wall.setFinish', wallId: long(65), side: 'both', materialId: null }).ok).toBe(false);
    expect(cmd({ type: 'wall.setFinish', wallId: 'w', side: 'both', materialId: long(65) }).ok).toBe(false);
    expect(cmd({ type: 'wall.setFinish', wallId: 'w', side: 'both', materialId: null, roomId: long(65) }).ok).toBe(false);
    expect(cmd({ type: 'material.define', material: { ...green, id: long(65) } }).ok).toBe(false);
    expect(cmd({ type: 'material.define', material: { ...green, id: long(64) } }).ok).toBe(true);
    expect(cmd({ type: 'light.add', light: { type: 'point', id: long(65), position: [0, 0], elevation: 1, lumens: 1 } }).ok).toBe(false);
    expect(cmd({ type: 'light.update', id: long(65), patch: {} }).ok).toBe(false);
    expect(cmd({ type: 'light.update', id: 'l', patch: { roomId: long(65) } }).ok).toBe(false);
    expect(cmd({ type: 'room.setFloor', roomId: long(65), materialId: null }).ok).toBe(false);
    expect(parseCommand({ ...base, id: long(65), cmd: { type: 'batch', label: 'x', commands: [] } }).ok).toBe(false);
    expect(cmd({ type: 'batch', label: 'x', commands: [] }, { undoOf: long(65) }).ok).toBe(false);
    expect(cmd({ type: 'batch', label: 'x', commands: [] }, { redoOf: long(65) }).ok).toBe(false);
    expect(cmd({ type: 'batch', label: 'x', commands: [] }, { undoOf: long(64) }).ok).toBe(true);
  });

  it('names are at most 120 characters and the address at most 300', () => {
    expect(cmd({ type: 'material.define', material: { ...green, name: long(120) } }).ok).toBe(true);
    expect(cmd({ type: 'material.define', material: { ...green, name: long(121) } }).ok).toBe(false);
    expect(cmd({ type: 'light.update', id: 'l', patch: { name: long(121) } }).ok).toBe(false);
    expect(cmd({ type: 'light.add', light: { type: 'point', name: long(121), position: [0, 0], elevation: 1, lumens: 1 } }).ok).toBe(false);
    expect(cmd({ type: 'site.set', site: { address: long(300) } }).ok).toBe(true);
    expect(cmd({ type: 'site.set', site: { address: long(301) } }).ok).toBe(false);
  });

  it('textureUrl takes lib:<slug> only', () => {
    const tex = (u: string) => cmd({ type: 'material.define', material: { ...green, kind: 'texture', textureUrl: u } }).ok;
    expect(tex('lib:oak-parquet')).toBe(true);
    expect(tex('materials/oak/')).toBe(false);
    expect(tex('oak.png')).toBe(false);
  });
});

describe('commandJsonSchema', () => {
  it('matches the committed contract snapshot and mentions structural', async () => {
    const json = JSON.stringify(commandJsonSchema(), null, 2) + '\n';
    expect(json).toContain('wall.setStructural');
    await expect(json).toMatchFileSnapshot('./__snapshots__/command.schema.json');
  });
});
