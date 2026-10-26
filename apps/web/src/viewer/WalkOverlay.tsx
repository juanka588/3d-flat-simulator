import { useEffect, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { clearVirtualKeys, setVirtualKey } from './walk-input';
import type { VirtualKey } from './walk-input';

export const WALK_OVERLAY_STORAGE_KEY = 'flat.walkControlsHidden';

function readHidden(): boolean {
  try {
    return localStorage.getItem(WALK_OVERLAY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean): void {
  try {
    localStorage.setItem(WALK_OVERLAY_STORAGE_KEY, hidden ? '1' : '0');
  } catch {
    // Storage unavailable (private mode): the preference just does not persist.
  }
}

interface PadButtonProps {
  action: VirtualKey;
  label: string;
  glyph: string;
  className: string;
}

/** A button that holds `action` while it is pressed (mouse, touch or pen). */
function PadButton({ action, label, glyph, className }: PadButtonProps) {
  const release = () => setVirtualKey(action, false);
  return (
    <button
      type="button"
      className={`walk-pad-btn ${className}`}
      aria-label={label}
      title={label}
      data-testid={`walk-${action}`}
      onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
        e.preventDefault(); // keep focus on the page so the keyboard keeps working
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setVirtualKey(action, true);
      }}
      onMouseDown={(e) => e.preventDefault()}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') setVirtualKey(action, true);
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') release();
      }}
      onBlur={release}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}

/**
 * Walk-mode help and on-screen pad, rendered over the canvas. Desktop: one bar at the bottom centre.
 * Phones (see styles.css): the move buttons bottom-left and the turn buttons bottom-right, each a
 * 56 px target, with nothing in between so the rest of the view stays free for drag-to-look.
 */
export function WalkOverlay({ onExit }: { onExit?: () => void }) {
  const [hidden, setHidden] = useState(readHidden);

  useEffect(() => clearVirtualKeys, []);

  const toggle = (next: boolean) => {
    setHidden(next);
    writeHidden(next);
    clearVirtualKeys();
  };

  return (
    <div className={`walk-overlay${hidden ? ' walk-overlay-collapsed' : ''}`} role="region" aria-label="Walk controls" data-testid="walk-overlay">
      {hidden ? (
        <button type="button" className="walk-toggle" onClick={() => toggle(false)} aria-expanded="false">
          Show controls
        </button>
      ) : (
        <>
          <div className="walk-help">
            <ul>
              <li>
                <strong>Move:</strong> arrow keys or WASD (ZQSD on AZERTY)
              </li>
              <li>
                <strong>Look:</strong> drag or click the view
              </li>
              <li>
                <strong>Run:</strong> hold Shift
              </li>
              <li>
                <strong>Leave:</strong> Esc
              </li>
            </ul>
            <button type="button" className="walk-toggle" onClick={() => toggle(true)} aria-expanded="true">
              Hide
            </button>
            {onExit && (
              <button type="button" className="walk-toggle walk-exit" onClick={onExit}>
                Exit walk
              </button>
            )}
          </div>
          <div className="walk-pad" role="group" aria-label="On-screen controls">
            <div className="walk-move" role="group" aria-label="Move">
              <PadButton action="forward" label="Move forward" glyph="↑" className="pad-up" />
              <PadButton action="left" label="Move left" glyph="←" className="pad-left" />
              <PadButton action="back" label="Move backward" glyph="↓" className="pad-down" />
              <PadButton action="right" label="Move right" glyph="→" className="pad-right" />
            </div>
            <div className="walk-turn" role="group" aria-label="Turn">
              <PadButton action="turnLeft" label="Turn left" glyph="↶" className="pad-turn-left" />
              <PadButton action="turnRight" label="Turn right" glyph="↷" className="pad-turn-right" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
