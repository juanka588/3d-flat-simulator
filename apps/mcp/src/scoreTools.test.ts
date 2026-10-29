import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeImageProvider, FakeImageScorer, SimilarityError, TINY_PNG_B64, setControlImageSource, setImageProvider, setImageScorer } from './imagegen';
import { DESCRIPTOR_EXAMPLE, type ReferenceDescriptor } from './reference/descriptor';
import { clearReferences } from './reference/engine';
import { encodePng, type Rgba } from './score/png';
import { connect, json } from './testing/inproc';
import { clearScoreHistory } from './tools/score';

/** CG5 `score_against_reference` over the in-process MCP server with a fake provider, renderer and scorer. */

const W = 1024;
const H = 768;
const tmp = mkdtempSync(join(process.cwd(), '.tmp-score-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function paint(img: Rgba, hex: string, x0: number, y0: number, x1: number, y1: number) {
  const n = parseInt(hex.slice(1), 16);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255], (y * img.width + x) * 4);
}
function canvas(w: number, h: number, hex: string): Rgba {
  const img = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  paint(img, hex, 0, 0, w, h);
  return img;
}
const dataUrl = (img: Rgba) => `data:image/png;base64,${encodePng(img).toString('base64')}`;

// The target: sage walls above, dark floor below. Our room: pink walls above, the same floor, one existing wardrobe.
const targetImg = canvas(W, H, '#a8b5a0');
paint(targetImg, '#3a3a3a', 0, 450, W, H);
const oursImg = canvas(W, H, '#c9a9a6');
paint(oursImg, '#3a3a3a', 0, 450, W, H);
const ins = canvas(W, H, '#000000');
paint(ins, '#ff0000', 100, 200, 300, 500); // the wardrobe `placard-ch1`
const targetFile = join(tmp, 'target.png');
writeFileSync(targetFile, encodePng(targetImg));

const wardrobeItem = (box: [number, number, number, number]) => ({
  id: 'wardrobe',
  category: 'wardrobe' as const,
  subtype: 'built-in wardrobe',
  shape: 'flat doors',
  colour: 'white',
  material: 'lacquer',
  approxDims: { w: 2, d: 0.6, h: 2.4 },
  box,
  placementHint: { relation: 'against_wall' as const, wall: 'left' },
  importance: 3,
});
const descriptor: ReferenceDescriptor = {
  ...DESCRIPTOR_EXAMPLE,
  palette: [
    { hex: '#a8b5a0', role: 'walls', areaPct: 58 },
    { hex: '#3a3a3a', role: 'floor', areaPct: 42 },
  ],
  items: [
    wardrobeItem([100, 200, 300, 500]),
    { ...wardrobeItem([600, 500, 900, 700]), id: 'rug', category: 'rug' as never, subtype: 'jute rug', importance: 4 },
  ],
};

function fakeRenderer(calls: unknown[], render: Rgba = oursImg) {
  return {
    async render(spec: unknown, opts: { passes?: { kinds?: string[] } }) {
      calls.push({ spec, kinds: opts.passes?.kinds });
      const kinds = opts.passes?.kinds ?? [];
      return {
        image: encodePng(render).toString('base64'),
        mimeType: 'image/png' as const,
        meta: { rev: 1, view: 'walk', roomId: 'ch1', warnings: [] } as never,
        passes: {
          size: { width: W, height: H },
          images: Object.fromEntries(kinds.map((k) => [k, k === 'instances' ? dataUrl(ins) : `data:image/png;base64,${TINY_PNG_B64}`])),
          camera: { type: 'perspective', fovDeg: 60, matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.5, 0, 1] },
          depth: { encoding: 'png16-gray', unitM: 0.001 },
          legend: { classes: [], instances: [{ color: [255, 0, 0], hex: '#ff0000', class: 'locked_fitting', kind: 'item', id: 'placard-ch1', roomId: 'ch1', pixels: 60000 }], unclassified: [] },
          edges: null,
          ms: 1,
        },
      };
    },
  };
}

type Client = Awaited<ReturnType<typeof connect>>['client'];
async function reference(client: Client): Promise<string> {
  setImageProvider(new FakeImageProvider({ path: targetFile }));
  setControlImageSource({ async getControlImages() { return { canny: { provenance: 'pass', data: TINY_PNG_B64, mimeType: 'image/png' } }; } });
  const g = json(await client.callTool({ name: 'generate_reference', arguments: { roomId: 'ch1', styleId: 'japandi' } }));
  return g.jobId as string;
}
const record = (client: Client, jobId: string) => client.callTool({ name: 'record_reference', arguments: { jobId, descriptor } });
const score = (client: Client, args: Record<string, unknown>) => client.callTool({ name: 'score_against_reference', arguments: args });

