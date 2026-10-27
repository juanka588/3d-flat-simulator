import { describe, expect, it } from 'vitest';
import { createNetwork } from './http';
import { isPartial, markPartial } from './types';
import { fakeClock } from './testkit';
import { mountOf } from './category';

describe('host queue priority', () => {
  it('serves interactive requests before background ones that queued earlier', async () => {
    const clock = fakeClock();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const fetchFake = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      order.push(url.split('/').pop()!);
      if (url.endsWith('/first')) await firstGate;
      return new Response('ok');
    }) as typeof fetch;
    const net = createNetwork({ fetch: fetchFake, clock, sleep: clock.sleep, gapMs: 0 }).forProvider('t');
    const get = (name: string, low = false) => net.fetch(`https://shop.example/${name}`, (low ? { priority: 'low' } : {}) as RequestInit).then((r) => r.text());
    const first = get('first');
    await new Promise((r) => setTimeout(r, 20)); // first is on the wire
    const bg = get('background', true);
    const fg = get('foreground');
    await new Promise((r) => setTimeout(r, 20));
    releaseFirst();
    await Promise.all([first, bg, fg]);
    expect(order).toEqual(['first', 'foreground', 'background']);
  });

  it('refuses background requests when the queue is half full, never interactive ones', async () => {
    const clock = fakeClock();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFake = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/robots.txt')) return new Response('', { status: 404 });
      await gate;
      return new Response('ok');
    }) as typeof fetch;
    const net = createNetwork({ fetch: fetchFake, clock, sleep: clock.sleep, gapMs: 0, maxQueue: 4 }).forProvider('t');
    const get = (name: string) => net.fetch(`https://shop.example/${name}`).then((r) => r.text());
    const pending = [get('a'), get('b')];
    await new Promise((r) => setTimeout(r, 20));
    const c = net.fetch('https://shop.example/c', { priority: 'low' } as RequestInit);
    c.catch(() => undefined);
    await expect(Promise.race([c, new Promise((r) => setTimeout(() => r('accepted'), 200))])).rejects.toMatchObject({ code: 'provider_unavailable' });
    pending.push(get('d'));
    release();
    await Promise.all(pending);
  });
});

describe('partial search results', () => {
  it('are marked and recognised', () => {
    const a: unknown[] = [];
    expect(isPartial(a)).toBe(false);
    expect(isPartial(markPartial(a))).toBe(true);
  });
});

describe('mount from the name', () => {
  it('hangs a product the shop lists as an ordinary shelf when its name says wall', () => {
    expect(mountOf('KLAVRESTRÖM Étagère murale - chêne 60x20 cm', 'shelf')).toBe('wall');
    expect(mountOf('LACK Wall shelf', 'shelf')).toBe('wall');
    expect(mountOf('KALLAX Étagère - blanc 77x147 cm', 'shelf')).toBe('floor');
    expect(mountOf('Miroir', 'mirror')).toBe('wall');
  });
});
