import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { HttpFlatApi } from './flatApi';
import { FakeImageMatcher, FakeImageProvider, TINY_PNG_B64, setImageMatcher, setImageProvider } from './imagegen';
import { setImageShrinker } from './imageContent';
import type { ImageShrinker } from './render/shrink';
import { PARISIAN_BATHROOM, encodePng16Gray, floorAndWallDepth } from './reference/fixtures';
import { clearReferences } from './reference/engine';
import { startRealServer, type RealServer } from './testing/harness';
import { connect, json } from './testing/inproc';
import type { MockFlatApi } from './testing/mockFlatApi';

/**
 * CG4 end to end, offline: a real apps/server (mock products) behind HttpFlatApi, the MCP server in process, the fake image
 * provider, a fake renderer that draws a floor-and-wall depth, and a fake picture index. record -> match -> gap report, and the
 * concept items (placement, bill of materials).
 */

const PNG = `data:image/png;base64,${TINY_PNG_B64}`;
const W = 1024;
const H = 768;
const FOV = 60;
const CAM = [3, 1.5, 6] as const;
const DEPTH_URL = `data:image/png;base64,${encodePng16Gray(W, H, floorAndWallDepth(W, H, FOV, CAM[1], 5)).toString('base64')}`;

interface Call {
  spec: Record<string, unknown>;
  kinds: string[];
}

function fakeRenderer(calls: Call[]) {
  return {
    async render(spec: Record<string, unknown>, opts: { passes?: { kinds?: string[] } }) {
      const kinds = opts.passes?.kinds ?? [];
      calls.push({ spec, kinds });
      return {
        image: TINY_PNG_B64,
        mimeType: 'image/png' as const,
        meta: { warnings: [] } as never,
        passes: {
          size: { width: W, height: H },
          images: Object.fromEntries(kinds.map((k) => [k, k === 'depth' ? DEPTH_URL : PNG])),
          camera: { type: 'perspective', fovDeg: FOV, matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, CAM[0], CAM[1], CAM[2], 1] },
          depth: { encoding: 'png16-gray', unitM: 0.001 },
          legend: null,
          edges: null,
          ms: 1,
        },
      };
    },
  };
}

const JPEG_B64 = 'AAECAw==';
class FakeShrinker implements ImageShrinker {
  async shrinkAll(images: readonly { data: Uint8Array }[]) {
    return images.map(() => ({ data: JPEG_B64, mimeType: 'image/jpeg' as const, width: 100, height: 80 }));
  }
}

