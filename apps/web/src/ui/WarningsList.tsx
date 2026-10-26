import type { SceneWarning } from '../scene-adapters';

export function WarningsList({
  warnings,
  onSelect,
}: {
  warnings: SceneWarning[];
  onSelect: (entityId: string) => void;
}) {
  if (warnings.length === 0) return null;
  return (
    <section aria-label="Warnings" className="panel" data-testid="warnings">
      <h2>Warnings ({warnings.length})</h2>
      <ul>
        {warnings.map((w, i) => (
          <li key={i}>
            {w.entityId ? (
              <button type="button" className="link" onClick={() => onSelect(w.entityId!)}>
                {w.message}
              </button>
            ) : (
              w.message
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
