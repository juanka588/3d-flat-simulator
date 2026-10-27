import { useEffect, useId, useRef, useState } from 'react';
import { useSceneStore } from '../state/sceneStore';

const HISTORY_SHOWN = 10;

/** Undo / Redo buttons with a popover listing the last ten history entries. */
/** Keyboard shortcuts (Ctrl/Cmd+Z) are global, see useUndoRedoKeys. */
export function HistoryButtons() {
  const undo = useSceneStore((s) => s.undo);
  const redo = useSceneStore((s) => s.redo);
  const canUndo = useSceneStore((s) => s.canUndo);
  const canRedo = useSceneStore((s) => s.canRedo);
  const labels = useSceneStore((s) => s.historyLabels);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const recent = labels.slice(-HISTORY_SHOWN).reverse();

  // Open: focus moves into the list; an outside press or Esc (from anywhere) closes it, Esc returning focus to the button.
  useEffect(() => {
    if (!open) return;
    popover.current?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="history-buttons" role="group" aria-label="History">
      <button type="button" disabled={!canUndo} title={canUndo && labels.length ? `Undo: ${labels[labels.length - 1]}` : 'Undo (Ctrl+Z)'} onClick={() => undo()}>
        Undo
      </button>
      <button type="button" disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" onClick={() => redo()}>
        Redo
      </button>
      <button ref={toggle} type="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        History
      </button>
      {open && (
        <div ref={popover} id={listId} className="history-popover" data-testid="history-list" tabIndex={-1} role="region" aria-label="Recent changes">
          {recent.length ? (
            <ol>
              {recent.map((label, i) => (
                <li key={`${labels.length - i}:${label}`}>{label}</li>
              ))}
            </ol>
          ) : (
            <p className="hint">No changes yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
