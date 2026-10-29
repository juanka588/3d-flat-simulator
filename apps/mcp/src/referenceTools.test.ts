import { afterEach, describe, expect, it } from 'vitest';
import { FakeImageProvider, TINY_PNG_B64, setControlImageSource, setImageProvider, type ControlImagesRequest } from './imagegen';
import { connect, json } from './testing/inproc';

const pass = { provenance: 'pass' as const, data: TINY_PNG_B64, mimeType: 'image/png' as const };

function setup(fake = new FakeImageProvider()) {
  const seen: ControlImagesRequest[] = [];
  setImageProvider(fake);
  setControlImageSource({
    async getControlImages(req) {
      seen.push(req);
      return { canny: pass };
    },
  });
  return { fake, seen };
}
afterEach(() => {
  setImageProvider(undefined);
  setControlImageSource(undefined);
});

const call = (client: Awaited<ReturnType<typeof connect>>['client'], args: Record<string, unknown>) => client.callTool({ name: 'generate_reference', arguments: args });
const types = (r: { content: unknown }) => (r.content as { type: string }[]).map((c) => c.type);

describe('generate_reference (mode reference)', () => {
  it('is listed, read-only for the scene, and in the render group', async () => {
    const { client } = await connect();
    const t = (await client.listTools()).tools.find((x) => x.name === 'generate_reference')!;
    expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(t.description!.length).toBeLessThan(700);
  });

  it('asks the provider for canny-controlled images of the room camera, with a bathroom prompt for a bathroom', async () => {
    const { client } = await connect();
    const { fake, seen } = setup();
    const r = await call(client, { roomId: 'sdb', styleId: 'japandi', n: 2, seed: 7 });
    expect(r.isError).toBeFalsy();
    const b = json(r);
    expect(b).toMatchObject({ ok: true, status: 'done', mode: 'reference', kind: 'reference', roomId: 'sdb', styleId: 'japandi', roomType: 'bathroom', seed: 7, provider: 'fake' });
    expect(b.label).toMatch(/^REFERENCE IMAGE/);
    expect(b.prompt).toMatch(/bathtub|shower/);
    expect(b.prompt).not.toMatch(/sofa/i);
    expect(b.images.map((i: { seed: number }) => i.seed)).toEqual([7, 8]);
    expect(types(r)).toEqual(['text', 'image', 'text', 'image', 'text']);
    // the request: canny at strength 1, 1024x768, n, seed, the negative prompt keeps sofas out
    expect(fake.generated).toHaveLength(1);
    expect(fake.generated[0]).toMatchObject({ seed: 7, n: 2, width: 1024, height: 768, model: 'qwen-cn', controls: [{ type: 'canny', strength: 1 }] });
    expect(fake.generated[0]!.negativePrompt).toMatch(/sofa/);
    // the control source got the room's camera and size (the getControlImages(camera) seam)
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ roomId: 'sdb', size: { width: 1024, height: 768 } });
    expect(seen[0]!.pose).toBeDefined();
  });

  it('uses the right furnishing for a bedroom and the living room', async () => {
    const { client } = await connect();
    const { fake } = setup();
    await call(client, { roomId: 'ch1', styleId: 'scandinavian' });
    await call(client, { roomId: 'sejour', styleId: 'scandinavian' });
    expect(fake.generated[0]!.prompt).toMatch(/double bed/);
    expect(fake.generated[1]!.prompt).toMatch(/sofa/);
  });

  it('defaults the seed to 1 and n to 1, and returns at most 4 images', async () => {
    const { client } = await connect();
    const { fake } = setup();
    const b = json(await call(client, { roomId: 'sdb', styleId: 'japandi' }));
    expect(fake.generated[0]).toMatchObject({ seed: 1, n: 1 });
    expect(b.images).toHaveLength(1);
    const over = await call(client, { roomId: 'sdb', styleId: 'japandi', n: 5 });
    expect(over.isError).toBe(true);
    expect(json(over).code).toBe('invalid_command');
  });

  it('a slow job returns its jobId, and the next call collects it', async () => {
    const { client } = await connect();
    const fake = new FakeImageProvider();
    fake.pendingPolls = 1;
    setup(fake);
    const first = json(await call(client, { roomId: 'sdb', styleId: 'japandi', waitS: 0 }));
    expect(first).toMatchObject({ ok: true, status: 'running', mode: 'reference' });
    expect(first.next).toContain(first.jobId);
    const second = await call(client, { jobId: first.jobId });
    expect(json(second)).toMatchObject({ status: 'done', roomId: 'sdb', styleId: 'japandi', kind: 'reference' });
    expect(types(second)).toContain('image');
  });

  it('reports a provider that is down or an unknown job as tool errors with a next step', async () => {
    const { client } = await connect();
    const { fake } = setup();
    fake.failWith = 'out of memory';
    const failed = await call(client, { roomId: 'sdb', styleId: 'japandi' });
    expect(failed.isError).toBe(true);
    expect(json(failed).code).toBe('render_failed');
    const unknown = await call(client, { jobId: 'nope' });
    expect(json(unknown).code).toBe('unknown_entity');
  });

  it('validates the room and the style and spends no image job on a bad call', async () => {
    const { client } = await connect();
    const { fake } = setup();
    expect(json(await call(client, { roomId: 'nowhere', styleId: 'japandi' })).code).toBe('unknown_room');
    expect(json(await call(client, { roomId: 'sdb', styleId: 'rococo' })).code).toBe('invalid_command');
    expect(json(await call(client, { styleId: 'japandi' })).code).toBe('invalid_command');
    expect(json(await call(client, { roomId: 'sdb', styleId: 'japandi', bogus: 1 })).code).toBe('invalid_command');
    expect(fake.generated).toHaveLength(0);
  });

  it('says so when the render passes are not available yet (default control source)', async () => {
    const { client } = await connect();
    setImageProvider(new FakeImageProvider());
    const r = await call(client, { roomId: 'sdb', styleId: 'japandi' });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ code: 'not_implemented', hint: expect.stringContaining('visualisation') });
  });

  it('turns a disabled or unreachable provider into render_unavailable', async () => {
    const { client } = await connect();
    setControlImageSource({ getControlImages: async () => ({ canny: pass }) });
    const { OpenAIImageProvider } = await import('./imagegen');
    setImageProvider(new OpenAIImageProvider({}));
    const r = await call(client, { roomId: 'sdb', styleId: 'japandi' });
    expect(json(r)).toMatchObject({ code: 'render_unavailable', message: expect.stringContaining('OPENAI_API_KEY') });
  });
});

