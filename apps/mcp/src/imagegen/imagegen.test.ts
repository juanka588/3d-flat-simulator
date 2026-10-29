import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadStyles } from '../styles';
import { GeminiImageProvider, OpenAIImageProvider } from './apiProviders';
import { FakeImageProvider, TINY_PNG_B64 } from './fake';
import { LocalSidecarProvider } from './localSidecar';
import { ROOM_TEMPLATES, buildReferencePrompt, buildVisualisationPrompt } from './prompts';
import { ImageProviderError, type GenerateRequest, type ImageInput } from './types';
import { providerFromEnv } from './wiring';

const own: ImageInput = { provenance: 'pass', data: TINY_PNG_B64, mimeType: 'image/png' };
const req: GenerateRequest = { prompt: 'a bathroom', seed: 3, n: 2, width: 1024, height: 768, controls: [{ type: 'canny', image: own, strength: 1 }] };

describe('FakeImageProvider', () => {
  it('returns n fixed images with consecutive seeds and records the request', async () => {
    const p = new FakeImageProvider();
    const s = await p.generate(req);
    expect(s.status).toBe('done');
    expect(s.images.map((i) => i.seed)).toEqual([3, 4]);
    expect(p.generated).toEqual([req]);
    expect((await p.health()).ok).toBe(true);
  });

  it('can stay running for a few polls, fail, and be cancelled', async () => {
    const p = new FakeImageProvider();
    p.pendingPolls = 2;
    const first = await p.generate(req);
    expect(first.status).toBe('running');
    expect((await p.poll(first.jobId)).status).toBe('running');
    expect((await p.poll(first.jobId)).status).toBe('done');
    p.failWith = 'boom';
    expect((await p.generate(req)).error).toBe('boom');
    await p.cancel('x');
    expect(p.cancelled).toEqual(['x']);
    await expect(p.poll('nope')).rejects.toMatchObject({ code: 'job_not_found' });
  });
});

describe('hosted providers (stubs)', () => {
  it('are disabled without their key and never send anything', async () => {
    for (const P of [OpenAIImageProvider, GeminiImageProvider]) {
      const p = new P({});
      await expect(p.generate(req)).rejects.toMatchObject({ code: 'provider_disabled' });
      expect(await p.health()).toMatchObject({ ok: false, reason: expect.stringContaining('disabled') });
    }
  });

  it('refuse any image that is not our own render or pass, before anything else', async () => {
    const stolen = { provenance: 'product', data: TINY_PNG_B64, mimeType: 'image/png' } as unknown as ImageInput;
    for (const [P, key] of [
      [OpenAIImageProvider, 'OPENAI_API_KEY'],
      [GeminiImageProvider, 'GEMINI_API_KEY'],
    ] as const) {
      const p = new P({ [key]: 'sk-secret-value' });
      await expect(p.generate({ ...req, controls: [{ type: 'canny', image: stolen, strength: 1 }] })).rejects.toMatchObject({ code: 'provider_refused' });
      await expect(p.edit({ image: stolen, prompt: 'x', seed: 1, strength: 0.5 })).rejects.toMatchObject({ code: 'provider_refused' });
      // our own images pass the guard and reach the stub, which sends nothing
      await expect(p.generate(req)).rejects.toMatchObject({ code: 'not_implemented' });
      const err = await p.edit({ image: own, prompt: 'x', seed: 1, strength: 0.5 }).catch((e: Error) => e);
      expect(String((err as Error).message)).not.toContain('sk-secret-value');
    }
  });

  it('is chosen by IMAGE_PROVIDER; local is the default', () => {
    expect(providerFromEnv({}).id).toBe('local');
    expect(providerFromEnv({ IMAGE_PROVIDER: 'openai' }).id).toBe('openai');
    expect(providerFromEnv({ IMAGE_PROVIDER: 'gemini' }).id).toBe('gemini');
  });
});

