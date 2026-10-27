import { useEffect } from 'react';
import { useSceneStore } from '../state/sceneStore';

/** Whether a key event comes from somewhere the user is typing (native text undo must win there). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(type);
}

/** Maps a key event to a history action: Ctrl/Cmd+Z undo, Shift+Ctrl/Cmd+Z or Ctrl+Y redo. */
export function undoRedoAction(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> & { code?: string }): 'undo' | 'redo' | null {
  if (e.altKey || !(e.ctrlKey || e.metaKey)) return null;
  // `key` follows the layout (a Cyrillic or Greek layout types other letters), `code` is the physical key:
  // fall back to it when `key` is not a Latin letter, so Ctrl+Z works on the Z position of any layout.
  const key = e.key.toLowerCase();
  const latin = /^[a-z]$/.test(key);
  const isZ = key === 'z' || (!latin && e.code === 'KeyZ');
  const isY = key === 'y' || (!latin && e.code === 'KeyY');
  if (isZ) return e.shiftKey ? 'redo' : 'undo';
  if (isY && e.ctrlKey && !e.shiftKey) return 'redo';
  return null;
}

/** Global undo/redo shortcuts, ignored while typing in a field. */
export function useUndoRedoKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = undoRedoAction(e);
      if (!action || isTypingTarget(e.target)) return;
      e.preventDefault();
      useSceneStore.getState()[action]();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
