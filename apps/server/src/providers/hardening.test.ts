import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MemoryCache } from './cache';
import { createNetwork } from './http';
import { createIkeaFrProvider, parseSearchResponse, pickModelRef, safeAssetUrl, safePageUrl } from './ikea-fr';
import { createPastedUrlProvider } from './pasted-url';
import { createPinnedFetch } from './pinned';
import { createProviderRegistry, SEEN_MAX_IDS, SEEN_MAX_SESSIONS } from './registry';
import { createSecrets } from './secrets';
import { fakeClock, fakeFetch, fixture, json, status, testContext, text, type Handler } from './testkit';
import type { ProviderContext } from './types';

const searchJson = () => JSON.parse(fixture('ikea-fr/search-kallax.json'));

// ---------------------------------------------------------------------------------------------
// M3: IKEA URLs from the search JSON are validated
// ---------------------------------------------------------------------------------------------
describe('ikea-fr: URLs taken from responses must point at IKEA', () => {
  const tamper = (pipUrl: string, mainImageUrl = 'https://www.ikea.com/fr/fr/images/products/x.jpg') => {
    const j = searchJson();
    const p = j.searchResultPage.products.main.items[0].product;
    p.pipUrl = pipUrl;
    p.mainImageUrl = mainImageUrl;
    p.gprDescription.variants[0].pipUrl = pipUrl;
    return j;
  };
  const REBUILT = 'https://www.ikea.com/fr/fr/p/-80275887/';

  it('accepts only https://www.ikea.com/fr/fr/p/ pages and IKEA asset hosts', () => {
    expect(safePageUrl('https://www.ikea.com/fr/fr/p/kallax-etagere-blanc-80275887/')).toBeDefined();
    for (const bad of [
      'http://www.ikea.com/fr/fr/p/x-80275887/',
      'https://www.ikea.com:8443/fr/fr/p/x/',
      'https://www.ikea.com@127.0.0.1/fr/fr/p/x/',
      'https://user:pw@www.ikea.com/fr/fr/p/x/',
      'https://www.ikea.com/fr/fr/',
      'https://www.ikea.com/de/de/p/x/',
      'https://ikea.com.evil.example/fr/fr/p/x/',
      'https://127.0.0.1/fr/fr/p/x-80275887/',
      'https://169.254.169.254/fr/fr/p/x/',
      '/fr/fr/p/x-80275887/',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ]) {
      expect([bad, safePageUrl(bad)]).toEqual([bad, undefined]);
    }
    expect(safeAssetUrl('https://web-api.ikea.com/dimma/assets/1.2/a.glb')).toBeDefined();
    expect(safeAssetUrl('https://www.ikea.com/fr/fr/images/products/a.jpg')).toBeDefined();
    for (const bad of ['https://evil.example/a.jpg', 'http://www.ikea.com/a.jpg', 'https://127.0.0.1/a.jpg', 'https://169.254.169.254/latest/meta-data/', 'https://www.ikea.com.evil.example/a.jpg']) {
      expect(safeAssetUrl(bad)).toBeUndefined();
    }
  });

  it('a tampered pipUrl / vurl is replaced by the URL rebuilt from the sku; tampered photos are dropped', () => {
    for (const evil of ['http://127.0.0.1:8080/fr/fr/p/x-80275887/', 'https://169.254.169.254/latest/meta-data/', 'https://www.ikea.com/fr/fr/p/other-99999999/']) {
      const hits = parseSearchResponse(tamper(evil, 'https://169.254.169.254/photo.jpg'));
      expect(hits[0]!.url).toBe(REBUILT);
      expect(hits[0]!.photoUrl).toBeUndefined();
      expect(hits[0]!.variants[0]!.url ?? 'https://www.ikea.com/fr/fr/p/ok/').toMatch(/^https:\/\/www\.ikea\.com\/fr\/fr\/p\//);
    }
    expect(parseSearchResponse(tamper('https://127.0.0.1/x'))[0]!.variants[0]!.url).toBeUndefined();
    expect(parseSearchResponse(searchJson())[0]!.url).toBe('https://www.ikea.com/fr/fr/p/kallax-etagere-blanc-80275887/');
    expect(parseSearchResponse(searchJson())[0]!.photoUrl).toMatch(/^https:\/\/www\.ikea\.com\//);
  });

  it('model refs must be on web-api.ikea.com', () => {
    const node = (u: string) => ({ encoding: [{ contentUrl: u }] });
    expect(pickModelRef(node('https://web-api.ikea.com/dimma/assets/1.2/80275887/a/iqp1/glb_draco/h-x.glb?cn=pip'))).toBeDefined();
    for (const bad of [
      'https://127.0.0.1/dimma/assets/1.2/a.glb',
      'https://web-api.ikea.com.evil.example/dimma/assets/1.2/a.glb',
      'https://web-api.ikea.com/dimma/assets/../../x.glb',
      'http://web-api.ikea.com/dimma/assets/1.2/a.glb',
    ]) {
      expect([bad, pickModelRef(node(bad))]).toEqual([bad, undefined]);
    }
  });

  it('a tampered response never makes the provider fetch a loopback or metadata address', async () => {
    for (const evil of ['http://127.0.0.1:8080/fr/fr/p/kallax-80275887/', 'https://169.254.169.254/fr/fr/p/kallax-80275887/', 'https://127.0.0.1/fr/fr/p/kallax-80275887/']) {
      const t = testContext(
        [
          ['https://sik.search.blue.cdtapps.com/fr/fr/search-result-page*', json(tamper(evil, 'http://127.0.0.1/x.jpg'))],
          [/^https:\/\/www\.ikea\.com\/fr\/fr\/p\//, text(fixture('ikea-fr/product-kallax-80275887.html'))],
        ],
        { id: 'ikea-fr' },
      );
      const out = await createIkeaFrProvider().search('kallax', { limit: 1 }, t.ctx);
      expect(out).toHaveLength(1);
      expect(out[0]!.url).toMatch(/^https:\/\/www\.ikea\.com\/fr\/fr\/p\//);
      const urls = t.fetch.calls.map((c) => c.url);
      expect(urls.some((u) => /127\.0\.0\.1|169\.254\.169\.254/.test(u))).toBe(false);
      expect(urls).toContain('https://www.ikea.com/fr/fr/p/-80275887/');
    }
  });

  it('the page itself cannot smuggle a foreign url or photo into the record', async () => {
    const html = fixture('ikea-fr/product-kallax-80275887.html')
      .replaceAll('https://www.ikea.com/fr/fr/p/kallax-etagere-blanc-80275887/', 'https://127.0.0.1/evil')
      .replace(/https:\/\/www\.ikea\.com\/fr\/fr\/images\/products\/[^"]+/g, 'https://169.254.169.254/img.jpg');
    const t = testContext([[/^https:\/\/www\.ikea\.com\/fr\/fr\/p\//, text(html)]], { id: 'ikea-fr' });
    const rec = await createIkeaFrProvider().get('80275887', t.ctx);
    expect(rec.url).toBe('https://www.ikea.com/fr/fr/p/-80275887/');
    expect(rec.photoUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// M4: circuit gate inside the host slot, one half-open probe
// ---------------------------------------------------------------------------------------------
describe('circuit breaker: gate re-checked right before each attempt', () => {
  it('calls queued before a 403 never reach the retailer after it', async () => {
    const t = testContext([['https://a.example/p*', () => status(403)]]);
    const results = await Promise.allSettled([1, 2, 3, 4].map((i) => t.ctx.fetch(`https://a.example/p${i}`)));
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'provider_blocked' });
    }
    expect(t.fetch.pages()).toHaveLength(1);
  });

  it('half-open: a failing probe re-opens the circuit and the calls queued behind it are refused; a good probe closes it', async () => {
    let answer: 'blocked' | 'ok' = 'blocked';
    const t = testContext([['https://a.example/p*', () => (answer === 'blocked' ? status(403) : text('ok'))]]);
    await expect(t.ctx.fetch('https://a.example/p0')).rejects.toMatchObject({ code: 'provider_blocked' });
    t.clock.advance(31 * 60_000);
    expect(t.net.circuit().state).toBe('half_open');
    const before = t.fetch.pages().length;
    const results = await Promise.allSettled([1, 2, 3].map((i) => t.ctx.fetch(`https://a.example/p${i}`)));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(t.fetch.pages().length - before).toBe(1); // exactly one probe
    expect(t.net.circuit().state).toBe('open');
    t.clock.advance(31 * 60_000);
    answer = 'ok';
    const ok = await Promise.all([1, 2, 3].map(async (i) => (await t.ctx.fetch(`https://a.example/p${i}`)).text()));
    expect(ok).toEqual(['ok', 'ok', 'ok']);
    expect(t.net.circuit().state).toBe('closed');
  });

  it('a probe that fails with a 5xx also re-opens a blocked circuit', async () => {
    let mode: 'blocked' | 'down' = 'blocked';
    const t = testContext([['https://a.example/p*', () => (mode === 'blocked' ? status(403) : status(503))]], { network: { maxRetries: 0 } });
    await expect(t.ctx.fetch('https://a.example/p0')).rejects.toMatchObject({ code: 'provider_blocked' });
    t.clock.advance(31 * 60_000);
    mode = 'down';
    await expect(t.ctx.fetch('https://a.example/p1')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(t.net.circuit().state).toBe('open');
  });
});

// ---------------------------------------------------------------------------------------------
// M5: robots.txt
// ---------------------------------------------------------------------------------------------
describe('robots.txt: fail closed, follow same-host redirects, cache only real answers', () => {
  const robotsCalls = (t: ReturnType<typeof testContext>) => t.fetch.calls.filter((c) => c.url.endsWith('robots.txt'));

  it('follows a same-host redirect and applies the rules found there', async () => {
    const t = testContext([
      ['https://a.example/robots.txt', status(301, { location: '/moved/robots.txt' })],
      ['https://a.example/moved/robots.txt', text('User-agent: *\nDisallow: /secret\n', 200, 'text/plain')],
      ['https://a.example/ok', text('ok')],
    ]);
    await expect(t.ctx.fetch('https://a.example/secret')).rejects.toMatchObject({ code: 'robots_disallowed' });
    expect(await (await t.ctx.fetch('https://a.example/ok')).text()).toBe('ok');
    expect(robotsCalls(t).map((c) => c.url)).toEqual(['https://a.example/robots.txt', 'https://a.example/moved/robots.txt']); // cached after
  });

  it('a redirect off the host refuses the request and is not cached', async () => {
    const t = testContext([['https://a.example/robots.txt', status(302, { location: 'https://evil.example/robots.txt' })], ['https://a.example/ok', text('ok')]]);
    await expect(t.ctx.fetch('https://a.example/ok')).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(t.ctx.fetch('https://a.example/ok')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(robotsCalls(t)).toHaveLength(2);
    expect(t.fetch.calls.some((c) => c.url.includes('evil.example'))).toBe(false);
    expect(t.fetch.pages()).toHaveLength(0);
  });

  it.each([403, 429])('%i on robots.txt: refuses, opens the circuit, is not cached as allow-all', async (code) => {
    let allowed = false;
    const t = testContext([
      ['https://a.example/robots.txt', () => (allowed ? text('User-agent: *\nAllow: /\n', 200, 'text/plain') : status(code, code === 429 ? { 'retry-after': '120' } : {}))],
      ['https://a.example/ok', text('ok')],
    ]);
    await expect(t.ctx.fetch('https://a.example/ok')).rejects.toMatchObject({ code: 'provider_blocked' });
    expect(t.net.circuit().state).toBe('open');
    expect(t.fetch.pages()).toHaveLength(0);
    const n = t.fetch.calls.length;
    await expect(t.ctx.fetch('https://a.example/ok')).rejects.toMatchObject({ code: 'provider_blocked' });
    expect(t.fetch.calls).toHaveLength(n); // circuit open: nothing leaves
    t.clock.advance(31 * 60_000);
    allowed = true;
    expect(await (await t.ctx.fetch('https://a.example/ok')).text()).toBe('ok');
    expect(robotsCalls(t)).toHaveLength(2); // nothing was cached from the refusal
  });

  it.each([404, 410])('%i means "no robots file": allow all, cached for 24 h', async (code) => {
    const t = testContext([['https://a.example/robots.txt', status(code)], ['https://a.example/ok', text('ok')]]);
    await (await t.ctx.fetch('https://a.example/ok')).text();
    await (await t.ctx.fetch('https://a.example/ok')).text();
    expect(robotsCalls(t)).toHaveLength(1);
    expect(t.net.circuit().state).toBe('closed');
  });

  it.each([401, 500, 503])('%i on robots.txt refuses the request without caching', async (code) => {
    const t = testContext([['https://a.example/robots.txt', status(code)], ['https://a.example/ok', text('ok')]]);
    await expect(t.ctx.fetch('https://a.example/ok')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(t.fetch.pages()).toHaveLength(0);
    await expect(t.ctx.fetch('https://a.example/ok')).rejects.toBeDefined();
    expect(robotsCalls(t).length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Low: body-completion gap, body deadline, queue depth
// ---------------------------------------------------------------------------------------------
describe('per-host slot is held until the body is consumed', () => {
  it('the next request waits for the previous body, then for the gap after it', async () => {
    const clock = fakeClock();
    const started: number[] = [];
    const f = fakeFetch(clock, [['https://a.example/robots.txt', text('', 200, 'text/plain')], ['https://a.example/*', () => (started.push(clock.now()), text('ok'))]]);
    const net = createNetwork({ fetch: f.fetch, clock, sleep: clock.sleep, random: () => 0 });
    const pf = net.forProvider('p').fetch;
    const first = await pf('https://a.example/1');
    let secondDone = false;
    const second = pf('https://a.example/2').then((r) => ((secondDone = true), r));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(secondDone).toBe(false);
    expect(started).toHaveLength(1);
    clock.advance(5_000); // the body takes a while to download
    await first.text();
    await (await second).text();
    expect(started).toHaveLength(2);
    expect(started[1]! - (started[0]! + 5_000)).toBeGreaterThanOrEqual(1500); // gap counted from the end of the body
  });

  it('a cancelled body frees the slot', async () => {
    const t = testContext([['https://a.example/*', text('x'.repeat(100))]]);
    const a = await t.ctx.fetch('https://a.example/1');
    await a.body!.cancel();
    expect(await (await t.ctx.fetch('https://a.example/2')).text()).toHaveLength(100);
  });

  it('a slow-drip body is errored after the body deadline and frees the host', async () => {
    // a hand-made fetch: the shared fake buffers whole bodies, which would hide the drip
    const wire = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      if (url.endsWith('/fast')) return new Response('ok');
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1]));
          },
          pull: () => new Promise(() => undefined),
        }),
      );
    }) as typeof fetch;
    const clock = fakeClock();
    const pf = createNetwork({ fetch: wire, clock, sleep: clock.sleep, random: () => 0, bodyTimeoutMs: 30, gapMs: 0 }).forProvider('p').fetch;
    const slow = await pf('https://a.example/slow');
    await expect(slow.arrayBuffer()).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(await (await pf('https://a.example/fast')).text()).toBe('ok');
  });

  it('refuses a request past the per-host queue depth as "busy"', async () => {
    const t = testContext([['https://a.example/*', text('ok')]], { network: { maxQueue: 3, gapMs: 0 } });
    const held = await t.ctx.fetch('https://a.example/0'); // body not read: holds the slot
    const queued = [1, 2].map((i) => t.ctx.fetch(`https://a.example/${i}`));
    await expect(t.ctx.fetch('https://a.example/3')).rejects.toMatchObject({ code: 'provider_unavailable', message: expect.stringContaining('busy') });
    await held.text();
    for (const q of queued) await (await q).text();
  });
});

// ---------------------------------------------------------------------------------------------
// M6: DNS pinning
// ---------------------------------------------------------------------------------------------
type LookupCb = (err: Error | null, address?: unknown, family?: number) => void;
function fakeHttps() {
  const connected: string[][] = [];
  const request = ((opts: { host: string; lookup: (h: string, o: { all: boolean }, cb: LookupCb) => void }, cb: (res: IncomingMessage) => void) => {
    const req = new EventEmitter() as unknown as ClientRequest;
    (req as unknown as { end: () => void }).end = () => {
      opts.lookup(opts.host, { all: true }, (err, addrs) => {
        if (err) return void req.emit('error', err);
        connected.push((addrs as { address: string }[]).map((a) => a.address));
        const res = Readable.from([Buffer.from('<html>page</html>')]) as unknown as IncomingMessage;
        Object.assign(res, { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'text/html' } });
        cb(res);
      });
    };
    return req;
  }) as unknown as typeof httpsRequest;
  return { request, connected };
}

describe('DNS pinning for pasted URLs', () => {
  it('connects to the vetted addresses and returns the page', async () => {
    const h = fakeHttps();
    const pinned = createPinnedFetch({ lookup: async () => ['93.184.216.34'], request: h.request });
    const res = await pinned('https://shop.example/p');
    expect(await res.text()).toBe('<html>page</html>');
    expect(h.connected).toEqual([['93.184.216.34']]);
  });

  it('refuses a name that resolves to a private address AT CONNECT TIME (rebinding), without connecting', async () => {
    for (const second of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '::1', '::ffff:7f00:1', 'fd00::1']) {
      const h = fakeHttps();
      let n = 0;
      // the provider's pre-check is resolution #1 (public); the connection's own lookup is #2 (private)
      const lookup = async () => (++n === 1 ? ['93.184.216.34'] : [second]);
      const clock = fakeClock();
      const net = createNetwork({ clock, sleep: clock.sleep, random: () => 0 });
      const pn = net.forProvider('pasted-url', { scope: 'host', transport: createPinnedFetch({ lookup, request: h.request }) });
      const ctx: ProviderContext = { fetch: pn.fetch, cache: new MemoryCache({ clock }).scope('pasted-url'), clock, log: () => undefined, lookup };
      await expect(createPastedUrlProvider().resolveUrl!('https://rebind.example/p', ctx)).rejects.toMatchObject({ code: 'url_not_allowed' });
      expect([second, n >= 2, h.connected]).toEqual([second, true, []]);
    }
  });

  it('refuses a mixed answer (one public, one private) and an empty answer', async () => {
    const h = fakeHttps();
    await expect(createPinnedFetch({ lookup: async () => ['93.184.216.34', '10.0.0.1'], request: h.request })('https://a.example/')).rejects.toMatchObject({ code: 'url_not_allowed' });
    await expect(createPinnedFetch({ lookup: async () => [], request: h.request })('https://a.example/')).rejects.toMatchObject({ code: 'url_not_allowed' });
    expect(h.connected).toEqual([]);
  });

  it('refuses port 443 of the metadata address and other literals before any lookup or connection', async () => {
    const h = fakeHttps();
    let lookups = 0;
    const pinned = createPinnedFetch({ lookup: async () => (lookups++, ['93.184.216.34']), request: h.request });
    for (const u of ['https://169.254.169.254/latest/meta-data/', 'https://169.254.169.254:443/', 'https://127.0.0.1/', 'https://[::1]/', 'https://[::ffff:169.254.169.254]/', 'https://[fd00:ec2::254]/', 'https://10.1.2.3/']) {
      await expect(pinned(u), u).rejects.toMatchObject({ code: 'url_not_allowed' });
    }
    for (const u of ['https://a.example:8443/', 'http://a.example/', 'https://u:p@a.example/']) {
      await expect(pinned(u), u).rejects.toMatchObject({ code: 'url_not_allowed' });
    }
    expect([lookups, h.connected]).toEqual([0, []]);
  });

  it('the pasted-url provider refuses the metadata IP before the network', async () => {
    const t = testContext([], { id: 'pasted-url', scope: 'host', lookup: async () => ['93.184.216.34'] });
    await expect(createPastedUrlProvider().resolveUrl!('https://169.254.169.254/', t.ctx)).rejects.toMatchObject({ code: 'url_not_allowed' });
    expect(t.fetch.calls).toHaveLength(0);
  });

  it('the registry wires the pinned transport when it uses the real network (the injected lookup is the connection lookup)', async () => {
    let n = 0;
    const reg = await createProviderRegistry({ enabled: ['pasted-url'], lookup: async () => (++n === 1 ? ['93.184.216.34'] : ['10.0.0.9']) });
    await expect(reg.resolveUrl('https://rebind.example/p')).rejects.toMatchObject({ code: 'url_not_allowed' });
    expect(n).toBeGreaterThanOrEqual(2); // pre-check, then the connection's own resolution (refused: no socket was opened)
  });
});

// ---------------------------------------------------------------------------------------------
// Low: secrets, seen registry, photo proxy
// ---------------------------------------------------------------------------------------------
describe('secrets', () => {
  it('redacts short secrets too (one character and up)', () => {
    const s = createSecrets({ FLAT_TOKEN: 'x', FLAT_API_KEY: 'ab', FLAT_EMPTY_TOKEN: '' });
    expect(s.redact('token x and key ab, done')).toBe('token [redacted] and key [redacted], done');
    expect(createSecrets({ FLAT_EMPTY_TOKEN: '' }).redact('plain text')).toBe('plain text');
  });
});

describe('seen registry: LRU by last use', () => {
  it('at the id cap the least recently used id goes and the new one stays; a touched id survives', async () => {
    const reg = await createProviderRegistry({ enabled: ['mock'], clock: fakeClock() });
    reg.markSeen('s', Array.from({ length: SEEN_MAX_IDS }, (_, i) => `mock:${i}`));
    expect(reg.isSeen('s', 'mock:0')).toBe(true); // touch the oldest
    expect(reg.markSeen('s', ['mock:new'])).toBe(SEEN_MAX_IDS);
    expect(reg.isSeen('s', 'mock:new')).toBe(true);
    expect(reg.isSeen('s', 'mock:0')).toBe(true);
    expect(reg.isSeen('s', 'mock:1')).toBe(false); // the least recently used
    expect(reg.isSeen('s', 'mock:2')).toBe(true);
  });

  it('at the session cap the least recently used session goes', async () => {
    const reg = await createProviderRegistry({ enabled: ['mock'], clock: fakeClock() });
    for (let i = 0; i < SEEN_MAX_SESSIONS; i++) reg.markSeen(`s${i}`, ['mock:a']);
    expect(reg.isSeen('s0', 'mock:a')).toBe(true); // s0 is used again: s1 is now the LRU
    reg.markSeen('fresh', ['mock:a']);
    expect(reg.isSeen('s0', 'mock:a')).toBe(true);
    expect(reg.isSeen('s1', 'mock:a')).toBe(false);
    expect(reg.isSeen('fresh', 'mock:a')).toBe(true);
  });
});

describe('photo proxy through the registry', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const PHOTO = /^https:\/\/www\.ikea\.com\/fr\/fr\/images\/products\//;
  const boot = async (photo: Handler) => {
    const clock = fakeClock();
    const f = fakeFetch(clock, [
      [/search-result-page/, json(searchJson())],
      [/^https:\/\/www\.ikea\.com\/fr\/fr\/p\//, text(fixture('ikea-fr/product-kallax-80275887.html'))],
      [PHOTO, photo],
    ]);
    const reg = await createProviderRegistry({ enabled: ['ikea-fr'], clock, fetch: f.fetch, sleep: clock.sleep, random: () => 0 });
    return { reg, f };
  };

  it('returns the image (MIME sniffed from the bytes), caches it, and asks the retailer once', async () => {
    const { reg, f } = await boot(new Response(JPEG, { headers: { 'content-type': 'text/html' } }));
    const a = await reg.fetchPhoto('ikea-fr:80275887');
    expect(a.contentType).toBe('image/jpeg');
    expect(a.data).toEqual(JPEG);
    await reg.fetchPhoto('ikea-fr:80275887');
    expect(f.calls.filter((c) => PHOTO.test(c.url))).toHaveLength(1);
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('refuses non-images (SVG), oversized photos, and providers without photos', async () => {
    const svg = await boot(new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { headers: { 'content-type': 'image/svg+xml' } }));
    await expect(svg.reg.fetchPhoto('ikea-fr:80275887')).rejects.toMatchObject({ code: 'model_unavailable' });
    const big = await boot(new Response(new Uint8Array(3 * 1024 * 1024).fill(0xff), { headers: { 'content-type': 'image/jpeg' } }));
    await expect(big.reg.fetchPhoto('ikea-fr:80275887')).rejects.toMatchObject({ code: 'model_unavailable' });
    const mock = await createProviderRegistry({ enabled: ['mock'], clock: fakeClock() });
    await expect(mock.fetchPhoto('mock:MOCK-BED-160')).rejects.toMatchObject({ code: 'product_not_found' });
    await expect(mock.fetchPhoto('garbage')).rejects.toMatchObject({ code: 'product_not_found' });
  });
});