describe('LocalSidecarProvider', () => {
  const out = mkdtempSync(join(tmpdir(), 'imagegen-test-'));
  interface Call {
    method: string;
    path: string;
    body?: Record<string, unknown>;
    auth?: string | null;
  }
  const png = Buffer.from(TINY_PNG_B64, 'base64');

  /** A fake sidecar: scripted job statuses, image bytes for the download routes. */
  function sidecar(statuses: Record<string, unknown>[], extra: { imageStatus?: number } = {}) {
    const calls: Call[] = [];
    let i = 0;
    const f = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const call: Call = { method: init?.method ?? 'GET', path: u.pathname + u.search, auth: new Headers(init?.headers).get('authorization') };
      if (init?.body) call.body = JSON.parse(init.body as string);
      calls.push(call);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
      if (u.pathname === '/generate' || u.pathname === '/edit') return json({ jobId: 'abcdef0123456789' }, 202);
      if (/\/images\/\d$/.test(u.pathname)) {
        if (extra.imageStatus) return json({ ok: false, code: 'not_implemented', message: 'no Pillow' }, extra.imageStatus);
        return new Response(png, { headers: { 'Content-Type': u.searchParams.has('maxSide') ? 'image/jpeg' : 'image/png' } });
      }
      if (u.pathname.startsWith('/jobs/')) return json(statuses[Math.min(i++, statuses.length - 1)]);
      if (u.pathname === '/health') return json({ ready: true, models: [{ id: 'qwen-cn', downloaded: true }] });
      return json({ ok: false, message: 'nope' }, 404);
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const done = { jobId: 'abcdef0123456789', status: 'done', progress: 1, images: [{ path: '/remote/out/a-s3.png', seed: 3, seconds: 88.2, peakGb: 38.1 }] };

  const make = (f: typeof fetch, over: Record<string, unknown> = {}) => new LocalSidecarProvider({ url: 'http://sidecar.test:8790/', fetch: f, outDir: out, sleep: async () => {}, ...over });

  afterEach(() => undefined);

  it('submits a generate job with base64 controls and waits for it', async () => {
    const { f, calls } = sidecar([{ ...done, status: 'running', progress: 0.5, images: [] }, done]);
    const s = await make(f).generate({ ...req, negativePrompt: 'sofa', steps: 8 }, { waitMs: 10_000 });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/generate' });
    expect(calls[0]!.body).toEqual({ prompt: 'a bathroom', negativePrompt: 'sofa', seed: 3, n: 2, width: 1024, height: 768, model: 'qwen-cn', steps: 8, controls: [{ type: 'canny', image: TINY_PNG_B64, strength: 1 }] });
    expect(s).toMatchObject({ status: 'done', jobId: 'abcdef0123456789' });
    // a remote path is downloaded to outDir; a preview comes from the sidecar
    expect(s.images[0]).toMatchObject({ seed: 3, seconds: 88.2, peakGb: 38.1 });
    expect(readFileSync(s.images[0]!.path)).toEqual(png);
    expect(s.images[0]!.path.startsWith(out)).toBe(true);
    expect(s.images[0]!.preview).toMatchObject({ mimeType: 'image/jpeg' });
  });

  it('returns the running status when waitMs is 0 and keeps an existing local file as is', async () => {
    const { f } = sidecar([{ jobId: 'abcdef0123456789', status: 'running', progress: 0.25, images: [] }]);
    expect(await make(f).generate(req)).toMatchObject({ status: 'running', progress: 0.25, images: [] });
    const local = join(out, 'already-here.png');
    writeFileSync(local, png);
    const g = sidecar([{ ...done, images: [{ path: local, seed: 1, seconds: 1 }] }]);
    const s = await make(g.f).poll('abcdef0123456789');
    expect(s.images[0]!.path).toBe(local);
    expect(g.calls.some((c) => c.path.endsWith('/images/0'))).toBe(false); // no download of the full image
  });

  it('sends edits with the optional size and the bearer token (and never puts the token in errors)', async () => {
    const { f, calls } = sidecar([done]);
    await make(f, { token: 'tok-123' }).edit({ image: { provenance: 'render', data: TINY_PNG_B64, mimeType: 'image/png' }, prompt: 'photo', seed: 1, strength: 0.4, width: 1024, height: 768 });
    expect(calls[0]).toMatchObject({ path: '/edit', auth: 'Bearer tok-123' });
    expect(calls[0]!.body).toEqual({ image: TINY_PNG_B64, prompt: 'photo', seed: 1, strength: 0.4, model: 'klein-edit', width: 1024, height: 768 });
    const unauthorized = (async () => new Response(JSON.stringify({ message: 'x' }), { status: 401 })) as unknown as typeof fetch;
    const err = (await make(unauthorized, { token: 'tok-123' }).generate(req).catch((e: Error) => e)) as ImageProviderError;
    expect(err.code).toBe('provider_refused');
    expect(err.message).not.toContain('tok-123');
  });

  it('has no preview when the sidecar cannot make one', async () => {
    const { f } = sidecar([done], { imageStatus: 501 });
    await expect(make(f).poll('abcdef0123456789')).rejects.toBeInstanceOf(ImageProviderError); // the full download is required, so this fails loudly
    const g = sidecar([{ ...done, images: [{ path: join(out, 'already-here.png'), seed: 1, seconds: 1 }] }], { imageStatus: 501 });
    expect((await make(g.f).poll('abcdef0123456789')).images[0]!.preview).toBeUndefined();
  });

  it('maps failures to stable codes', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(make(down).generate(req)).rejects.toMatchObject({ code: 'provider_unreachable', message: expect.stringContaining('pnpm imagegen') });
    const status = (code: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status: code })) as unknown as typeof fetch;
    await expect(make(status(400, { message: 'width must be a multiple of 32' })).generate(req)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(make(status(409, { code: 'model_missing', message: 'not in the cache' })).generate(req)).rejects.toMatchObject({ code: 'provider_failed' });
    await expect(make(status(403, { message: 'host not allowed' })).generate(req)).rejects.toMatchObject({ code: 'provider_refused' });
    await expect(make(status(404, { message: 'no such job' })).poll('abcdef0123456789')).rejects.toMatchObject({ code: 'job_not_found' });
  });

  it('health reports usable only when a model is downloaded', async () => {
    expect(await make(sidecar([]).f).health()).toMatchObject({ ok: true });
    const none = (async () => new Response(JSON.stringify({ ready: true, models: [{ id: 'qwen-cn', downloaded: false }] }))) as unknown as typeof fetch;
    expect(await make(none).health()).toMatchObject({ ok: false, reason: expect.stringContaining('imagegen:setup') });
    const down = (async () => {
      throw new TypeError('x');
    }) as unknown as typeof fetch;
    expect((await make(down).health()).ok).toBe(false);
  });
});

