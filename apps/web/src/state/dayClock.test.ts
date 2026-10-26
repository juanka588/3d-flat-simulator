import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING, dayRange, localToInstant } from '@flat/scene';
import { DEFAULT_FIXTURE } from './fixtures';
import { advanceDay, createManualSource, installDayClock, setClockSource, tickClock, useClockStore } from './dayClock';
import { instantToLocal, toMinutes } from './localTime';
import { useSceneStore } from './sceneStore';
import { useViewStore } from './viewStore';

const time = () => useViewStore.getState().lighting.time;

beforeEach(() => {
  useSceneStore.getState().loadText(DEFAULT_FIXTURE.text, DEFAULT_FIXTURE.id);
  useViewStore.setState({ lighting: { ...DEFAULT_LIGHTING, date: '2026-06-21', time: '08:00' } });
  useClockStore.setState({ playing: false, speed: 60, source: 'manual' });
});

describe('advanceDay', () => {
  it('moves the time at the chosen speed', () => {
    advanceDay(1000, 60); // 1 h/s
    expect(time()).toBe('09:00');
    advanceDay(500, 60);
    expect(time()).toBe('09:30');
  });

  it('accumulates sub-minute steps instead of rounding them away', () => {
    for (let i = 0; i < 60; i++) advanceDay(16.7, 1); // ~1 s at 1 min/s
    expect(time()).toBe('08:01');
  });

  it('loops over the daylight range: past the end it wraps to the exact modulo target', () => {
    const { scene } = useSceneStore.getState();
    const { timezone } = scene!.site;
    const range = dayRange(scene!.site, '2026-06-21');
    const start = range.start.getTime();
    const length = range.end.getTime() - start;
    const end = instantToLocal(range.end, timezone).time;
    useViewStore.getState().setLighting({ time: end });
    // The slider has minute precision: the cursor starts at the end time rounded to the minute.
    const cursor = localToInstant('2026-06-21', end, timezone).getTime();
    expect(cursor).toBeLessThan(start + length);
    advanceDay(2000, 60); // two hours later
    const wrapped = start + ((cursor + 2 * 3_600_000 - start) % length);
    expect(time()).toBe(instantToLocal(new Date(wrapped), timezone).time);
    expect(toMinutes(time())).toBeLessThan(8 * 60); // early morning, not mid-day
    useViewStore.getState().setLighting({ time: '10:00' });
    advanceDay(0, 60);
    expect(time()).toBe('10:00');
  });

  it('after the Evening preset (20:00, past the end of a winter day) the animation starts at the range start', () => {
    const { scene } = useSceneStore.getState();
    const range = dayRange(scene!.site, '2026-12-21');
    const startTime = instantToLocal(range.start, scene!.site.timezone).time;
    expect(toMinutes(instantToLocal(range.end, scene!.site.timezone).time)).toBeLessThan(20 * 60);
    useViewStore.getState().setLighting({ date: '2026-12-21', time: '20:00' });
    advanceDay(16.7, 1);
    expect(time()).toBe(startTime);
    advanceDay(1000, 60); // and then it advances normally from there
    expect(toMinutes(time())).toBe(toMinutes(startTime) + 60);
  });

  it('jumps in at sunrise when the time is before the range', () => {
    useViewStore.getState().setLighting({ time: '01:00' });
    advanceDay(10, 60);
    expect(toMinutes(time())).toBeGreaterThan(4 * 60);
  });
});

describe('installDayClock with a manual source', () => {
  it('advances only while playing and only when ticked', () => {
    const dispose = installDayClock();
    setClockSource('manual');
    tickClock(1000);
    expect(time()).toBe('08:00'); // not playing
    useClockStore.getState().setPlaying(true);
    tickClock(1000);
    expect(time()).toBe('09:00');
    useClockStore.getState().setPlaying(false);
    tickClock(1000);
    expect(time()).toBe('09:00');
    dispose();
  });

  it('the manual source delivers ticks to subscribers until they unsubscribe', () => {
    const source = createManualSource();
    const seen: number[] = [];
    const off = source.subscribe((dt) => seen.push(dt));
    source.tick(5);
    off();
    source.tick(7);
    expect(seen).toEqual([5]);
  });
});
