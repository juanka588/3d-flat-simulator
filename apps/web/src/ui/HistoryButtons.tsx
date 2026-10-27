import { useEffect, useId, useRef, useState } from 'react';
import type { HistoryItemView } from '../state/commands-api';
import { useSceneStore } from '../state/sceneStore';

const HISTORY_SHOWN = 10;

export function authorName(kind: string): string {
  return kind === 'llm' ? 'Claude' : kind === 'user' ? 'you' : kind;
}

/** "just now", "5 min ago", "2 h ago", "3 d ago". */
export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Undo / Redo buttons with a popover listing the last ten history entries. */
/** Keyboard shortcuts (Ctrl/Cmd+Z) are global, see useUndoRedoKeys. */
export function HistoryButtons() {
  const undo = useSceneStore((s) => s.undo);
  const redo = useSceneStore((s) => s.redo);
  const canUndo = useSceneStore((s) => s.canUndo);
  const canRedo = useSceneStore((s) => s.canRedo);
  const items = useSceneStore((s) => s.historyItems);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const recent = items.slice(-HISTORY_SHOWN).reverse();
  const newest = items[items.length - 1]?.label;

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
      <button type="button" disabled={!canUndo} title={canUndo && newest ? `Undo: ${newest}` : 'Undo (Ctrl+Z)'} onClick={() => undo()}>
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
          <HistoryList items={recent} total={items.length} />
        </div>
      )}
    </div>
  );
}

/** The newest entries, newest first. Mounted when the popover opens, so relative times are computed once per opening. */
function HistoryList({ items, total }: { items: HistoryItemView[]; total: number }) {
  const [now] = useState(() => Date.now());
  if (!items.length) return <p className="hint">No changes yet.</p>;
  return (
    <ol>
      {items.map((item, i) => (
        <li key={`${total - i}:${item.id}`}>
          <span className="history-label">{item.label}</span>
          <span className="history-meta">
            {authorName(item.author)} · {relativeTime(item.ts, now)}
          </span>
        </li>
      ))}
    </ol>
  );
}
