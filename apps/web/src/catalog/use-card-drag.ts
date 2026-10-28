import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import type { ProductRecord } from '@flat/assets';
import { isDragging, startDrag } from './placement';
import type { PlaceSource } from './place';

/** Mouse: the pointer must travel this far before a press becomes a drag. */
export const DRAG_START_PX = 5;
/** Touch: press and hold this long (without moving) to pick a card up; moving earlier scrolls the list. */
export const LONG_PRESS_MS = 350;
/** Touch: movement allowed during the hold. */
export const LONG_PRESS_SLOP_PX = 9;

export type Arm = 'drag' | 'wait' | 'cancel';

/** Pure decision for a pending press: a mouse drags after `DRAG_START_PX`; a touch picks up after the hold, and scrolling cancels it. */
export function armDecision(pointerType: string, moved: number, heldMs: number): Arm {
  if (pointerType === 'touch') {
    if (moved > LONG_PRESS_SLOP_PX) return heldMs >= LONG_PRESS_MS ? 'drag' : 'cancel';
    return heldMs >= LONG_PRESS_MS ? 'drag' : 'wait';
  }
  return moved >= DRAG_START_PX ? 'drag' : 'wait';
}

let guard = false;
/** While a drag is on, touch moves must not scroll the page or the list (one non-passive listener for the app). */
function installTouchGuard(): void {
  if (guard) return;
  guard = true;
  window.addEventListener('touchmove', (e) => (isDragging() && e.cancelable ? e.preventDefault() : undefined), { passive: false });
}

const INTERACTIVE = 'a, button, input, select, textarea, label';

export interface CardDragOptions {
  source: () => PlaceSource;
  /** Product cards: the server record the snapshot is built from (called at press, to warm it, and at drop). */
  record?: () => Promise<ProductRecord>;
  /** A drag began (mobile closes the drawer so the view is visible). */
  onStart?: () => void;
  disabled?: boolean;
}

/** Pointer handlers that turn a press on a card into a drag onto the 3D view. */
export function useCardDrag(opts: CardDragOptions): { onPointerDown: (e: ReactPointerEvent) => void } {
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    const o = optsRef.current;
    if (o.disabled || e.button !== 0 || (e.target as HTMLElement).closest(INTERACTIVE)) return;
    installTouchGuard();
    const t0 = performance.now();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const type = e.pointerType;
    let last = { clientX: x0, clientY: y0, shiftKey: e.shiftKey, altKey: e.altKey };
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Warm the record so the drop does not wait for the network.
    let memo: Promise<ProductRecord> | undefined;
    const record = o.record ? () => (memo ??= o.record!()) : undefined;
    if (record) void record().catch(() => undefined);

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
    };
    const begin = () => {
      cleanup();
      o.onStart?.();
      startDrag({ kind: 'new', source: o.source(), ...(record ? { getRecord: record } : {}), touch: type === 'touch' }, last);
    };
    const move = (ev: PointerEvent) => {
      last = { clientX: ev.clientX, clientY: ev.clientY, shiftKey: ev.shiftKey, altKey: ev.altKey };
      const decision = armDecision(type, Math.hypot(ev.clientX - x0, ev.clientY - y0), performance.now() - t0);
      if (decision === 'drag') begin();
      else if (decision === 'cancel') cleanup();
    };
    const end = () => cleanup();
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    if (type === 'touch') timer = setTimeout(begin, LONG_PRESS_MS);
  }, []);
  return { onPointerDown };
}
