export function ErrorPanel({ errors, onDismiss }: { errors: string[]; onDismiss: () => void }) {
  if (errors.length === 0) return null;
  return (
    <section role="alert" aria-label="Load errors" className="panel error-panel" data-testid="error-panel">
      <h2>Could not load this file</h2>
      <p>The previous flat is still shown.</p>
      <ul>
        {errors.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}
