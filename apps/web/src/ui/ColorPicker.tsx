import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { PALETTE, SHEENS, normalizeHex } from '@flat/scene';
import type { Sheen } from '@flat/scene';
import { readPref, writePref } from '../state/prefs';

export const RECENT_COLOURS_KEY = 'flat.recentColours';
const MAX_RECENT = 8;

export function readRecentColours(): string[] {
  try {
    const parsed: unknown = JSON.parse(readPref(RECENT_COLOURS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string' && /^#[0-9a-f]{6}$/.test(h)).slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function addRecentColour(hex: string): string[] {
  const h = normalizeHex(hex);
  const next = [h, ...readRecentColours().filter((c) => c !== h)].slice(0, MAX_RECENT);
  writePref(RECENT_COLOURS_KEY, JSON.stringify(next));
  return next;
}

/** Hex field validation: `#abc`, `abc`, `#aabbcc` or `AABBCC`. Returns the normalised hex or null. */
export function parseHexInput(text: string): string | null {
  try {
    return normalizeHex(text);
  } catch {
    return null;
  }
}

interface ColorPickerProps {
  /** Hex of the paint currently on the target, if it is a paint. */
  activeHex: string | null;
  sheen: Sheen;
  onSheen: (sheen: Sheen) => void;
  /** Applies a colour as one undoable step (swatch, hex field, recents). */
  onApply: (hex: string) => void;
  /** Live feedback while dragging the colour input; nothing is recorded until `onCommit`. */
  onPreview: (hex: string) => void;
  /** Records the preview as a single history entry. */
  onCommit: () => void;
  onCancel: () => void;
}

function Swatch({ name, hex, active, tabbable, onPick, onFocus }: { name: string; hex: string; active: boolean; tabbable: boolean; onPick: () => void; onFocus: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={`${name} ${hex}`}
      title={name}
      tabIndex={tabbable ? 0 : -1}
      className="swatch"
      style={{ background: hex }}
      onClick={onPick}
      onFocus={onFocus}
    />
  );
}

/** Moves focus between the radios of a group with the arrow keys (roving tabindex), Home and End. */
function arrowNav(e: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const to =
    e.key === 'ArrowRight' || e.key === 'ArrowDown'
      ? (at + 1) % items.length
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
        ? (at - 1 + items.length) % items.length
        : e.key === 'Home'
          ? 0
          : items.length - 1;
  items[to]?.focus();
}

/**
 * One radiogroup of swatches (WAI-ARIA radio pattern, "focus follows arrows" variant): the arrow keys move
 * focus without applying (every apply is an undo step), and the roving tabindex follows the focus, so
 * Tab out and back returns to the swatch you left on.
 */
function SwatchGroup({ labelId, swatches, active, onPick }: { labelId: string; swatches: { name: string; hex: string }[]; active: string | null; onPick: (hex: string) => void }) {
  const [roving, setRoving] = useState<string | null>(null);
  const known = swatches.some((s) => s.hex === roving) ? roving : null;
  const tabbableHex = known ?? swatches.find((s) => s.hex === active)?.hex ?? swatches[0]?.hex;
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="swatch-row" onKeyDown={arrowNav}>
      {swatches.map((s) => (
        <Swatch key={s.hex} name={s.name} hex={s.hex} active={s.hex === active} tabbable={s.hex === tabbableHex} onPick={() => onPick(s.hex)} onFocus={() => setRoving(s.hex)} />
      ))}
    </div>
  );
}

export function ColorPicker({ activeHex, sheen, onSheen, onApply, onPreview, onCommit, onCancel }: ColorPickerProps) {
  const [recent, setRecent] = useState<string[]>(readRecentColours);
  const [custom, setCustom] = useState(activeHex ?? '#a3ae93');
  const [hexText, setHexText] = useState(activeHex ?? '#a3ae93');
  const [invalid, setInvalid] = useState(false);
  const previewing = useRef(false);
  const uid = useId();
  const input = useRef<HTMLInputElement>(null);
  const commitRef = useRef(onCommit);
  const cancelRef = useRef(onCancel);
  /** The colour shown before a drag started, restored when the drag is cancelled. */
  const dragFrom = useRef(custom);
  const customRef = useRef(custom);
  useEffect(() => {
    commitRef.current = onCommit;
    cancelRef.current = onCancel;
    customRef.current = custom;
  });

  const remember = (hex: string) => setRecent(addRecentColour(hex));

  const finishDrag = () => {
    if (!previewing.current) return;
    previewing.current = false;
    commitRef.current();
    remember(customRef.current);
  };
  const cancelDrag = () => {
    if (!previewing.current) return;
    previewing.current = false;
    cancelRef.current();
    setCustom(dragFrom.current);
    setHexText(dragFrom.current);
  };
  const apply = (hex: string) => {
    setCustom(hex);
    setHexText(hex);
    setInvalid(false);
    remember(hex);
    onApply(hex);
  };
  const latest = useRef({ finishDrag, apply });
  useEffect(() => {
    latest.current = { finishDrag, apply };
  });

  // The native `change` event fires when the colour dialog closes (React's onChange is `input`). Normally it
  // follows one or more `input` events (commit the preview); a picker that only fires `change` applies the value.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const onChange = () => {
      if (previewing.current) latest.current.finishDrag();
      else latest.current.apply(el.value.toLowerCase());
    };
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, []);

  // Unmounting mid-drag (selection change, tab switch, panel closed) COMMITS the previewed colour as one history
  // entry: the user saw it applied, and the preview is bound to the target it started on. Esc cancels instead.
  useEffect(
    () => () => {
      if (!previewing.current) return;
      previewing.current = false;
      commitRef.current();
      addRecentColour(customRef.current);
    },
    [],
  );

  const submitHex = () => {
    const hex = parseHexInput(hexText);
    if (!hex) {
      setInvalid(true);
      return;
    }
    apply(hex);
  };

  const active = activeHex?.toLowerCase() ?? null;

  return (
    <div
      className="color-picker"
      onKeyDown={(e) => {
        // Esc during a colour drag drops the preview and restores the colour the drag started from.
        if (e.key === 'Escape' && previewing.current) cancelDrag();
      }}
    >
      {PALETTE.map((group) => (
        <div key={group.group} className="swatch-group">
          <div className="swatch-group-label" id={`${uid}-${group.group}`}>
            {group.label}
          </div>
          <SwatchGroup labelId={`${uid}-${group.group}`} swatches={group.swatches} active={active} onPick={apply} />
        </div>
      ))}

      <div className="custom-colour">
        <label className="field-inline">
          <span>Custom colour</span>
          <input
            ref={input}
            type="color"
            value={custom}
            onInput={(e) => {
              const hex = e.currentTarget.value.toLowerCase();
              if (!previewing.current) dragFrom.current = customRef.current;
              setCustom(hex);
              setHexText(hex);
              setInvalid(false);
              previewing.current = true;
              onPreview(hex);
            }}
            onChange={() => undefined}
            onBlur={finishDrag}
          />
        </label>
        <label className="field-inline">
          <span>Hex</span>
          <input
            type="text"
            inputMode="text"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={7}
            value={hexText}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${uid}-hex-error` : undefined}
            className="hex-field"
            onChange={(e) => {
              setHexText(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitHex();
            }}
            onBlur={() => {
              if (hexText.trim() && parseHexInput(hexText) === null) setInvalid(true);
            }}
          />
        </label>
        <button type="button" onClick={submitHex}>
          Apply colour
        </button>
        {invalid && (
          <p id={`${uid}-hex-error`} role="alert" className="field-error">
            Enter a hex colour like #a3ae93 or #abc.
          </p>
        )}
      </div>

      <div className="sheen">
        <label className="field-inline">
          <span>Sheen</span>
          <select value={sheen} onChange={(e) => onSheen(e.target.value as Sheen)}>
            {SHEENS.map((s) => (
              <option key={s} value={s}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {recent.length > 0 && (
        <div className="swatch-group">
          <div className="swatch-group-label" id={`${uid}-recent`}>
            Recent colours
          </div>
          <SwatchGroup labelId={`${uid}-recent`} swatches={recent.map((hex) => ({ name: 'Recent', hex }))} active={active} onPick={apply} />
        </div>
      )}
    </div>
  );
}
