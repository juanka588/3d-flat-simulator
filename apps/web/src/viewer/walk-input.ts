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
