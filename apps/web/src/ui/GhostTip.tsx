import { useCatalogStore } from '../catalog/catalogStore';

/** The tip that follows the pointer while dragging: what is being placed, and why it cannot go there. Plus the refusal notice. */
export function GhostTip() {
  const ghost = useCatalogStore((s) => s.ghost);
  const notice = useCatalogStore((s) => s.notice);
  const setNotice = useCatalogStore((s) => s.setNotice);
  return (
    <>
      {ghost && (
        <div className={`ghost-tip ${ghost.verdict.valid ? 'ok' : 'bad'}`} data-testid="ghost-tip" data-valid={ghost.verdict.valid} data-kind={ghost.kind} style={{ left: ghost.x + 16, top: ghost.y + (ghost.touch ? -80 : 16) }} aria-hidden="true">
          <strong>{ghost.label}</strong>
          <span>{ghost.verdict.valid ? (ghost.verdict.warnings[0]?.message ?? 'Release to place') : ghost.verdict.message}</span>
        </div>
      )}
      {notice && (
        <p className="placement-notice" role="alert" data-testid="placement-notice">
          {notice}
          <button type="button" className="link" onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </p>
      )}
    </>
  );
}
