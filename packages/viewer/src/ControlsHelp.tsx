import { useEffect, useState } from 'react';
import { layoutFromMap, lookKeyLabel } from './camera-input';
import type { KeyboardLayoutKind } from './camera-input';
import type { ViewMode } from './view-types';

interface KeyboardApi {
  getLayoutMap?: () => Promise<{ get(code: string): string | undefined }>;
}

/**
 * The physical layout of the keyboard, to label the look keys ZQSD on AZERTY. `navigator.keyboard.getLayoutMap()`
 * exists in Chromium only (and only in secure contexts); elsewhere the layout stays unknown and both labels show.
 */
export function useKeyboardLayout(): KeyboardLayoutKind {
  const [layout, setLayout] = useState<KeyboardLayoutKind>('unknown');
  useEffect(() => {
    const api = (navigator as Navigator & { keyboard?: KeyboardApi }).keyboard;
    if (!api?.getLayoutMap) return;
    let alive = true;
    api
      .getLayoutMap()
      .then((map) => alive && setLayout(layoutFromMap(map)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return layout;
}

const HELP_KEY = 'flat.cameraHelpHidden';

function readHidden(): boolean {
  try {
    return localStorage.getItem(HELP_KEY) === '1';
  } catch {
    return false;
  }
}

/** Keyboard help for the orbit and top views (walk mode has its own, see WalkOverlay). */
export function CameraHelp({ mode }: { mode: Exclude<ViewMode, 'walk'> }) {
  const layout = useKeyboardLayout();
  const keys = lookKeyLabel(layout);
  const [hidden, setHidden] = useState(readHidden);
  const toggle = (next: boolean) => {
    setHidden(next);
    try {
      localStorage.setItem(HELP_KEY, next ? '1' : '0');
    } catch {
      // storage unavailable: the choice just does not persist
    }
  };
  if (hidden) {
    return (
      <button type="button" className="cam-help-toggle" data-testid="cam-help-show" onClick={() => toggle(false)} aria-expanded="false">
        Keys
      </button>
    );
  }
  return (
    <div className="cam-help" role="region" aria-label="Camera keys" data-testid="cam-help">
      <ul>
        <li>
          <strong>Pan:</strong> arrow keys (left stick); with an item selected they nudge it
        </li>
        {mode === 'orbit' && (
          <li>
            <strong>Orbit:</strong> <span data-testid="cam-help-look">{keys}</span> (right stick): {layout === 'azerty' ? 'Q/D turn, Z/S tilt' : layout === 'other' ? 'A/D turn, W/S tilt' : 'Q/D or A/D turn, Z/S or W/S tilt'}
          </li>
        )}
        <li>
          <strong>Zoom:</strong> mouse wheel or pinch
        </li>
        {mode === 'orbit' && (
          <li>
            <strong>Person:</strong> drag the figure to choose where Walk starts
          </li>
        )}
      </ul>
      <button type="button" className="walk-toggle" onClick={() => toggle(true)} aria-expanded="true">
        Hide
      </button>
    </div>
  );
}
