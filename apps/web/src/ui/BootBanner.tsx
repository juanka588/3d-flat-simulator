import { useDocumentStatus } from '../state/persistence';

/**
 * The banner shown after boot. When a saved flat could not be restored it also offers the two ways to
 * resume autosave (which stays paused until one is chosen, so the saved flat is never overwritten by accident).
 */
export function BootBanner() {
  const notice = useDocumentStatus((s) => s.bootNotice);
  const pause = useDocumentStatus((s) => s.pause);
  if (!notice) return null;
  const { resolvePause, dismissBootNotice } = useDocumentStatus.getState();
  return (
    <div className="boot-banner" role="status" data-testid="boot-banner">
      <span>{notice}</span>
      {pause === 'failed' ? (
        <>
          <button type="button" className="link" data-testid="boot-start-fresh" onClick={() => resolvePause('startFresh')}>
            Start fresh
          </button>
          <button type="button" className="link" data-testid="boot-keep-editing" onClick={() => resolvePause('keepEditing')}>
            Keep editing (overwrite)
          </button>
        </>
      ) : (
        <button type="button" className="link" onClick={dismissBootNotice}>
          Dismiss
        </button>
      )}
    </div>
  );
}