beforeEach(() => {
  clearReferences();
  clearScoreHistory();
});
afterEach(() => {
  setImageProvider(undefined);
  setImageScorer(undefined);
  setControlImageSource(undefined);
  delete process.env['FLAT_DESIGN_OUT'];
});

describe('score_against_reference', () => {
  it('is listed read-only with a short description', async () => {
    const { client } = await connect();
    const t = (await client.listTools()).tools.find((x) => x.name === 'score_against_reference')!;
    expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(t.description!.length).toBeLessThan(330);
  });

  it('scores palette, layout, CLIP and aesthetic, returns the diff list and our render', async () => {
    const calls: unknown[] = [];
    const { client } = await connect({}, undefined, { renderer: fakeRenderer(calls) as never });
    const scorer = new FakeImageScorer([[1, 0, 0], [0.8, 0.6, 0]], [4.5, 6]);
    const jobId = await reference(client);
    setImageScorer(scorer);
    expect((await record(client, jobId)).isError).toBeFalsy();

    const r = await score(client, { jobId });
    expect(r.isError).toBeFalsy();
    const b = json(r);
    expect(b).toMatchObject({ ok: true, roomId: 'ch1', iteration: 1 });
    // palette: pink walls against sage walls; the floor is the same
    const walls = b.scores.palette.roles.find((x: { role: string }) => x.role === 'walls');
    expect(walls).toMatchObject({ targetHex: '#a8b5a0', oursHex: '#c9a9a6' });
    expect(walls.deltaE).toBeGreaterThan(10);
    expect(b.scores.palette.roles.find((x: { role: string }) => x.role === 'floor').deltaE).toBe(0);
    // layout: the wardrobe matches exactly (the existing locked cupboard), the rug is missing
    expect(b.scores.layout.matched).toEqual([{ target: 'wardrobe', ours: 'placard-ch1', iou: 1 }]);
    expect(b.scores.layout.missing).toEqual([{ id: 'rug', category: 'rug', subtype: 'jute rug', importance: 4 }]);
    expect(b.scores.layout.extra).toEqual([]);
    // CLIP cosine of (1,0,0) and (0.8,0.6,0), aesthetic 4.5 against 6
    expect(b.scores.clip.cosine).toBeCloseTo(0.8, 3);
    expect(b.scores.aesthetic).toMatchObject({ ours: 4.5, target: 6, licence: expect.stringContaining('MIT') });
    expect(b.overall).toBeGreaterThan(0);
    expect(b.overall).toBeLessThan(1);
    expect(b.weights).toEqual({ palette: 0.3, layout: 0.3, clip: 0.3, aesthetic: 0.1 });
    expect(b.diff).toContain('missing: jute rug (rug, importance 4)');
    expect(b.diff.some((d: string) => /^walls palette ΔE \d+ \(target #a8b5a0, ours #c9a9a6\)$/.test(d))).toBe(true);
    expect(b.skipped).toBeUndefined();
    // our render is returned, with a label, and the render asked for the instance pass at the reference size
    const types = (r.content as { type: string }[]).map((c) => c.type);
    expect(types.filter((t) => t === 'image')).toHaveLength(1);
    expect(calls.at(-1)).toMatchObject({ kinds: ['instances'], spec: { view: 'walk', roomId: 'ch1', size: { width: 1024, height: 768 } } });
    // both images went to CLIP together
    expect(scorer.embedded).toHaveLength(1);
    expect(scorer.embedded[0]).toHaveLength(2);
  });

  it('a second score reports the improvement over the first', async () => {
    const better = canvas(W, H, '#a8b5a0');
    paint(better, '#3a3a3a', 0, 450, W, H);
    let which = oursImg;
    const renderer = { render: (s: unknown, o: never) => fakeRenderer([], which).render(s, o) };
    const { client } = await connect({}, undefined, { renderer: renderer as never });
    setImageScorer(new FakeImageScorer());
    const jobId = await reference(client);
    await record(client, jobId);
    const first = json(await score(client, { jobId }));
    which = better;
    const second = json(await score(client, { jobId }));
    expect(second.iteration).toBe(2);
    expect(second.previousOverall).toBe(first.overall);
    expect(second.improvement).toBeGreaterThan(0);
    expect(second.scores.palette.score).toBe(1);
  });

  it('skips what the sidecar cannot do, says so, and renormalises the weights', async () => {
    const { client } = await connect({}, undefined, { renderer: fakeRenderer([]) as never });
    setImageScorer(new FakeImageScorer([], [], { embed: new SimilarityError('unavailable', 'image service not reachable'), aesthetic: new SimilarityError('model_missing', 'weights are not downloaded') }));
    const jobId = await reference(client);
    await record(client, jobId);
    const b = json(await score(client, { jobId }));
    expect(b.skipped.map((s: { metric: string }) => s.metric).sort()).toEqual(['aesthetic', 'clip']);
    expect(b.note).toMatch(/not computed: clip .*aesthetic/);
    expect(b.scores.clip).toBeNull();
    expect(b.weights).toEqual({ palette: 0.5, layout: 0.5 });
    expect(b.overall).toBeCloseTo((b.scores.palette.score + b.scores.layout.score) / 2, 3);
  });

  it('works without a descriptor (no layout) and takes the weights from the config', async () => {
    const { client } = await connect({ scoreWeights: { palette: 1, layout: 0, clip: 0, aesthetic: 0 } }, undefined, { renderer: fakeRenderer([]) as never });
    setImageScorer(new FakeImageScorer());
    const jobId = await reference(client);
    const b = json(await score(client, { jobId }));
    expect(b.scores.layout).toBeNull();
    expect(b.skipped.find((s: { metric: string }) => s.metric === 'layout').why).toMatch(/record_reference/);
    expect(b.weights).toEqual({ palette: 1 });
    expect(b.overall).toBe(b.scores.palette.score);
  });

  it('palette of identical images is 1 (the reference is our render)', async () => {
    const { client } = await connect({}, undefined, { renderer: fakeRenderer([], targetImg) as never });
    setImageScorer(new FakeImageScorer());
    const jobId = await reference(client);
    const b = json(await score(client, { jobId }));
    expect(b.scores.palette).toMatchObject({ score: 1, meanDeltaE: 0 });
  });

  it('saves the iteration (score.json, render.png, target.png) when the runner sets FLAT_DESIGN_OUT', async () => {
    const out = join(tmp, 'run');
    process.env['FLAT_DESIGN_OUT'] = out;
    const { client } = await connect({}, undefined, { renderer: fakeRenderer([]) as never });
    setImageScorer(new FakeImageScorer());
    const jobId = await reference(client);
    await record(client, jobId);
    const b = json(await score(client, { jobId }));
    const dir = join(out, 'iterations', 'iter-01');
    expect(b.files).toMatchObject({ score: join(dir, 'score.json'), render: join(dir, 'render.png'), target: join(dir, 'target.png') });
    expect(JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8'))).toMatchObject({ overall: b.overall, diff: b.diff, iteration: 1 });
    expect(readFileSync(join(dir, 'render.png')).subarray(1, 4).toString()).toBe('PNG');
    expect(existsSync(join(dir, 'target.png'))).toBe(true);
    // the other tools leave their files for the runner as well
    expect(JSON.parse(readFileSync(join(out, 'descriptor.json'), 'utf8'))).toMatchObject({ jobId, roomId: 'ch1', descriptor: { items: [{ id: 'wardrobe' }, { id: 'rug' }] } });
    expect(readdirSync(join(out, 'references')).some((f) => f.endsWith('.json'))).toBe(true);
    await score(client, { jobId });
    expect(existsSync(join(out, 'iterations', 'iter-02', 'score.json'))).toBe(true);
  });

  it('reports a missing room, an unknown job image and a failing renderer as tool errors or skipped metrics', async () => {
    const { client } = await connect({}, undefined, { renderer: fakeRenderer([]) as never });
    setImageProvider(new FakeImageProvider());
    expect(json(await score(client, { jobId: 'unknown-job' })).code).toBe('invalid_command');
    expect(json(await score(client, { jobId: 'x', bogus: 1 })).code).toBe('invalid_command');
    // a job the provider does not know: palette / CLIP skipped, layout still scored
    setImageScorer(new FakeImageScorer());
    const b = json(await score(client, { jobId: 'fake000000000099', roomId: 'ch1' }));
    expect(b.skipped?.map((s: { metric: string }) => s.metric)).toEqual(expect.arrayContaining(['palette', 'clip']));
  });
});
