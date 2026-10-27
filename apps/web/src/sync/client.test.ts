import { describe, expect, it, vi } from 'vitest';
import { backoffMs, devProbeDelayMs, normalizeServerUrl, probeServer, readServerParams, resolveTarget } from './client';
import { statusLabel } from './sync-store';

const refuse = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
const answer = (() => Promise.resolve(new Response(null))) as unknown as typeof fetch;

describe('server url', () => {
  it('accepts http(s) origins only', () => {
    expect(normalizeServerUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    expect(normalizeServerUrl('https://flat.example.com/some/path?x=1')).toBe('https://flat.example.com');
    expect(normalizeServerUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeServerUrl('ftp://x')).toBeNull();
    expect(normalizeServerUrl('not a url')).toBeNull();
  });

  it('reads ?server and ?token and builds the address without the token', () => {
    const p = readServerParams('http://localhost:5173/app/?server=http%3A%2F%2F127.0.0.1%3A9000&token=s3cret&test=1#top');
    expect(p).toMatchObject({ server: 'http://127.0.0.1:9000', token: 's3cret', off: false });
    expect(p.withoutToken).toBe('/app/?server=http%3A%2F%2F127.0.0.1%3A9000&test=1#top');
    expect(readServerParams('http://x/?server=off')).toMatchObject({ server: null, off: true, withoutToken: null });
    expect(readServerParams('http://x/')).toMatchObject({ server: null, token: null });
  });
});

describe('resolveTarget', () => {
  it('?server= works on any build and never probes', async () => {
    const fetchSpy = vi.fn(refuse);
    const t = await resolveTarget({ href: 'https://me.github.io/flat/?server=http://127.0.0.1:8787&token=abc', dev: false, automated: false, fetchImpl: fetchSpy });
    expect(t).toEqual({ url: 'http://127.0.0.1:8787', token: 'abc' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('production without ?server never probes', async () => {
    const fetchSpy = vi.fn(answer);
    expect(await resolveTarget({ href: 'https://me.github.io/flat/', dev: false, automated: false, fetchImpl: fetchSpy })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dev probes the default server once, with a no-cors request', async () => {
    const fetchSpy = vi.fn(answer);
    const t = await resolveTarget({ href: 'http://127.0.0.1:5173/', dev: true, automated: false, fetchImpl: fetchSpy });
    expect(t).toEqual({ url: 'http://127.0.0.1:8787', token: null });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://127.0.0.1:8787/healthz');
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ mode: 'no-cors' });
  });

  it('dev stays local when nothing answers, for automated browsers and for ?server=off', async () => {
    expect(await resolveTarget({ href: 'http://127.0.0.1:5173/', dev: true, automated: false, fetchImpl: refuse })).toBeNull();
    const spy = vi.fn(answer);
    expect(await resolveTarget({ href: 'http://127.0.0.1:5173/', dev: true, automated: true, fetchImpl: spy })).toBeNull();
    expect(await resolveTarget({ href: 'http://127.0.0.1:5173/?server=off', dev: true, automated: false, fetchImpl: spy })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('the probe gives up after its timeout', async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    expect(await probeServer(hang, 'http://127.0.0.1:8787', 20)).toBe(false);
  });
});

describe('backoff and labels', () => {
  it('doubles from 0.5 s up to 10 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffMs)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]);
  });

  it('status chip text', () => {
    expect(statusLabel({ mode: 'local', status: 'connected', rev: 3 })).toBe('Local');
    expect(statusLabel({ mode: 'server', status: 'connected', rev: 3 })).toBe('Connected · rev 3');
    expect(statusLabel({ mode: 'server', status: 'reconnecting', rev: 3 })).toBe('Reconnecting…');
    expect(statusLabel({ mode: 'server', status: 'conflict', rev: 3 })).toBe('Conflict: choose');
  });
});

describe('devProbeDelayMs', () => {
  it('probes every 3 s for the first 30 s, then every 15 s', () => {
    expect(devProbeDelayMs(0)).toBe(3000);
    expect(devProbeDelayMs(29_999)).toBe(3000);
    expect(devProbeDelayMs(30_000)).toBe(15_000);
  });
});
