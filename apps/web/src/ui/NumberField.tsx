import { useId, useState } from 'react';

interface NumberFieldProps {
  label: string;
  value: number;
  /** Called with a parsed number whenever the text is a valid number within [min, max]. */
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | 'any';
  unit?: string;
  testId?: string;
}

/**
 * Number input that keeps its own text while focused, so intermediate states ("2" on the way to
 * "2700") do not fight the committed value. Out-of-range text is flagged and not committed.
 */
export function NumberField({ label, value, onCommit, min, max, step = 'any', unit, testId }: NumberFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const parsed = draft === null || draft.trim() === '' ? NaN : Number(draft);
  const invalid = draft !== null && (!Number.isFinite(parsed) || (min !== undefined && parsed < min) || (max !== undefined && parsed > max));
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        data-testid={testId}
        value={draft ?? String(value)}
        min={min}
        max={max}
        step={step}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const n = Number(text);
          if (text.trim() !== '' && Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) onCommit(n);
        }}
        onBlur={() => setDraft(null)}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  );
}
