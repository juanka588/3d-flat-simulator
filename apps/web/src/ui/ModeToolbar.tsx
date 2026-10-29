import { useStructuralOverlay } from '../state/structuralOverlay';
import type { ViewMode } from '@flat/viewer';
import { HistoryButtons } from './HistoryButtons';

const MODES: { id: ViewMode; label: string }[] = [
  { id: 'orbit', label: 'Orbit' },
  { id: 'top', label: 'Top' },
  { id: 'walk', label: 'Walk' },
];

function StructuralLegend() {
  const visible = useStructuralOverlay((s) => s.visible);
  const setVisible = useStructuralOverlay((s) => s.setVisible);
  return (
    <div className="structural-legend" data-testid="structural-legend">
      <label className="check">
        <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
        <span>Show structural walls</span>
      </label>
      {visible && (
        <ul className="legend-list" aria-label="Wall legend">
          <li>
            <span className="legend-key structural" aria-hidden="true" /> Structural
          </li>
          <li>
            <span className="legend-key removable" aria-hidden="true" /> Removable partition
          </li>
        </ul>
      )}
    </div>
  );
}

export function ModeToolbar({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <>
      <div role="group" aria-label="Camera mode" className="mode-toolbar">
        {MODES.map((m) => (
          <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => onChange(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <HistoryButtons />
      {mode === 'top' && <StructuralLegend />}
    </>
  );
}
