import { statusLabel, useSyncStore } from '../sync/sync-store';

/** Small chip: Local, Connected · rev N, Reconnecting…, Conflict: choose. */
export function SyncStatus() {
  const mode = useSyncStore((s) => s.mode);
  const status = useSyncStore((s) => s.status);
  const rev = useSyncStore((s) => s.rev);
  const pending = useSyncStore((s) => s.pending);
  const state = mode === 'local' ? 'local' : status;
  const label = statusLabel({ mode, status, rev });
  const detail =
    mode === 'local'
      ? 'Working locally; no server connected.'
      : `${label}${pending ? `, ${pending} change${pending === 1 ? '' : 's'} not yet confirmed by the server` : ''}`;
  return (
    <p className="sync-chip" data-testid="sync-status" data-state={state} role="status" aria-live="polite" aria-label={`Sync: ${detail}`} title={detail}>
      <span className="sync-dot" aria-hidden="true" />
      <span>{label}</span>
      {mode === 'server' && pending > 0 && <span className="sync-pending">{pending} pending</span>}
    </p>
  );
}
