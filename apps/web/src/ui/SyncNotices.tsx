import { useEffect } from 'react';
import { useSyncStore } from '../sync/sync-store';
import type { Notice } from '../sync/sync-store';

const AUTO_DISMISS_MS = 12_000;

function Toast({ notice }: { notice: Notice }) {
  const dismiss = useSyncStore((s) => s.dismissNotice);
  useEffect(() => {
    const t = setTimeout(() => dismiss(notice.id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [notice.id, dismiss]);
  return (
    <div className={`sync-toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} data-testid="sync-toast">
      <span>{notice.text}</span>
      <button type="button" className="link" aria-label="Dismiss" onClick={() => dismiss(notice.id)}>
        ✕
      </button>
    </div>
  );
}

/** Toasts for pending changes the server dropped or refused. */
export function SyncNotices() {
  const notices = useSyncStore((s) => s.notices);
  if (!notices.length) return null;
  return (
    <div className="sync-toasts">
      {notices.map((n) => (
        <Toast key={n.id} notice={n} />
      ))}
    </div>
  );
}
