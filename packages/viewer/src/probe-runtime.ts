import type { ProbeField } from './probe-field';

/**
 * What the test hook (and the headless renderer) can see of the light probes: whether a bake is wanted or running
 * (`whenRendered` waits for it, like it waits for textures and models) and the numbers of the last bake.
 */
export interface ProbeStats {
  /** `probes`: the baked grid is the indirect light; `legacy`: the old per-room bounce and ambient (`?gi=off`, or a failed bake). */
  mode: 'probes' | 'legacy';
  /** A bake is wanted (debouncing), running, or the displayed grid is for an older state. */
  pending: boolean;
  /** Key of the state the displayed grid was baked for, and of the state wanted now. */
  displayedKey: string | null;
  wantedKey: string | null;
  /** Open-air light (lux, `LightingModel.keyLux`) the displayed grid was baked for: the exposure is not allowed to run far ahead of it. Null before the first bake. */
  displayedKeyLux: number | null;
  /** Bakes completed since the page loaded. */
  bakes: number;
  /** Wall time of the last completed bake, ms (first draw to published), and the probes it rendered. */
  lastBakeMs: number;
  lastBakeProbes: number;
  /** Probe grid: probes per axis, spacing (m) and the settings used. */
  res: [number, number, number] | null;
  spacing: [number, number, number] | null;
  cube: number;
  bounces: number;
  /** Probes skipped because they stand in a wall or in furniture. */
  invalid: number;
  /** Why the probes were given up on (a failed bake), if they were. */
  error: string | null;
}

const EMPTY: ProbeStats = {
  mode: 'legacy',
  pending: false,
  displayedKey: null,
  wantedKey: null,
  displayedKeyLux: null,
  bakes: 0,
  lastBakeMs: 0,
  lastBakeProbes: 0,
  res: null,
  spacing: null,
  cube: 0,
  bounces: 0,
  invalid: 0,
  error: null,
};

let current: ProbeStats = EMPTY;
let waiters: (() => void)[] = [];
const listeners = new Set<() => void>();

/** For `useSyncExternalStore`: called whenever the stats change. */
export function subscribeProbeStats(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
const notify = () => listeners.forEach((l) => l());

let field: ProbeField | null = null;
/** The light the displayed probes give (exposure is keyed on it); null without probes. */
export const probeField = (): ProbeField | null => field;
export function setProbeField(f: ProbeField | null): void {
  field = f;
}

export interface ProbeControls {
  /** Bakes again for the state shown now (resolves when published) even if nothing changed: determinism checks. */
  rebake: () => Promise<void>;
  /** FNV-1a hex of the baked atlas (spherical harmonics and visibility), read back from the GPU. */
  hash: () => string;
}
let controls: ProbeControls | null = null;

export function probeStats(): ProbeStats {
  return current;
}

export function setProbeStats(patch: Partial<ProbeStats>): void {
  current = { ...current, ...patch };
  notify();
  if (!current.pending) {
    const w = waiters;
    waiters = [];
    w.forEach((f) => f());
  }
}

/** Resolves when no bake is wanted or running. */
export function probesSettled(): Promise<void> {
  return current.pending ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve();
}

export function setProbeControls(c: ProbeControls | null): void {
  controls = c;
}
export const probeControls = (): ProbeControls | null => controls;

export function resetProbeStats(mode: ProbeStats['mode'] = 'legacy'): void {
  current = { ...EMPTY, mode };
  field = null;
  notify();
  const w = waiters;
  waiters = [];
  w.forEach((f) => f());
}
