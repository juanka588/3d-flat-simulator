import { describe, expect, it } from 'vitest';
import { MemoryCache } from './memory-cache';

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('MemoryCache (LRU + TTL, injected clock)', () => {
  it('expires entries by TTL without sleeping', () => {
    const clock = fakeClock();
    const c = new MemoryCache({ clock });
    c.set('a', 1, 1000);
    clock.advance(999);
    expect(c.get('a')).toBe(1);
    clock.advance(1);
    expect(c.get('a')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('evicts the least recently used entries beyond the total cap, and skips entries over the per-entry cap', () => {
    const c = new MemoryCache({ clock: fakeClock(), maxTotalBytes: 100, maxEntryBytes: 60 });
    c.set('a', 'A', 1e6, 40);
    c.set('b', 'B', 1e6, 40);
    expect(c.get('a')).toBe('A'); // a is now the most recent
    c.set('c', 'C', 1e6, 40); // 120 > 100: evicts b
    expect([c.get('a'), c.get('b'), c.get('c')]).toEqual(['A', undefined, 'C']);
    c.set('big', 'X', 1e6, 61);
    expect(c.get('big')).toBeUndefined();
    expect(c.bytes).toBe(80);
  });

  it('is single-flight: concurrent loads of one key share one call; failures are not cached', async () => {
    const c = new MemoryCache({ clock: fakeClock() });
    let calls = 0;
    const load = async () => {
      calls++;
      await Promise.resolve();
      return 7;
    };
    expect(await Promise.all([c.flight('k', 1000, load), c.flight('k', 1000, load), c.flight('k', 1000, load)])).toEqual([7, 7, 7]);
    expect(await c.flight('k', 1000, load)).toBe(7);
    expect(calls).toBe(1);
    await expect(c.flight('bad', 1000, async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await c.flight('bad', 1000, async () => 1)).toBe(1);
  });

  it('scopes keys per provider but shares the byte budget', () => {
    const c = new MemoryCache({ clock: fakeClock(), maxTotalBytes: 10 });
    const a = c.scope('a');
    const b = c.scope('b');
    a.set('k', 1, 1e6, 6);
    b.set('k', 2, 1e6, 6);
    expect([a.get('k'), b.get('k')]).toEqual([undefined, 2]);
  });
});
