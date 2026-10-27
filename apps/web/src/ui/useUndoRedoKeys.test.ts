import { describe, expect, it } from 'vitest';
import { undoRedoAction } from './useUndoRedoKeys';

const ev = (key: string, code: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = { ctrl: true }) => ({
  key,
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe('undoRedoAction', () => {
  it('maps Ctrl/Cmd+Z, Shift+Z and Ctrl+Y on Latin layouts', () => {
    expect(undoRedoAction(ev('z', 'KeyZ'))).toBe('undo');
    expect(undoRedoAction(ev('Z', 'KeyZ', { meta: true, shift: true }))).toBe('redo');
    expect(undoRedoAction(ev('y', 'KeyY'))).toBe('redo');
    expect(undoRedoAction(ev('y', 'KeyY', { meta: true }))).toBeNull();
    expect(undoRedoAction(ev('z', 'KeyZ', { ctrl: true, alt: true }))).toBeNull();
    expect(undoRedoAction(ev('z', 'KeyZ', {}))).toBeNull();
  });

  it('falls back to the physical key on non-Latin layouts', () => {
    expect(undoRedoAction(ev('я', 'KeyZ'))).toBe('undo'); // Russian
    expect(undoRedoAction(ev('Я', 'KeyZ', { meta: true, shift: true }))).toBe('redo');
    expect(undoRedoAction(ev('н', 'KeyY'))).toBe('redo');
    expect(undoRedoAction(ev('ζ', 'KeyZ'))).toBe('undo'); // Greek
  });

  it('does not steal other Latin letters that sit on the Z/Y positions (AZERTY, QWERTZ)', () => {
    expect(undoRedoAction(ev('w', 'KeyZ'))).toBeNull(); // AZERTY: physical Z types w
    expect(undoRedoAction(ev('z', 'KeyY'))).toBe('undo'); // QWERTZ: the z key is where Y sits
  });
});
