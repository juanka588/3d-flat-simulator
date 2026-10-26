import { dayRange, localToInstant } from '@flat/scene';
import { create } from 'zustand';
import { instantToLocal } from './localTime';
import { useSceneStore } from './sceneStore';
import { useViewStore } from './viewStore';

/** Day animation speeds in simulated minutes per real second. */
export const SPEEDS = [
  { label: '1 min/s', minutesPerSecond: 1 },
  { label: '10 min/s', minutesPerSecond: 10 },
  { label: '1 h/s', minutesPerSecond: 60 },
] as const;

/** Where animation time comes from: calls the listener with the elapsed real milliseconds. */
export interface TimeSource {
  subscribe: (listener: (dtMs: number) => void) => () => void;
}

/** Deterministic source for tests: time only advances through `tick`. */
export interface ManualTimeSource extends TimeSource {
  tick: (dtMs: number) => void;
}

export function createManualSource(): ManualTimeSource {
  const listeners = new Set<(dtMs: number) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tick(dtMs) {
      listeners.forEach((l) => l(dtMs));
    },
  };
}

/** requestAnimationFrame-driven source that does not run (and does not accumulate time) while the tab is hidden. */
export function createRafSource(): TimeSource {
  return {
    subscribe(listener) {
      let raf = 0;
      let last: number | null = null;
      const frame = (now: number) => {
        if (last !== null) listener(now - last);
        last = now;
        raf = requestAnimationFrame(frame);
      };
      const start = () => {
        last = null; // the first frame after (re)starting only sets the baseline
        raf = requestAnimationFrame(frame);
      };
      const stop = () => cancelAnimationFrame(raf);
      const onVisibility = () => {
        stop();
        if (!document.hidden) start();
      };
      document.addEventListener('visibilitychange', onVisibility);
      if (!document.hidden) start();
      return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        stop();
      };
    },
  };
}

interface ClockStore {
  playing: boolean;
  /** Simulated minutes per real second. */
  speed: number;
  source: 'real' | 'manual';
  setPlaying: (playing: boolean) => void;
  setSpeed: (minutesPerSecond: number) => void;
}

export const useClockStore = create<ClockStore>((set) => ({
  playing: false,
  speed: SPEEDS[1].minutesPerSecond,
  source: 'real',
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
}));

export const manualSource = createManualSource();
const rafSource = createRafSource();

/** Selects the time source (`manual` is for tests: drive it with `tickClock`). */
export function setClockSource(source: 'real' | 'manual'): void {
  useClockStore.setState({ source });
}

/** Advances the manual clock by `dtMs`; the animation moves only while playing. */
export function tickClock(dtMs: number): void {
  manualSource.tick(dtMs);
}

// The animation cursor keeps sub-minute precision, which the HH:mm view state cannot; it is
// re-synced from the view whenever something else (slider, preset, date) changes the time.
let cursorMs: number | null = null;
let appliedKey = '';

/** Advances the lighting time by `dtMs` of real time at the current speed, looping over the daylight range. */
export function advanceDay(dtMs: number, minutesPerSecond = useClockStore.getState().speed): void {
  const { scene } = useSceneStore.getState();
  if (!scene) return;
  const { lighting, setLighting } = useViewStore.getState();
  const timezone = scene.site.timezone;
  try {
    const key = `${scene.site.timezone}|${lighting.date}T${lighting.time}`;
    if (cursorMs === null || key !== appliedKey) cursorMs = localToInstant(lighting.date, lighting.time, timezone).getTime();
    const range = dayRange(scene.site, lighting.date);
    const start = range.start.getTime();
    const length = range.end.getTime() - start;
    if (length <= 0) return;
    let t = cursorMs + dtMs * minutesPerSecond * 60;
    // Before the range (e.g. the evening preset): jump in at the start; past the end: loop.
    if (t < start) t = start;
    else if (t >= start + length) t = start + ((t - start) % length);
    cursorMs = t;
    const local = instantToLocal(new Date(t), timezone);
    appliedKey = `${timezone}|${lighting.date}T${local.time}`;
    if (local.time !== lighting.time) setLighting({ time: local.time });
  } catch {
    // Lighting maths unavailable (stubs): leave the time alone.
  }
}

/** Starts the subscription that feeds the day animation; call once at startup. Returns a disposer. */
export function installDayClock(): () => void {
  let unsubscribe: (() => void) | null = null;
  const sync = () => {
    unsubscribe?.();
    unsubscribe = null;
    const { playing, source } = useClockStore.getState();
    if (playing) unsubscribe = (source === 'manual' ? manualSource : rafSource).subscribe((dt) => advanceDay(dt));
  };
  const off = useClockStore.subscribe((state, prev) => {
    if (state.playing !== prev.playing || state.source !== prev.source) sync();
  });
  sync();
  return () => {
    off();
    unsubscribe?.();
  };
}
