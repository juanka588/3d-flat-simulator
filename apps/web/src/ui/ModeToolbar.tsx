import type { ViewMode } from '../viewer/view-types';

const MODES: { id: ViewMode; label: string }[] = [
  { id: 'orbit', label: 'Orbit' },
  { id: 'top', label: 'Top' },
  { id: 'walk', label: 'Walk' },
];

export function ModeToolbar({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div role="group" aria-label="Camera mode" className="mode-toolbar">
      {MODES.map((m) => (
        <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => onChange(m.id)}>
          {m.label}
        </button>
      ))}
    </div>
  );
}
