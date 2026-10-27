import { useEffect, useRef } from 'react';
import { useSyncStore } from '../sync/sync-store';

/** Modal choice after the server's scene changed epoch (an import, or a different server): never decided silently. */
export function SyncConflictDialog() {
  const conflict = useSyncStore((s) => s.conflict);
  const resolve = useSyncStore((s) => s.resolve);
  const dialog = useRef<HTMLDialogElement>(null);
  const open = conflict !== null;

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!conflict || !resolve) return <dialog ref={dialog} className="sync-dialog" aria-labelledby="sync-dialog-title" />;
  const n = conflict.pendingCount;
  return (
    <dialog
      ref={dialog}
      className="sync-dialog"
      data-testid="sync-conflict"
      aria-labelledby="sync-dialog-title"
      aria-describedby="sync-dialog-body"
      onCancel={(e) => e.preventDefault() /* Esc does not decide for the user */}
    >
      <h2 id="sync-dialog-title">The server has a different flat</h2>
      <p id="sync-dialog-body">
        The shared scene was replaced (or this is another server). Choose which version to keep
        {n > 0 ? `; ${n} change${n === 1 ? '' : 's'} you made here ${n === 1 ? 'is' : 'are'} not on the server yet` : ''}.
      </p>
      <div className="sync-dialog-actions">
        <button type="button" data-testid="sync-use-server" autoFocus onClick={resolve.useServer}>
          Use server scene
        </button>
        <button type="button" className="danger" data-testid="sync-keep-mine" onClick={resolve.keepMine}>
          Keep mine (overwrite server)
        </button>
      </div>
    </dialog>
  );
}
