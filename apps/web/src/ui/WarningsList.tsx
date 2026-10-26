import type { ValidationWarning } from '@flat/scene';

export function WarningsList({
  warnings,
  onSelect,
}: {
  warnings: ValidationWarning[];
  onSelect: (entityId: string) => void;
}) {
  if (warnings.length === 0) return null;
  return (
    <section aria-label="Warnings" className="panel" data-testid="warnings">
      <h2>Warnings ({warnings.length})</h2>
      <ul>
        {warnings.map((w, i) => {
          const target = w.entityIds[0];
          return (
            <li key={i} data-code={w.code}>
              {target ? (
                <button type="button" className="link" onClick={() => onSelect(target)}>
                  {w.message}
                </button>
              ) : (
                w.message
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