describe('room-type-aware prompts', () => {
  const styles = loadStyles();
  const japandi = styles.find((s) => s.meta.id === 'japandi')!.meta;

  it('a bathroom asks for bathroom fixtures and never for a sofa', () => {
    const p = buildReferencePrompt(japandi, 'bathroom');
    expect(p.prompt).toMatch(/bathtub|shower/);
    expect(p.prompt).toMatch(/basin/);
    expect(p.prompt).not.toMatch(/sofa/i);
    expect(p.negativePrompt).toMatch(/sofa/);
    expect(p.negativePrompt).toMatch(/living room/);
  });

  it('a bedroom has a bed and drops sofa-centred forms', () => {
    const p = buildReferencePrompt({ ...japandi, forms: ['low sofas and beds close to the floor', 'clean horizontal lines', 'rounded soft corners'] }, 'bedroom');
    expect(p.prompt).toMatch(/double bed/);
    expect(p.prompt).not.toMatch(/low sofas/);
    expect(p.negativePrompt).toMatch(/sofa/);
  });

  it('every room type has a template; the room decides the furnishing and the style the look', () => {
    const subjects = new Set<string>();
    for (const type of Object.keys(ROOM_TEMPLATES) as (keyof typeof ROOM_TEMPLATES)[]) {
      for (const s of styles) {
        const p = buildReferencePrompt(s.meta, type);
        expect(p.prompt).toContain(s.meta.name);
        expect(p.prompt).toContain(ROOM_TEMPLATES[type].furnishings);
        expect(p.prompt.length).toBeLessThan(1500);
        expect(p.prompt).not.toMatch(/\[object|undefined/);
      }
      subjects.add(ROOM_TEMPLATES[type].subject);
    }
    expect(subjects.size).toBe(Object.keys(ROOM_TEMPLATES).length);
    expect(buildReferencePrompt(japandi, 'kitchen').prompt).toMatch(/cabinets/);
    expect(buildReferencePrompt(japandi, 'hallway').prompt).toMatch(/entrance hall/);
    expect(buildReferencePrompt(japandi, 'office').prompt).toMatch(/desk/);
    expect(buildReferencePrompt(japandi, 'balcony').prompt).toMatch(/bistro table/);
  });

  it('view extras: the kitchen zone of a living room uses the kitchen template; the layout and the view hint go in the prompt', () => {
    const k = buildReferencePrompt(japandi, 'living', { zone: 'kitchen', viewHint: 'The camera faces the kitchen fittings.' });
    expect(k.prompt).toMatch(/open kitchen of a flat/);
    expect(k.prompt).toMatch(/cabinets/);
    expect(k.prompt).toMatch(/camera faces the kitchen fittings/);
    expect(k.negativePrompt).not.toMatch(/kitchen counter/);
    const l = buildReferencePrompt(japandi, 'living', { layout: 'Layout: the sofa faces the TV wall.', kitchenVisible: true });
    expect(l.prompt).toMatch(/Layout: the sofa faces the TV wall\./);
    expect(l.prompt).toMatch(/open kitchen in the background/);
    expect(l.negativePrompt).not.toMatch(/kitchen counter/);
    // without extras nothing changes
    expect(buildReferencePrompt(japandi, 'living').negativePrompt).toMatch(/kitchen counter/);
  });

  it('the visualisation prompt keeps the layout', () => {
    expect(buildVisualisationPrompt(japandi, 'living').prompt).toMatch(/Keep the room layout/);
  });
});
