/**
 * Camera input shared by the walk, orbit and top rigs: two virtual sticks, like a game pad.
 *
 * - Left stick (move): the arrow keys, the left gamepad stick, the on-screen pad.
 * - Right stick (look): the physical W/A/S/D keys (`KeyboardEvent.code`, so on an AZERTY keyboard the keys
 *   labelled Z/Q/S/D, which report KeyW/KeyA/KeyS/KeyD), the right gamepad stick.
 *
 * Everything here is pure (no three.js) except `attachCameraKeys` and `watchGamepad`, which touch the DOM.
 */

export type Vec2 = [number, number];

/** Right-stick keys as [yaw, pitch]: +x turns right, +y looks up. */
export const LOOK_KEYS: Readonly<Record<string, Vec2>> = {
  KeyA: [-1, 0],
  KeyD: [1, 0],
  KeyW: [0, 1],
  KeyS: [0, -1],
};
/** Left-stick keys as [strafe, ahead]: +x right, +y forward. */
export const MOVE_KEYS: Readonly<Record<string, Vec2>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

export const LOOK_SPEED_DEG = 90;
/** Angular acceleration while a look key is held or released, degrees per second squared (full speed in 0.25 s). */
export const LOOK_ACCEL_DEG = 360;
export const MAX_PITCH_DEG = 80;
export const MAX_PITCH_RAD = (MAX_PITCH_DEG * Math.PI) / 180;
export const GAMEPAD_DEADZONE = 0.15;

export function isCameraKey(code: string): boolean {
  return code in LOOK_KEYS || code in MOVE_KEYS;
}

export function clampDisc([x, y]: Vec2): Vec2 {
  const len = Math.hypot(x, y);
  return len > 1 ? [x / len, y / len] : [x, y];
}

/** Sum of the keys held in `table`, limited to the unit disc (two keys at once do not go faster). */
export function stickFromKeys(held: ReadonlySet<string>, table: Readonly<Record<string, Vec2>>): Vec2 {
  let x = 0;
  let y = 0;
  held.forEach((code) => {
    const d = table[code];
    if (d) {
      x += d[0];
      y += d[1];
    }
  });
  return clampDisc([x, y]);
}

/** Radial deadzone: inside it the stick reads zero, outside the rest of the range is rescaled to 0..1. */
export function applyDeadzone([x, y]: Vec2, deadzone = GAMEPAD_DEADZONE): Vec2 {
  const len = Math.hypot(x, y);
  if (!(len > deadzone)) return [0, 0];
  const scaled = Math.min(1, (len - deadzone) / (1 - deadzone));
  return [(x / len) * scaled, (y / len) * scaled];
}

interface PadLike {
  axes: readonly number[];
}

/** Both sticks of a standard-mapping gamepad (axes 0/1 left, 2/3 right; the pad's y is down-positive, ours up-positive). */
export function gamepadSticks(pad: PadLike | null | undefined, deadzone = GAMEPAD_DEADZONE): Sticks {
  if (!pad) return { move: [0, 0], look: [0, 0] };
  const axis = (i: number) => (Number.isFinite(pad.axes[i]) ? pad.axes[i]! : 0);
  return {
    move: applyDeadzone([axis(0), -axis(1)], deadzone),
    look: applyDeadzone([axis(2), -axis(3)], deadzone),
  };
}

/** The first connected gamepad, if the browser has the API. */
export function firstGamepad(): Gamepad | null {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
  for (const pad of navigator.getGamepads()) if (pad && pad.connected) return pad;
  return null;
}

export interface Sticks {
  move: Vec2;
  look: Vec2;
}

/** Both sticks from the held keys and (optionally) a gamepad; the keyboard wins where it is pushed. `arrows: false` leaves the arrows to something else. */
export function readSticks(held: ReadonlySet<string>, pad?: PadLike | null, opts: { arrows?: boolean } = {}): Sticks {
  const keyMove: Vec2 = opts.arrows === false ? [0, 0] : stickFromKeys(held, MOVE_KEYS);
  const keyLook = stickFromKeys(held, LOOK_KEYS);
  const g = gamepadSticks(pad);
  const pick = (a: Vec2, b: Vec2): Vec2 => (a[0] !== 0 || a[1] !== 0 ? a : b);
  return { move: pick(keyMove, g.move), look: pick(keyLook, g.look) };
}

/** Whether the arrows belong to the selected item (nudging) rather than the camera: only outside walk mode. */
export function arrowsBelongToItem(mode: string, selection: { kind: string } | null | undefined): boolean {
  return mode !== 'walk' && selection?.kind === 'item';
}

export interface LookState {
  /** Angular velocity, radians per second: yaw (+ = right) and pitch (+ = up). */
  yawVel: number;
  pitchVel: number;
}

