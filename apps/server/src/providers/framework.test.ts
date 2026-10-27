import { describe, expect, it } from 'vitest';
import { CACHE_ENTRY_BYTES, CACHE_TOTAL_BYTES, MemoryCache, TTL_MODEL_MS, TTL_PRODUCT_MS, TTL_SEARCH_MS } from './cache';
import { createNetwork, readBytesCapped, ROBOTS_TOKEN, USER_AGENT } from './http';
import { parseRobots, robotsAllows } from './robots';
import { createSecrets, parseEnvFile } from './secrets';
import { fakeClock, fakeFetch, hang, status, testContext, text } from './testkit';
import { ProviderError } from './types';

describe('MemoryCache (LRU + TTL, injected clock)', () => {
  it('uses the D3 TTLs and caps', () => {
    expect([TTL_SEARCH_MS, TTL_PRODUCT_MS, TTL_MODEL_MS]).toEqual([600_000, 3_600_000, 3_600_000]);
    expect([CACHE_TOTAL_BYTES, CACHE_ENTRY_BYTES]).toEqual([200 * 1024 * 1024, 20 * 1024 * 1024]);
  });

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

describe('robots.txt matcher', () => {
  const txt = ['User-agent: *', 'Disallow: /search', 'Disallow: */private/*', 'Allow: /search/public', '', 'User-agent: 3d-flat-simulator', 'Disallow: /blocked$'].join('\n');
  it('prefers the specific group, then longest match, supports * and $', () => {
    expect(robotsAllows(txt, '/blocked', ROBOTS_TOKEN)).toBe(false);
    expect(robotsAllows(txt, '/blocked/x', ROBOTS_TOKEN)).toBe(true);
    expect(robotsAllows(txt, '/search', ROBOTS_TOKEN)).toBe(true); // the specific group has no /search rule
    expect(robotsAllows(txt, '/search', 'other-bot')).toBe(false);
    expect(robotsAllows(txt, '/search/public/a', 'other-bot')).toBe(true);
    expect(robotsAllows(txt, '/a/private/b', 'other-bot')).toBe(false);
    expect(robotsAllows('', '/anything', ROBOTS_TOKEN)).toBe(true);
    expect(parseRobots('User-agent: a\nUser-agent: b\nDisallow: /x')[0]!.agents).toEqual(['a', 'b']);
  });
});

describe('credentials (env or .env.local only), redacted in logs', () => {
  it('parses a dotenv file and redacts secret values, bearer tokens and secret query parameters', () => {
    const file = parseEnvFile('# c\nFLAT_AWIN_TOKEN="s3cr3t-token-123"\nexport OTHER=plain # note\nBAD LINE\n');
    expect(file).toEqual({ FLAT_AWIN_TOKEN: 's3cr3t-token-123', OTHER: 'plain' });
    const s = createSecrets({ FLAT_FEED_URL: 'https://feed.example/x?k=abcdef123' }, file);
    expect(s.get('FLAT_AWIN_TOKEN')).toBe('s3cr3t-token-123');
    const out = s.redact('GET https://feed.example/x?k=abcdef123 with s3cr3t-token-123 Authorization: Bearer abc.def-ghi and ?token=zzz999&a=1');
    expect(out).not.toMatch(/abcdef123|s3cr3t-token-123|abc\.def-ghi|zzz999/);
    expect(out).toContain('a=1');
  });

  it('the polite network redacts secrets in its log lines', async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    const f = fakeFetch(clock, [['https://feed.example/x*', text('ok')]]);
    const net = createNetwork({ fetch: f.fetch, clock, sleep: clock.sleep, log: (_l, m) => logs.push(m), redact: createSecrets({ FLAT_X_TOKEN: 'topsecret-value' }).redact });
    await net.forProvider('p').fetch('https://feed.example/x?token=topsecret-value');
    expect(logs.join('\n')).not.toContain('topsecret-value');
  });
});

describe('polite network', () => {
  it('sends the identifying UA, only whitelisted headers (no cookies) and refuses anything but GET', async () => {
    const t = testContext([['https://a.example/p', text('ok')]]);
    await t.ctx.fetch('https://a.example/p', { headers: { cookie: 'sid=1', authorization: 'Bearer x', accept: 'text/html', 'user-agent': 'evil' } });
    const sent = t.fetch.pages()[0]!;
    expect(sent.headers['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toContain('3d-flat-simulator');
    expect(sent.headers['accept']).toBe('text/html');
    expect(sent.headers).not.toHaveProperty('cookie');
    expect(sent.headers).not.toHaveProperty('authorization');
    expect(sent.method).toBe('GET');
    await expect(t.ctx.fetch('https://a.example/p', { method: 'POST' })).rejects.toThrow(/only send GET/);
    await expect(t.ctx.fetch('https://a.example/p', { method: 'HEAD' })).rejects.toThrow(/only send GET/);
  });

  it('keeps 1.5 s between two requests to a host and serialises them (1 concurrent request per host)', async () => {
    let running = 0;
    let maxRunning = 0;
    const slow = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      running--;
      return text('ok');
    };
    const t = testContext([[/https:\/\/a\.example\//, slow], [/https:\/\/b\.example\//, slow]]);
    const get = async (u: string) => (await t.ctx.fetch(u)).text(); // the host slot is held until the body is read
    await Promise.all([get('https://a.example/1'), get('https://a.example/2'), get('https://a.example/3')]);
    expect(maxRunning).toBe(1);
    const at = t.fetch.pages().map((c) => c.at);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(1500);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(1500);
  });

  it('retries 5xx with exponential backoff and jitter, then reports provider_unavailable', async () => {
    const sleeps: number[] = [];
    const clock = fakeClock();
    const f = fakeFetch(clock, [['https://a.example/x', status(503)]]);
    const net = createNetwork({ fetch: f.fetch, clock, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5, gapMs: 0 });
    await expect(net.forProvider('p').fetch('https://a.example/x')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(f.pages()).toHaveLength(3);
    expect(sleeps.filter((s) => s > 0)).toEqual([500 + 250, 1000 + 250]);
  });

  it('recovers when a retry succeeds', async () => {
    let n = 0;
    const t = testContext([['https://a.example/x', () => (++n < 2 ? status(502) : text('ok'))]]);
    const res = await t.ctx.fetch('https://a.example/x');
    expect(await res.text()).toBe('ok');
    expect(t.net.circuit().state).toBe('closed');
  });

  it('opens the circuit on 403 (shown in the provider state), refuses without a request, half-opens later', async () => {
    let blocked = true;
    const t = testContext([['https://a.example/x', () => (blocked ? status(403) : text('ok'))]]);
    await expect(t.ctx.fetch('https://a.example/x')).rejects.toMatchObject({ code: 'provider_blocked' });
    const state = t.net.circuit();
    expect(state.state).toBe('open');
    expect(state.retryAt).toBeGreaterThan(t.clock.now());
    const before = t.fetch.calls.length;
    await expect(t.ctx.fetch('https://a.example/y')).rejects.toMatchObject({ code: 'provider_blocked', retryAt: state.retryAt });
    expect(t.fetch.calls).toHaveLength(before);
    t.clock.advance(31 * 60_000);
    expect(t.net.circuit().state).toBe('half_open');
    blocked = false;
    expect(await (await t.ctx.fetch('https://a.example/x')).text()).toBe('ok');
    expect(t.net.circuit().state).toBe('closed');
  });

  it('opens on 429 and honours Retry-After', async () => {
    const t = testContext([['https://a.example/x', status(429, { 'retry-after': '3600' })]]);
    await expect(t.ctx.fetch('https://a.example/x')).rejects.toMatchObject({ code: 'provider_blocked' });
    expect(t.net.circuit().retryAt).toBe(t.clock.now() + 3_600_000);
  });

  it('a host-scoped provider only pauses the blocked host', async () => {
    const t = testContext([['https://a.example/x', status(403)], ['https://b.example/x', text('fine')]], { scope: 'host' });
    await expect(t.ctx.fetch('https://a.example/x')).rejects.toMatchObject({ code: 'provider_blocked' });
    expect(t.net.circuit().state).toBe('closed');
    expect(t.net.circuitOf('a.example').state).toBe('open');
    expect(await (await t.ctx.fetch('https://b.example/x')).text()).toBe('fine');
  });

  it('refuses disallowed paths from robots.txt before any request, and caches robots.txt for 24 h', async () => {
    const t = testContext([
      ['https://a.example/robots.txt', text('User-agent: *\nDisallow: /search\n', 200, 'text/plain')],
      ['https://a.example/ok', text('ok')],
    ]);
    await expect(t.ctx.fetch('https://a.example/search?q=1')).rejects.toMatchObject({ code: 'robots_disallowed' });
    expect(t.fetch.pages()).toHaveLength(0);
    await (await t.ctx.fetch('https://a.example/ok')).text();
    expect(t.fetch.calls.filter((c) => c.url.endsWith('/robots.txt'))).toHaveLength(1);
    t.clock.advance(23 * 3_600_000);
    await (await t.ctx.fetch('https://a.example/ok')).text();
    expect(t.fetch.calls.filter((c) => c.url.endsWith('/robots.txt'))).toHaveLength(1);
    t.clock.advance(2 * 3_600_000);
    await (await t.ctx.fetch('https://a.example/ok')).text();
    expect(t.fetch.calls.filter((c) => c.url.endsWith('/robots.txt'))).toHaveLength(2);
  });

  it('times out after the configured deadline (10 s by default) as provider_unavailable', async () => {
    const t = testContext([['https://a.example/slow', hang]], { network: { timeoutMs: 20, maxRetries: 0 } });
    await expect(t.ctx.fetch('https://a.example/slow')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(createNetwork({ clock: fakeClock() }).timeoutMs).toBe(10_000);
    expect(createNetwork({ clock: fakeClock() }).gapMs).toBe(1500);
  });

  it('follows redirects on the same host only', async () => {
    const t = testContext([
      ['https://a.example/old', status(301, { location: '/new' })],
      ['https://a.example/new', text('moved')],
      ['https://a.example/away', status(302, { location: 'https://evil.example/x' })],
    ]);
    expect(await (await t.ctx.fetch('https://a.example/old')).text()).toBe('moved');
    await expect(t.ctx.fetch('https://a.example/away')).rejects.toMatchObject({ code: 'url_not_allowed' });
    expect(t.fetch.calls.some((c) => c.url.includes('evil.example'))).toBe(false);
  });

  it('caps response bodies', async () => {
    const res = new Response(new Uint8Array(100));
    await expect(readBytesCapped(res, 50)).rejects.toBeInstanceOf(ProviderError);
  });
});
