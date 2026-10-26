import { useState } from 'react';
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
  const recent = labels.slice(-HISTORY_SHOWN).reverse();

  return (
    <div className="history-buttons" role="group" aria-label="History">
      <button type="button" disabled={!canUndo} title={canUndo && labels.length ? `Undo: ${labels[labels.length - 1]}` : 'Undo (Ctrl+Z)'} onClick={() => undo()}>
        Undo
      </button>
      <button type="button" disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" onClick={() => redo()}>
        Redo
      </button>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="history-list"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        History
      </button>
      {open && (
        <div id="history-list" className="history-popover" data-testid="history-list">
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