describe('generate_reference (mode visualisation)', () => {
  const renderer = (calls: unknown[]) => ({
    async render(spec: unknown, opts?: unknown) {
      calls.push({ spec, opts });
      return { image: TINY_PNG_B64, mimeType: 'image/png' as const, meta: { rev: 0 } as never };
    },
  });

  it('edits our own clean render with klein and marks the output as a visualisation', async () => {
    const calls: unknown[] = [];
    const { client } = await connect({}, undefined, { renderer: renderer(calls) });
    const { fake } = setup();
    const r = await call(client, { roomId: 'sejour', styleId: 'japandi', mode: 'visualisation', seed: 5, n: 3 });
    const b = json(r);
    expect(b).toMatchObject({ ok: true, status: 'done', kind: 'visualisation', mode: 'visualisation', roomType: 'living' });
    expect(b.label).toMatch(/^VISUALISATION/);
    expect(b.images).toHaveLength(1); // one edit per call, whatever n says
    expect(fake.generated).toHaveLength(0);
    expect(fake.edited[0]).toMatchObject({ seed: 5, model: 'klein-edit', image: { provenance: 'render', data: TINY_PNG_B64 } });
    expect(fake.edited[0]!.prompt).toMatch(/Keep the room layout/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ spec: { view: 'walk', roomId: 'sejour', size: { width: 1024, height: 768 } } });
    const texts = (r.content as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text);
    expect(texts.some((t) => t!.startsWith('VISUALISATION'))).toBe(true);
    expect(texts.some((t) => t!.startsWith('REFERENCE'))).toBe(false);
  });

  it('does not need the render passes', async () => {
    const { client } = await connect({}, undefined, { renderer: renderer([]) });
    setImageProvider(new FakeImageProvider()); // control source stays the unavailable default
    const r = await call(client, { roomId: 'sdb', styleId: 'japandi', mode: 'visualisation' });
    expect(r.isError).toBeFalsy();
  });
});
