import { describe, expect, it, vi } from 'vitest';
import { createModelCache } from './model-cache';
import type { Loaded } from './model-cache';

const model = (name: string, bytes = 10): Loaded<{ name: string }> => ({ value: { name }, bytes });

function setup(opts: { maxModels?: number; maxBytes?: number } = {}) {
  const disposed: string[] = [];
  const restored: string[] = [];
  const cache = createModelCache<{ name: string }>({ ...opts, dispose: (v) => disposed.push(v.name), restore: (v) => restored.push(v.name) });
  return { cache, disposed, restored };
}

describe('model cache', () => {
  it('loads once for concurrent acquirers (single flight) and counts each as a reference', async () => {
    const { cache } = setup();
    const load = vi.fn(async () => model('a'));
    const [h1, h2, h3] = await Promise.all([cache.acquire('a', load), cache.acquire('a', load), cache.acquire('a', load)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(h1.value).toBe(h2.value);
    expect(cache.stats()).toMatchObject({ models: 1, inUse: 1, pending: 0 });
    h1.release();
    h2.release();
    expect(cache.stats().inUse).toBe(1);
    h3.release();
    expect(cache.stats().inUse).toBe(0);
  });

  it('does not cache failures: the next acquire loads again', async () => {
    const { cache } = setup();
    await expect(cache.acquire('a', async () => Promise.reject(new Error('404')))).rejects.toThrow('404');
    expect(cache.has('a')).toBe(false);
    const h = await cache.acquire('a', async () => model('a'));
    expect(h.value.name).toBe('a');
  });

  it('evicts idle models least recently used first, and disposes them', async () => {
    const { cache, disposed } = setup({ maxModels: 2 });
    for (const k of ['a', 'b']) (await cache.acquire(k, async () => model(k))).release();
    (await cache.acquire('a', async () => model('a'))).release(); // touch a: b is now the oldest
    (await cache.acquire('c', async () => model('c'))).release();
    expect(disposed).toEqual(['b']);
    expect(cache.has('a') && cache.has('c') && !cache.has('b')).toBe(true);
    expect(cache.stats().evictions).toBe(1);
  });

  it('never evicts a model that is in use, even over the limit', async () => {
    const { cache, disposed } = setup({ maxModels: 1 });
    const a = await cache.acquire('a', async () => model('a'));
    const b = await cache.acquire('b', async () => model('b'));
    expect(disposed).toEqual([]);
    expect(cache.stats().models).toBe(2);
    a.release();
    expect(disposed).toEqual(['a']);
    b.release();
    expect(cache.stats().models).toBe(1);
  });

  it('keeps the byte budget: evicts idle models while over it', async () => {
    const { cache, disposed } = setup({ maxBytes: 25 });
    (await cache.acquire('a', async () => model('a', 10))).release();
    (await cache.acquire('b', async () => model('b', 10))).release();
    (await cache.acquire('c', async () => model('c', 10))).release();
    expect(disposed).toEqual(['a']);
    expect(cache.stats().bytes).toBe(20);
  });

  it('defaults to 24 models and 64 MB', async () => {
    const { cache, disposed } = setup();
    for (let i = 0; i < 25; i++) (await cache.acquire(`m${i}`, async () => model(`m${i}`, 1))).release();
    expect(disposed).toEqual(['m0']);
    const big = setup();
    (await big.cache.acquire('x', async () => model('x', 40 * 1024 * 1024))).release();
    (await big.cache.acquire('y', async () => model('y', 40 * 1024 * 1024))).release();
    expect(big.disposed).toEqual(['x']);
  });

  it('release is idempotent', async () => {
    const { cache } = setup();
    const a = await cache.acquire('a', async () => model('a'));
    const a2 = await cache.acquire('a', async () => model('a'));
    a.release();
    a.release();
    expect(cache.stats().inUse).toBe(1);
    a2.release();
    expect(cache.stats().inUse).toBe(0);
  });

  it('a model acquired while loading is not evicted before its joiners get it', async () => {
    const { cache, disposed } = setup({ maxModels: 1 });
    (await cache.acquire('old', async () => model('old'))).release();
    let finish!: () => void;
    const slow = new Promise<void>((r) => (finish = r));
    const p1 = cache.acquire('new', async () => (await slow, model('new')));
    const p2 = cache.acquire('new', async () => model('never'));
    finish();
    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h1.value.name).toBe('new');
    expect(h2.value).toBe(h1.value);
    expect(disposed).toEqual(['old']);
    expect(cache.has('new')).toBe(true);
  });

  it('restore lets every cached model re-upload; clear disposes everything', async () => {
    const { cache, disposed, restored } = setup();
    (await cache.acquire('a', async () => model('a'))).release();
    const b = await cache.acquire('b', async () => model('b'));
    cache.restore();
    expect(restored.sort()).toEqual(['a', 'b']);
    cache.clear();
    expect(disposed.sort()).toEqual(['a', 'b']);
    b.release(); // the entry is gone: nothing to give back, no throw
    expect(cache.stats().models).toBe(0);
  });
});