export const LOOK_REST: LookState = { yawVel: 0, pitchVel: 0 };

function approach(v: number, target: number, maxDelta: number): number {
  return v < target ? Math.min(target, v + maxDelta) : Math.max(target, v - maxDelta);
}

/**
 * Smooth look: the angular velocity follows `stick * 90 deg/s` with a bounded acceleration. Returns the new
 * velocities and the angles turned during `dt` (trapezoid integration).
 */
export function stepLook(state: LookState, look: Vec2, dt: number): { state: LookState; dYaw: number; dPitch: number } {
  const step = Math.max(0, Math.min(dt, 0.1));
  const max = (LOOK_SPEED_DEG * Math.PI) / 180;
  const accel = ((LOOK_ACCEL_DEG * Math.PI) / 180) * step;
  const yawVel = approach(state.yawVel, look[0] * max, accel);
  const pitchVel = approach(state.pitchVel, look[1] * max, accel);
  return {
    state: { yawVel, pitchVel },
    dYaw: ((state.yawVel + yawVel) / 2) * step,
    dPitch: ((state.pitchVel + pitchVel) / 2) * step,
  };
}

export function lookIdle(state: LookState): boolean {
  return Math.abs(state.yawVel) < 1e-6 && Math.abs(state.pitchVel) < 1e-6;
}

export function clampPitch(pitchRad: number): number {
  return Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, pitchRad));
}

export type KeyboardLayoutKind = 'azerty' | 'other' | 'unknown';

/** Labels of the look keys for the help text: `ZQSD` on AZERTY, `WASD` otherwise, both when the layout is unknown. */
export function lookKeyLabel(layout: KeyboardLayoutKind): string {
  return layout === 'azerty' ? 'ZQSD' : layout === 'other' ? 'WASD' : 'ZQSD / WASD';
}

export function layoutFromMap(map: { get(code: string): string | undefined } | null | undefined): KeyboardLayoutKind {
  const w = map?.get('KeyW');
  if (!w) return 'unknown';
  return w.toLowerCase() === 'z' ? 'azerty' : 'other';
}

/**
 * Listens for the camera keys on the window and keeps `held` (KeyboardEvent.code values) in step. Keys aimed at form
 * controls do not count (`accepts`), releases are never filtered, and anything held is dropped when focus is lost.
 * `arrowsFree` says whether the arrows may drive the camera right now (not while they nudge a selected item).
 * Returns a disposer.
 */
export function attachCameraKeys(
  held: Set<string>,
  opts: { accepts: (target: EventTarget | null) => boolean; arrowsFree: () => boolean; wake: () => void },
): () => void {
  const down = (e: KeyboardEvent) => {
    if (e.metaKey || e.code.startsWith('Meta')) {
      held.clear();
      return;
    }
    if (!isCameraKey(e.code) || e.ctrlKey || e.altKey || !opts.accepts(e.target)) return;
    if (e.code in MOVE_KEYS && !opts.arrowsFree()) return;
    e.preventDefault();
    held.add(e.code);
    opts.wake();
  };
  const up = (e: KeyboardEvent) => {
    if (e.metaKey || e.code.startsWith('Meta')) held.clear();
    else held.delete(e.code);
  };
  const clear = () => held.clear();
  const hidden = () => {
    if (document.visibilityState === 'hidden') held.clear();
  };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', clear);
  document.addEventListener('visibilitychange', hidden);
  return () => {
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', clear);
    document.removeEventListener('visibilitychange', hidden);
    held.clear();
  };
}

/**
 * The canvas renders on demand, so a stick pushed on a gamepad would never ask for a frame. While a pad is connected
 * this polls it (animation frames) and calls `wake` whenever a stick is outside the deadzone. Returns a disposer.
 */
export function watchGamepad(wake: () => void): () => void {
  if (typeof window === 'undefined' || typeof navigator.getGamepads !== 'function') return () => undefined;
  let raf = 0;
  let stopped = false;
  const poll = () => {
    raf = 0;
    if (stopped) return;
    const pad = firstGamepad();
    if (!pad) return; // the 'gamepadconnected' event restarts the loop
    const s = gamepadSticks(pad);
    if (s.move[0] || s.move[1] || s.look[0] || s.look[1]) wake();
    raf = requestAnimationFrame(poll);
  };
  const start = () => {
    if (!raf && !stopped) raf = requestAnimationFrame(poll);
  };
  window.addEventListener('gamepadconnected', start);
  start();
  return () => {
    stopped = true;
    window.removeEventListener('gamepadconnected', start);
    if (raf) cancelAnimationFrame(raf);
  };
}
