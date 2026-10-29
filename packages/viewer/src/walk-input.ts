/** Held on-screen controls (arrow pad, turn buttons). The walker reads them every frame. */
export type VirtualKey = 'forward' | 'back' | 'left' | 'right' | 'turnLeft' | 'turnRight';

const held = new Set<VirtualKey>();
let wake: (() => void) | null = null;

export function setVirtualKey(key: VirtualKey, down: boolean): void {
  if (down) held.add(key);
  else held.delete(key);
  if (down) wake?.();
}

export function virtualKeysHeld(): ReadonlySet<VirtualKey> {
  return held;
}

export function clearVirtualKeys(): void {
  held.clear();
}

/** The walker registers how to request a frame (the canvas renders on demand). */
export function onVirtualWake(fn: (() => void) | null): void {
  wake = fn;
}

let step: ((dtSeconds: number) => void) | null = null;

/** The walker registers its per-frame integration so tests can drive it with a fixed dt. */
export function onWalkStep(fn: ((dtSeconds: number) => void) | null): void {
  step = fn;
}

/** Runs the walker's integration for `dtSeconds` (no-op outside walk mode). */
export function stepWalker(dtSeconds: number): boolean {
  if (!step) return false;
  step(dtSeconds);
  return true;
}