let real: RealServer | undefined;
const dir = mkdtempSync(join(process.cwd(), '.tmp-gap-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => clearReferences());
afterEach(async () => {
  await real?.close();
  real = undefined;
  setImageProvider(undefined);
  setImageMatcher(undefined);
  setImageShrinker(undefined);
});

async function boot(calls: Call[] = []) {
  real = await startRealServer({ providers: ['mock'] });
  const config = loadConfig({}, { serverUrl: real.url, log: () => {}, requestTimeoutMs: 10_000 });
  const flat = new HttpFlatApi(config);
  const { client } = await connect({ serverUrl: real.url }, flat as unknown as MockFlatApi, { renderer: fakeRenderer(calls) as never });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { r, j: json(r as never) as Record<string, any> };
  };
  return { client, flat, call };
}

const mirrorHit = { id: 'mock:MOCK-MIRR-50', kind: 'product' as const, score: 0.33, name: 'MOCK Wall mirror 50x150', category: 'mirror', price: 59, dims: { w: 0.5, d: 0.03, h: 1.5 }, has3d: false };

async function recorded(call: Awaited<ReturnType<typeof boot>>['call']) {
  const provider = new FakeImageProvider();
  setImageProvider(provider);
  const ref = await call('generate_reference', { roomId: 'sdb', styleId: 'french-parisian', seed: 5 });
  expect(ref.j.ok, JSON.stringify(ref.j)).toBe(true);
  const rec = await call('record_reference', { jobId: ref.j.jobId, index: 0, descriptor: PARISIAN_BATHROOM });
  expect(rec.j.ok, JSON.stringify(rec.j)).toBe(true);
  return { jobId: ref.j.jobId as string, rec: rec.j };
}

describe('record_reference', () => {
  it('validates with located errors and stores nothing on failure', async () => {
    const { call } = await boot();
    const bad = structuredClone(PARISIAN_BATHROOM) as any;
    bad.items[1].box = [10, 10, 5, 5];
    bad.palette[0].hex = 'beige';
    const r = await call('record_reference', { jobId: 'job-x', descriptor: bad });
    expect(r.j.code).toBe('invalid_command');
    expect(r.j.errors.map((e: any) => e.path).sort()).toEqual(['descriptor/items/1/box', 'descriptor/palette/0/hex']);
    expect((await call('match_reference', { jobId: 'job-x' })).j.code).toBe('precondition_failed');
    expect((await call('gap_report', { jobId: 'job-x' })).j.code).toBe('precondition_failed');
    expect((await call('record_reference', { jobId: 'job-x', descriptor: PARISIAN_BATHROOM, extra: 1 })).j.code).toBe('invalid_command');
  });

  it('takes each item\'s plan position from OUR depth at the camera of the reference image', async () => {
    const calls: Call[] = [];
    const { call } = await boot(calls);
    const { rec } = await recorded(call);
    expect(rec).toMatchObject({ roomId: 'sdb', items: 6, planStatus: 'ok' });
    // the depth render uses the same room camera as the reference render, depth pass only
    const depthCall = calls.find((c) => c.kinds.length === 1 && c.kinds[0] === 'depth')!;
    const refCall = calls.find((c) => c.kinds.includes('edges'))!;
    expect(depthCall.spec['pose']).toEqual(refCall.spec['pose']);
    expect(depthCall.spec).toMatchObject({ view: 'walk', roomId: 'sdb', size: { width: W, height: H } });
    const tub = rec.positions.tub;
    expect(tub.widthM).toBeGreaterThan(1); // 375 px wide at a few metres
    expect(tub.centre).toHaveLength(2);
    // the bath box's bottom is about 40 px below the horizon: a floor point a few metres in front of the camera
    expect(tub.centre[1]).toBeLessThan(CAM[2]);
    expect(tub.centre[1]).toBeGreaterThan(CAM[2] - 5);
    // wall-mounted items report how high they hang
    expect(rec.positions.mirror.heightM).toBeGreaterThan(1);
    expect(Object.values(rec.positions).every((p) => p !== null)).toBe(true);
  });

  it('still records when the renderer has no depth, and says so', async () => {
    const { client } = await connect({}, undefined, { renderer: { async render() { return { image: TINY_PNG_B64, mimeType: 'image/png', meta: { warnings: [] } }; } } as never });
    const r = json((await client.callTool({ name: 'record_reference', arguments: { jobId: 'j', roomId: 'sdb', descriptor: PARISIAN_BATHROOM } })) as never);
    expect(r.ok).toBe(true);
    expect(r.planStatus).toMatch(/^unavailable: this renderer draws no depth pass/);
    expect(r.positions.tub).toBeNull();
    const noRoom = json((await client.callTool({ name: 'record_reference', arguments: { jobId: 'j2', descriptor: PARISIAN_BATHROOM } })) as never);
    expect(noRoom.planStatus).toMatch(/unknown room/);
  });
});

describe('match_reference and gap_report (record -> match -> gap)', () => {
  it('finds real products and picture matches, judges them and registers products as seen', async () => {
    const { call } = await boot();
    const { jobId } = await recorded(call);
    const matcher = new FakeImageMatcher([mirrorHit, { id: 'polyhaven:mirror_round', kind: 'asset', score: 0.3, name: 'Round mirror', category: 'mirror', dims: { w: 0.6, d: 0.04, h: 0.6 }, has3d: true }]);
    setImageMatcher(matcher);
    setImageShrinker(new FakeShrinker());
    const m = await call('match_reference', { jobId, index: 0 });
    expect(m.j.ok, JSON.stringify(m.j)).toBe(true);
    expect(m.j.pictureSimilarity).toBe('used');
    // every item asked the index with its own box
    expect(matcher.requests.map((r) => r.box)).toEqual(PARISIAN_BATHROOM.items.map((i) => i.box));
    expect(matcher.requests[0]!.image).toEqual({ jobId, index: 0 });
    const items: Record<string, any> = Object.fromEntries(m.j.items.map((i: any) => [i.id, i]));
    expect(Object.keys(items)).toEqual(['tub', 'vanity', 'basin', 'mirror', 'sconce', 'towel-rail']);
    // the mock shop has no bath: no real match, a concept alternative instead
    expect(items['tub']).toMatchObject({ verdict: 'none', suggestGenerator: { generator: 'bathtub', concept: true, params: { shape: 'rect' } } });
    expect(items['tub'].reasons[0].aspect).toBe('missing');
    expect(items['tub'].trySearching).toBe('baignoire rectangulaire');
    // the mirror: the picture index finds the mock mirror; it is the right kind but 150 cm tall against 80
    expect(items['mirror'].candidates[0]).toMatchObject({ productId: 'mock:MOCK-MIRR-50', has3d: false, price: 59 });
    expect(items['mirror'].candidates.some((c: any) => c.assetId === 'polyhaven:mirror_round')).toBe(true);
    expect(items['mirror'].reasons.map((r: any) => r.aspect)).toContain('size');
    expect(items['mirror'].at).toHaveLength(2);
    expect(m.j.summary.good + m.j.summary.approx + m.j.summary.none).toBe(6);
    // thumbnails of the best candidates, capped
    const content = m.r.content as { type: string }[];
    expect(content.filter((c) => c.type === 'image').length).toBeLessThanOrEqual(8);
    // the matched product was marked as seen: place_item no longer says unknown_product
    const place = await call('place_item', { productId: 'mock:MOCK-MIRR-50', roomId: 'sdb', position: [4.2, 8.8] });
    expect(place.j.code).not.toBe('unknown_product');
  });

  it('works without the picture index (text, size, colour only) and says so', async () => {
    const { call } = await boot();
    const { jobId } = await recorded(call);
    setImageMatcher(new FakeImageMatcher([], new (await import('./imagegen')).ImageMatchError('index_missing', 'no index')));
    const m = await call('match_reference', { jobId, itemIds: ['mirror'], thumbs: false });
    expect(m.j.ok).toBe(true);
    expect(m.j.pictureSimilarity).toMatch(/^unavailable \(index_missing: no index\)/);
    expect(m.j.items).toHaveLength(1);
    expect((await call('match_reference', { jobId, itemIds: ['ghost'] })).j.code).toBe('unknown_entity');
  });

  it('writes the gap report as markdown plus JSON, saves both, and lists concept alternatives', async () => {
    const { call } = await boot();
    const { jobId } = await recorded(call);
    setImageMatcher(new FakeImageMatcher([mirrorHit]));
    setImageShrinker(new FakeShrinker());
    const rel = dir.slice(process.cwd().length + 1);
    const g = await call('gap_report', { jobId, index: 0, saveTo: join(rel, 'out') });
    expect(g.j.ok, JSON.stringify(g.j)).toBe(true);
    const report = g.j.report;
    expect(report.summary.items).toBe(6);
    expect(report.lines.map((l: any) => l.itemId)).toEqual(['tub', 'vanity', 'basin', 'mirror', 'sconce', 'towel-rail']);
    const tub = report.lines[0];
    expect(tub).toMatchObject({ verdict: 'none', bestMatch: null, concept: { generator: 'bathtub' }, suggestedSearch: 'baignoire rectangulaire' });
    expect(tub.planHint.centre).toHaveLength(2);
    const vanity = report.lines[1];
    expect(vanity.concept.generator).toBe('washbasin');
    // markdown is the second content item and matches the saved file
    const md = (g.r.content as { text: string }[])[1]!.text;
    expect(md).toContain('# Gap report: french parisian bathroom');
    expect(md).toMatch(/\| tub \(5\/5\) \|/);
    expect(g.j.files.markdown).toBe(join(dir, 'out', 'gap-report.md'));
    expect(readFileSync(g.j.files.markdown, 'utf8').trim()).toBe(md.trim());
    expect(JSON.parse(readFileSync(g.j.files.json, 'utf8'))).toEqual(report);
    if (process.env['CG4_SAMPLE_DIR']) {
      mkdirSync(process.env['CG4_SAMPLE_DIR'], { recursive: true });
      copyFileSync(g.j.files.markdown, join(process.env['CG4_SAMPLE_DIR'], 'gap-report.md'));
      copyFileSync(g.j.files.json, join(process.env['CG4_SAMPLE_DIR'], 'gap-report.json'));
    }
    // outside the working directory is refused
    expect((await call('gap_report', { jobId, saveTo: '../elsewhere' })).j.code).toBe('invalid_command');
  });

  it('saves into the design runner output folder when FLAT_DESIGN_OUT is set', async () => {
    const { call } = await boot();
    const { jobId } = await recorded(call);
    setImageMatcher(new FakeImageMatcher([]));
    const prev = process.env['FLAT_DESIGN_OUT'];
    process.env['FLAT_DESIGN_OUT'] = join(dir, 'design-out');
    try {
      const g = await call('gap_report', { jobId });
      expect(g.j.files.markdown).toBe(join(dir, 'design-out', 'gap-reports', `${jobId}-0`, 'gap-report.md'));
      expect(existsSync(g.j.files.json)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['FLAT_DESIGN_OUT'];
      else process.env['FLAT_DESIGN_OUT'] = prev;
    }
  });
});

describe('concept items', () => {
  it('place_item concept:true puts a generated shape: no product, labelled, exact dims, 0 in the bill, listed apart', async () => {
    const { call, flat } = await boot();
    await call('search_products', { query: '', limit: 12 });
    await call('place_item', { productId: 'mock:MOCK-DESK-120', roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-east' } });
    const before = (await call('get_bill_of_materials')).j.byRoom.ch1.itemCount;
    const placed = await call('place_item', { concept: true, generator: 'rug', params: { shape: 'round', w: 1.6, d: 1.6, pattern: 'stripes', colour: 'cream', accent: 'terracotta' }, roomId: 'ch1', relation: { kind: 'centered_in', roomId: 'ch1' } });
    expect(placed.j.ok, JSON.stringify(placed.j)).toBe(true);
    expect(placed.j.addedEur).toBe(0);
    expect(placed.j.placed[0]).toMatchObject({ concept: true, price: 0, name: 'Concept rug (generated)', mesh: expect.stringMatching(/^concept/) });
    expect(placed.j.placed[0].productId).toBeUndefined();

    const scene = ((await flat.getScene()) as any).data.scene;
    const rug = scene.items.find((i: any) => i.concept);
    expect(rug).toMatchObject({ assetId: 'param:rug', concept: true, mesh: { kind: 'parametric', generator: 'rug' }, dims: { w: 1.6, d: 1.6, h: 0.012 } });
    expect(rug.product).toBeUndefined();
    expect(rug.productRef).toBeUndefined();

    const bom = (await call('get_bill_of_materials')).j;
    expect(bom.totalEur).toBe(79);
    expect(bom.bySku.map((g: any) => g.productId)).toEqual(['mock:MOCK-DESK-120']);
    expect(bom.concept).toMatchObject({ count: 1, itemIds: [rug.id], byRoom: { ch1: 1 } });
    expect(bom.concept.note).toMatch(/not purchasable/);
    expect((bom.withoutProduct ?? []).map((l: any) => l.itemId)).not.toContain(rug.id);
    expect(bom.missingPrice ?? []).not.toContain(rug.id);
    expect(bom.byRoom.ch1.itemCount).toBe(before); // the concept rug is not counted

    const layout = (await call('validate_layout', { roomId: 'ch1' })).j;
    expect(layout.totalEur).toBe(79);
    expect(layout.missingPrice ?? []).not.toContain(rug.id);
    const room = (await call('describe_room', { roomId: 'ch1' })).j;
    const line = room.items.find((i: any) => i.id === rug.id);
    expect(line).toMatchObject({ concept: true, productId: null, price: null, mesh: 'parametric' });
    expect(line.name).toBe('Concept rug (generated)');
    expect(line.note).toMatch(/CONCEPT/);
  });

  it('hangs and suspends concepts at sensible default heights', async () => {
    const { call, flat } = await boot();
    const r = await call('place_item', {
      items: [
        { concept: true, generator: 'pendant', params: { shape: 'globe', w: 0.4, h: 1 }, roomId: 'ch1', position: [8.3, 1.4] },
        { concept: true, generator: 'curtains', params: { w: 1.2, h: 2.2 }, roomId: 'ch1', relation: { kind: 'against_wall', wallId: 'w-east' } },
      ],
    });
    expect(r.j.ok, JSON.stringify(r.j)).toBe(true);
    const items = ((await flat.getScene()) as any).data.scene.items.filter((i: any) => i.concept);
    const pendant = items.find((i: any) => i.mesh.generator === 'pendant');
    const curtains = items.find((i: any) => i.mesh.generator === 'curtains');
    expect(pendant.mount).toBe('ceiling');
    expect(pendant.elevation + pendant.dims.h).toBeCloseTo(2.5, 1);
    expect(curtains.mount).toBe('wall');
    expect(curtains.elevation).toBeGreaterThan(0);
  });

  it('refuses the mixes: a product id with concept, a missing generator, an unknown generator, bad params, generator without concept', async () => {
    const { call } = await boot();
    await call('search_products', { query: '', limit: 12 });
    const code = async (entry: Record<string, unknown>) => (await call('place_item', { roomId: 'ch1', position: [8.3, 1.2], ...entry })).j;
    expect((await code({ concept: true, productId: 'mock:MOCK-DESK-120', generator: 'rug' })).errors[0]).toMatchObject({ path: 'productId' });
    expect((await code({ concept: true })).errors[0]).toMatchObject({ path: 'generator' });
    expect((await code({ concept: true, generator: 'teleporter' })).code).toBe('invalid_command');
    const bad = await code({ concept: true, generator: 'bathtub', params: { shape: 'triangle' } });
    expect(bad.code).toBe('invalid_command');
    expect(bad.message).toMatch(/invalid parameters for generator "bathtub"/);
    expect((await code({ productId: 'mock:MOCK-DESK-120', generator: 'rug' })).errors[0]).toMatchObject({ path: 'generator' });
    expect((await code({})).errors[0]).toMatchObject({ path: 'productId' });
    expect((await code({ concept: true, generator: 'rug', elevation: 1 })).code).toBe('invalid_command');
  });
});
