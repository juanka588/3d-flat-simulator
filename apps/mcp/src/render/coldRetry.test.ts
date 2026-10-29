import { describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING, type SceneResponse } from '@flat/scene';
import { BrowserRenderer, type RenderRequest } from './browserRenderer';
import { sidecarBusyProbe } from '../imagegen/sidecarBusy';

/**
 * The cold-start policy of the renderer, without a browser: a fake page session stands in. (The real second close-gap run lost two
 * targets to "the browser start took longer than 60 s" while the 38 GB image model was generating.)
 */

const png = Buffer.from('x');
const output = { data: png, mimeType: 'image/png' as const, width: 8, height: 8, sceneLoaded: true, sun: { available: false }, lampsLit: [], appliedPose: null, contextLost: false, pixels: { stddev: 1, mean: 1, colors: 9, topShare: 0.1, pixels: 64 }, models: { loading: [], sources: {}, reasons: {} } };

function fakeSession(startDurationsMs: number[]) {
  const s = {
    warm: false,
    starts: 0,
    discards: 0,
    get isWarm() {
      return s.warm;
    },
    diagnostics: [] as string[],
    stats: {},
    async warmUp() {
      const ms = startDurationsMs[s.starts++] ?? 0;
      await new Promise((ok) => setTimeout(ok, ms));
      s.warm = true;
    },
    async render() {
      return { out: output, warm: s.warm };
    },
    async discard() {
      s.discards++;
      s.warm = false;
    },
    async close() {
      s.warm = false;
    },
  };
  return s;
}

const req = { scene: { scene: {} } as SceneResponse, pose: {} as never, lighting: DEFAULT_LIGHTING as never, size: { width: 8, height: 8 } } satisfies RenderRequest;

function make(session: ReturnType<typeof fakeSession>, opts: ConstructorParameters<typeof BrowserRenderer>[0]) {
  const r = new BrowserRenderer({ webUrl: 'http://127.0.0.1:1/', idleMs: 60_000, ...opts });
  (r as unknown as { session: unknown }).session = session;
  return r;
}

describe('cold browser start under load', () => {
  it('a start that times out is retried once with twice the budget and then succeeds', async () => {
    const s = fakeSession([300, 10]); // first start takes 300 ms (budget 100), the retry 10 ms
    const logs: string[] = [];
    const r = make(s, { coldTimeoutMs: 100, timeoutMs: 100, log: (_l, m) => logs.push(m) });
    const out = await r.render(req);
    expect(out.data).toEqual(png);
    expect(s.starts).toBe(2);
    expect(s.discards).toBe(1);
    expect(logs.join('\n')).toMatch(/retrying with a fresh browser and twice the budget/);
    await r.close();
  });

  it('fails with render_timeout only after the retry also timed out, saying how many attempts', async () => {
    const s = fakeSession([2000, 2000]);
    const r = make(s, { coldTimeoutMs: 50, timeoutMs: 50 });
    await expect(r.render(req)).rejects.toMatchObject({ code: 'render_timeout', message: expect.stringMatching(/browser start took longer than .* \(last of 2 attempts\)/) });
    expect(s.starts).toBe(2);
    await r.close();
  });

  it('coldRetries 0 keeps the old one-shot behaviour', async () => {
    const s = fakeSession([2000]);
    const r = make(s, { coldTimeoutMs: 50, timeoutMs: 50, coldRetries: 0 });
    await expect(r.render(req)).rejects.toMatchObject({ code: 'render_timeout' });
    expect(s.starts).toBe(1);
    await r.close();
  });
});

describe('the renderer waits for the image sidecar queue to drain', () => {
  it('does not start the browser while the sidecar generates, then renders', async () => {
    const s = fakeSession([0]);
    let probes = 0;
    const r = make(s, { drainPollMs: 10, drainMaxMs: 5000, sidecarBusy: async () => ++probes <= 3 });
    const t0 = Date.now();
    await r.render(req);
    expect(probes).toBe(4);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(20);
    expect(s.starts).toBe(1);
    await r.close();
  });

  it('gives up waiting after drainMaxMs and gives the browser start three times the budget', async () => {
    const s = fakeSession([120]); // 120 ms start: over the 50 ms cold budget, within 3x
    const r = make(s, { coldTimeoutMs: 50, timeoutMs: 50, coldRetries: 0, drainPollMs: 5, drainMaxMs: 30, sidecarBusy: async () => true });
    await r.render(req);
    expect(s.starts).toBe(1);
    await r.close();
  });

  it('a failing probe means idle', async () => {
    const s = fakeSession([0]);
    const r = make(s, { sidecarBusy: async () => Promise.reject(new Error('down')) });
    await r.render(req);
    await r.close();
  });
});

describe('sidecarBusyProbe', () => {
  const health = (queue: unknown, ok = true) => (async () => ({ ok, json: async () => ({ queue }) }) as Response) as unknown as typeof fetch;
  it('is busy when a job runs or is queued, idle otherwise, idle when unreachable', async () => {
    expect(await sidecarBusyProbe({}, health({ queued: 0, running: 'abc' }))!()).toBe(true);
    expect(await sidecarBusyProbe({}, health({ queued: 2, running: null }))!()).toBe(true);
    expect(await sidecarBusyProbe({}, health({ queued: 0, running: null }))!()).toBe(false);
    expect(await sidecarBusyProbe({}, (async () => Promise.reject(new Error('refused'))) as unknown as typeof fetch)!()).toBe(false);
  });
  it('is off for other providers and with FLAT_RENDER_WAIT_SIDECAR=0', () => {
    expect(sidecarBusyProbe({ IMAGE_PROVIDER: 'fake' })).toBeUndefined();
    expect(sidecarBusyProbe({ FLAT_RENDER_WAIT_SIDECAR: '0' })).toBeUndefined();
  });
});
