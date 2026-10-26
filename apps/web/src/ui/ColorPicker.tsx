import { useEffect, useRef, useState } from 'react';
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

function Swatch({ name, hex, active, tabbable, onPick }: { name: string; hex: string; active: boolean; tabbable: boolean; onPick: () => void }) {
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

export function ColorPicker({ activeHex, sheen, onSheen, onApply, onPreview, onCommit, onCancel }: ColorPickerProps) {
  const [recent, setRecent] = useState<string[]>(readRecentColours);
  const [custom, setCustom] = useState(activeHex ?? '#a3ae93');
  const [hexText, setHexText] = useState(activeHex ?? '#a3ae93');
  const [invalid, setInvalid] = useState(false);
  const previewing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const commitRef = useRef(onCommit);
  useEffect(() => {
    commitRef.current = onCommit;
  });

  const remember = (hex: string) => setRecent(addRecentColour(hex));

  const finishDrag = () => {
    if (!previewing.current) return;
    previewing.current = false;
    commitRef.current();
    remember(custom);
  };
  const finishDragRef = useRef(finishDrag);
  useEffect(() => {
    finishDragRef.current = finishDrag;
  });

  // The native `change` event fires when the colour dialog closes (React's onChange is `input`).
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const onChange = () => finishDragRef.current();
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, []);

  const apply = (hex: string) => {
    setCustom(hex);
    setHexText(hex);
    setInvalid(false);
    remember(hex);
    onApply(hex);
  };

  const submitHex = () => {
    const hex = parseHexInput(hexText);
    if (!hex) {
      setInvalid(true);
      return;
    }
    apply(hex);
  };

  const active = activeHex?.toLowerCase() ?? null;
  const firstActive = PALETTE.flatMap((g) => g.swatches).find((s) => s.hex === active);

  return (
    <div className="color-picker">
      {PALETTE.map((group) => (
        <div key={group.group} className="swatch-group">
          <div className="swatch-group-label" id={`swatches-${group.group}`}>
            {group.label}
          </div>
          <div role="radiogroup" aria-labelledby={`swatches-${group.group}`} className="swatch-row" onKeyDown={arrowNav}>
            {group.swatches.map((s, i) => (
              <Swatch
                key={s.hex}
                name={s.name}
                hex={s.hex}
                active={s.hex === active}
                tabbable={firstActive ? s.hex === firstActive.hex : i === 0}
                onPick={() => apply(s.hex)}
              />
            ))}
          </div>
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
              setCustom(hex);
              setHexText(hex);
              setInvalid(false);
              previewing.current = true;
              onPreview(hex);
            }}
            onChange={() => undefined}
            onBlur={finishDrag}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && previewing.current) {
                previewing.current = false;
                onCancel();
              }
            }}
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
            aria-describedby={invalid ? 'hex-error' : undefined}
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
          <p id="hex-error" role="alert" className="field-error">
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
          <div className="swatch-group-label" id="swatches-recent">
            Recent colours
          </div>
          <div role="radiogroup" aria-labelledby="swatches-recent" className="swatch-row" onKeyDown={arrowNav}>
            {recent.map((hex, i) => (
              <Swatch key={hex} name="Recent" hex={hex} active={hex === active} tabbable={i === 0} onPick={() => apply(hex)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
