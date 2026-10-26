import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING, dayRange } from '@flat/scene';
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

  it('follows manual time changes and loops over the daylight range', () => {
    const { scene } = useSceneStore.getState();
    const range = dayRange(scene!.site, '2026-06-21');
    const end = instantToLocal(range.end, scene!.site.timezone).time;
    useViewStore.getState().setLighting({ time: end });
    advanceDay(2000, 60); // two hours past the end: wraps to the start
    const start = instantToLocal(range.start, scene!.site.timezone).time;
    expect(toMinutes(time())).toBeGreaterThanOrEqual(toMinutes(start));
    expect(toMinutes(time())).toBeLessThan(toMinutes(end));
    useViewStore.getState().setLighting({ time: '10:00' });
    advanceDay(0, 60);
    expect(time()).toBe('10:00');
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
