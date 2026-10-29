import { describe, expect, it } from 'vitest';
import { GENERATORS, cameraFromMatrixWorld } from '@flat/scene';
import '@flat/assets';
import { DESCRIPTOR_EXAMPLE, ReferenceDescriptor, type DescriptorItem } from './descriptor';
import { cameraOfPayload, decodePng16Gray, planHintOf, sampleDepthM } from './depth';
import { buildGapReport, gapMarkdown, matchItems, searchPhrases, type MatchPorts } from './engine';
import { PARISIAN_BATHROOM, encodePng16Gray, floorAndWallDepth } from './fixtures';
import { fitVerdict, rankCandidates, sizeErrorOf, type Candidate } from './rank';
import { suggestGenerator } from './suggest';
import { nearestColourName, tokens, toFrench } from './vocab';

const item = (over: Partial<DescriptorItem> = {}): DescriptorItem => ({ ...PARISIAN_BATHROOM.items[0]!, ...over });
const check = (d: unknown) => ReferenceDescriptor.safeParse(d);
const messages = (d: unknown) => {
  const r = check(d);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('/')}: ${i.message}`);
};

describe('ReferenceDescriptor schema', () => {
  it('accepts the example and the hand-written Parisian bathroom', () => {
    expect(check(DESCRIPTOR_EXAMPLE).success).toBe(true);
    expect(check(PARISIAN_BATHROOM).success).toBe(true);
  });

  it('is strict: unknown keys, bad hex, empty lists and out-of-range numbers are located errors', () => {
    const base = structuredClone(PARISIAN_BATHROOM);
    expect(messages({ ...base, extra: 1 }).join()).toMatch(/Unrecognized key/);
    expect(messages({ ...base, palette: [{ hex: 'red', role: 'walls', areaPct: 10 }] })[0]).toMatch(/^palette\/0\/hex: .*colour like/);
    expect(messages({ ...base, items: [] })[0]).toMatch(/^items:/);
    expect(messages({ ...base, lighting: { ...base.lighting, kelvin: 20 } })[0]).toMatch(/^lighting\/kelvin/);
    expect(messages({ ...base, items: [{ ...base.items[0], importance: 9 }] })[0]).toMatch(/^items\/0\/importance/);
    expect(messages({ ...base, items: [{ ...base.items[0], category: 'bathtub' }] })[0]).toMatch(/^items\/0\/category/);
    expect(messages({ ...base, items: [{ ...base.items[0], approxDims: { w: 0, d: 1, h: 1 } }] })[0]).toMatch(/^items\/0\/approxDims\/w/);
  });

  it('checks the box, unique ids, near-item references and the palette total', () => {
    const base = structuredClone(PARISIAN_BATHROOM);
    const [a, b] = base.items as [DescriptorItem, DescriptorItem];
    expect(messages({ ...base, items: [{ ...a, box: [100, 100, 50, 200] }] })[0]).toBe('items/0/box: box must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0');
    expect(messages({ ...base, items: [a, { ...b, id: a.id }] })).toContain(`items/1/id: duplicate item id "${a.id}"`);
    expect(messages({ ...base, items: [{ ...a, placementHint: { relation: 'on', nearItemId: 'ghost' } }] })[0]).toBe('items/0/placementHint/nearItemId: no item "ghost" in this descriptor');
    expect(messages({ ...base, items: [{ ...a, placementHint: { relation: 'on', nearItemId: a.id } }] })[0]).toMatch(/near itself/);
    expect(messages({ ...base, palette: [{ hex: '#ffffff', role: 'a', areaPct: 80 }, { hex: '#000000', role: 'b', areaPct: 60 }] })[0]).toMatch(/^palette: palette areas add up to 140%/);
    expect(messages({ ...base, items: [{ ...a, id: 'Bad Id' }] })[0]).toMatch(/^items\/0\/id/);
  });
});

describe('vocabulary', () => {
  it('folds French onto English words and maps colours onto the palette', () => {
    expect(tokens('Baignoire îlot ovale en céramique blanche')).toEqual(['bathtub', 'freestanding', 'oval', 'ceramic', 'white']);
    expect(nearestColourName('sage green')).toBe('sage');
    expect(nearestColourName('#a3b18a')).toBe('sage');
    expect(nearestColourName('noir mat')).toBe('black');
    expect(nearestColourName('orange')).toBe('terracotta');
    expect(nearestColourName('transparent')).toBeUndefined();
    expect(toFrench(['bathtub', 'white', 'whatever'])).toEqual(['baignoire', 'blanc', 'whatever']);
  });

  it('builds French search phrases: the model\'s own terms first', () => {
    expect(searchPhrases(item())[0]).toBe('baignoire rectangulaire');
    const plain = searchPhrases(item({ searchTerms: undefined, subtype: 'freestanding bathtub', colour: 'white' }));
    expect(plain[0]).toBe('baignoire îlot blanc');
  });
});

describe('depth and positions', () => {
  const W = 1024;
  const H = 768;
  const FOV = 60;
  const cam = cameraFromMatrixWorld([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 1.5, 6, 1], FOV, W, H); // at (2, 1.5, 6) looking along -Z
  const depth = { width: W, height: H, data: floorAndWallDepth(W, H, FOV, 1.5, 5), unitM: 0.001 };

  it('decodes a 16-bit PNG exactly and samples the median depth', () => {
    const values = floorAndWallDepth(8, 6, FOV, 1.5, 5);
    const back = decodePng16Gray(encodePng16Gray(8, 6, values));
    expect([back.width, back.height]).toEqual([8, 6]);
    expect(Array.from(back.data)).toEqual(Array.from(values));
    expect(() => decodePng16Gray(Buffer.from('nope'))).toThrow(/not a PNG/);
    expect(sampleDepthM({ width: 2, height: 2, data: new Uint16Array([0, 0, 0, 0]), unitM: 0.001 }, 1, 1)).toBeUndefined();
    expect(sampleDepthM({ width: 3, height: 1, data: new Uint16Array([1000, 2000, 3000]), unitM: 0.001 }, 1, 0, 1)).toBeCloseTo(2, 6);
  });

  it('unprojects the bottom centre of a box onto the floor: plan point, height 0, width in metres, centre pushed back by half the depth', () => {
    // floor point 3 m in front of the camera: row below the horizon with tan = 1.5 / 3
    const f = H / 2 / Math.tan((FOV * Math.PI) / 360);
    const row = H / 2 + f * (1.5 / 3);
    const box: [number, number, number, number] = [W / 2 - 100, row - 300, W / 2 + 100, row + 2]; // bottom edge 2 px below `row`: the hint samples 2 px above it
    const hint = planHintOf(cam, depth, { width: W, height: H }, { box, approxDims: { w: 1, d: 0.5, h: 1 }, placementHint: { relation: 'against_wall' } })!;
    expect(hint.depthM).toBeCloseTo(3, 1);
    expect(hint.contact[0]).toBeCloseTo(2, 1); // straight ahead of the camera at x = 2
    expect(hint.contact[1]).toBeCloseTo(6 - 3, 1);
    expect(hint.heightM).toBeCloseTo(0, 1);
    expect(hint.centre[1]).toBeCloseTo(6 - 3 - 0.25, 1); // 25 cm further away along the view
    expect(hint.widthM).toBeCloseTo((200 / f) * 3, 1);
    expect(hint.note).toBeUndefined();
  });

  it('a hung item keeps its contact point and reports the hang height; a wall hit is flagged for floor items', () => {
    const wallRow = 100; // above the horizon: the wall at 5 m
    const box: [number, number, number, number] = [400, 20, 600, wallRow + 2];
    const hung = planHintOf(cam, depth, { width: W, height: H }, { box, approxDims: { w: 0.6, d: 0.04, h: 0.8 }, placementHint: { relation: 'wall_mounted' } })!;
    expect(hung.depthM).toBeCloseTo(5, 1);
    expect(hung.heightM).toBeGreaterThan(1.5);
    expect(hung.centre).toEqual(hung.contact);
    const floorItem = planHintOf(cam, depth, { width: W, height: H }, { box, approxDims: { w: 0.6, d: 0.4, h: 0.8 }, placementHint: { relation: 'against_wall' } })!;
    expect(floorItem.note).toMatch(/wall or furniture behind/);
  });

  it('scales the box when the depth map has another size, and gives nothing where nothing was drawn', () => {
    const half = { width: W / 2, height: H / 2, data: floorAndWallDepth(W / 2, H / 2, FOV, 1.5, 5), unitM: 0.001 };
    const camHalf = cameraFromMatrixWorld([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 1.5, 6, 1], FOV, W / 2, H / 2);
    const box: [number, number, number, number] = [412, 500, 612, 700];
    const a = planHintOf(cam, depth, { width: W, height: H }, { box, approxDims: { w: 1, d: 0.5, h: 1 }, placementHint: { relation: 'free' } })!;
    const b = planHintOf(camHalf, half, { width: W, height: H }, { box, approxDims: { w: 1, d: 0.5, h: 1 }, placementHint: { relation: 'free' } })!;
    expect(b.contact[1]).toBeCloseTo(a.contact[1], 0);
    const empty = { width: W, height: H, data: new Uint16Array(W * H), unitM: 0.001 };
    expect(planHintOf(cam, empty, { width: W, height: H }, { box, approxDims: { w: 1, d: 0.5, h: 1 }, placementHint: { relation: 'free' } })).toBeUndefined();
  });

  it('reads the pass camera object', () => {
    const c = cameraOfPayload({ type: 'perspective', fovDeg: 60, matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1] }, { width: 100, height: 50 });
    expect(c.position).toEqual([1, 2, 3]);
    expect(c.forward).toEqual([-0, -0, -1]);
    expect(() => cameraOfPayload({ type: 'orthographic' }, { width: 1, height: 1 })).toThrow(/perspective/);
  });
});

describe('ranking and verdicts', () => {
  const tub = item({ id: 'tub', category: 'other', subtype: 'freestanding bathtub', shape: 'oval, slipper', colour: 'white', material: 'ceramic', approxDims: { w: 1.7, d: 0.75, h: 0.6 }, searchTerms: undefined });
  const cand = (id: string, over: Partial<Candidate>): Candidate => ({ kind: 'product', id, name: id, has3d: true, ...over });

  it('prefers the right category, size, colour and look, and uses CLIP when it answers', () => {
    const good = cand('p:tub', { name: 'Baignoire îlot ovale blanche', category: 'other', dims: { w: 1.7, d: 0.78, h: 0.6 }, colours: ['blanc'], textRank: 1, clip: 0.33 });
    const wrongSize = cand('p:big', { name: 'Baignoire ovale blanche', category: 'other', dims: { w: 2.6, d: 1.2, h: 0.7 }, colours: ['blanc'], textRank: 0, clip: 0.32 });
    const wrongKind = cand('p:desk', { name: 'Bureau blanc', category: 'desk', dims: { w: 1.2, d: 0.6, h: 0.75 }, colours: ['blanc'], textRank: 2, clip: 0.3 });
    const ranked = rankCandidates(tub, [wrongKind, wrongSize, good]);
    expect(ranked.map((r) => r.candidate.id)).toEqual(['p:tub', 'p:big', 'p:desk']);
    expect(ranked[0]!.score).toBeGreaterThan(0.75);
    expect(ranked[2]!.score).toBeLessThan(0.4);
  });

  it('picture similarity moves the order when the text cannot tell', () => {
    const a = cand('a', { name: 'Table en bois', category: 'table', dims: { w: 1.4, d: 0.8, h: 0.75 }, clip: 0.14 });
    const b = cand('b', { name: 'Table en bois', category: 'table', dims: { w: 1.4, d: 0.8, h: 0.75 }, clip: 0.33 });
    const t = item({ category: 'table', subtype: 'wooden dining table', shape: 'rectangular', colour: 'brown', material: 'wood', approxDims: { w: 1.4, d: 0.8, h: 0.75 } });
    expect(rankCandidates(t, [a, b]).map((r) => r.candidate.id)).toEqual(['b', 'a']);
    // without picture scores the tie breaks by id, deterministically
    expect(rankCandidates(t, [{ ...b, clip: undefined }, { ...a, clip: undefined }]).map((r) => r.candidate.id)).toEqual(['a', 'b']);
  });

  it('size error is symmetric in width and depth', () => {
    expect(sizeErrorOf({ w: 1, d: 2, h: 1 }, { w: 2, d: 1, h: 1 })).toBe(0);
    expect(sizeErrorOf({ w: 1, d: 2, h: 1 }, { w: 1, d: 2, h: 1.5 })).toBeCloseTo(0.5, 6);
  });

  it('verdicts: good, approx with named reasons, none', () => {
    const rank = (c: Candidate) => rankCandidates(tub, [c])[0]!;
    const good = fitVerdict(tub, rank(cand('g', { name: 'Baignoire îlot ovale blanche', category: 'other', dims: { w: 1.7, d: 0.75, h: 0.6 }, colours: ['blanc'], textRank: 0, clip: 0.34 })));
    expect(good).toEqual({ verdict: 'good', reasons: [] });
    const colour = fitVerdict(tub, rank(cand('c', { name: 'Baignoire îlot ovale noire', category: 'other', dims: { w: 1.7, d: 0.75, h: 0.6 }, colours: ['noir'], textRank: 0, clip: 0.34 })));
    expect(colour.verdict).toBe('approx');
    expect(colour.reasons.map((r) => r.aspect)).toEqual(['colour']);
    const size = fitVerdict(tub, rank(cand('s', { name: 'Baignoire îlot ovale blanche', category: 'other', dims: { w: 2.0, d: 0.95, h: 0.6 }, colours: ['blanc'], textRank: 0, clip: 0.34 })));
    expect(size.verdict).toBe('approx');
    expect(size.reasons[0]).toMatchObject({ aspect: 'size' });
    expect(size.reasons[0]!.detail).toMatch(/200x95x60 cm against about 170x75x60 cm/);
    const shape = fitVerdict(tub, rank(cand('h', { name: 'Baignoire îlot ovale blanche', category: 'other', dims: { w: 1.7, d: 0.75, h: 0.6 }, colours: ['blanc'], textRank: 0, clip: 0.15 })));
    expect(shape.reasons.map((r) => r.aspect)).toContain('shape');
    const none = fitVerdict(tub, rank(cand('n', { name: 'Chaise', category: 'chair', dims: { w: 0.4, d: 0.4, h: 0.9 }, colours: ['blanc'] })));
    expect(none.verdict).toBe('none');
    expect(fitVerdict(tub, undefined)).toEqual({ verdict: 'none', reasons: [{ aspect: 'missing', detail: 'no product found for "freestanding bathtub"' }] });
  });
});

describe('generator suggestions from a descriptor', () => {
  const sg = (over: Partial<DescriptorItem>) => suggestGenerator(item(over));
  const ok = (over: Partial<DescriptorItem>) => {
    const r = sg(over);
    if (!('suggestion' in r)) throw new Error(r.why);
    return r.suggestion;
  };

  it('reads the bath, basin, sofa, bed, rug, curtains and pendant styles into params and keeps exact dims', () => {
    const tub = ok({ subtype: 'freestanding bathtub on claw feet', shape: 'oval slipper', colour: 'black', approxDims: { w: 0.75, d: 1.7, h: 0.6 } });
    expect(tub).toMatchObject({ generator: 'bathtub', concept: true, params: { shape: 'freestanding', feet: true, colour: 'black', w: 1.7, d: 0.75 }, dims: { w: 1.7, d: 0.75, h: 0.6 } });
    expect(ok({ subtype: 'alcove bathtub', shape: 'straight' }).params).toMatchObject({ shape: 'rect', feet: false });
    expect(ok({ category: 'other', subtype: 'oval vessel basin on a vanity', shape: 'round bowl', colour: 'white', approxDims: { w: 0.7, d: 0.45, h: 0.85 } }).params).toMatchObject({ basin: 'vessel', shape: 'round' });
    const sofa = ok({ category: 'sofa', subtype: '3 seater velvet sofa', shape: 'rolled arms, wooden legs', colour: 'sage green', material: 'velvet', approxDims: { w: 2.2, d: 0.95, h: 0.85 } });
    expect(sofa).toMatchObject({ generator: 'sofa', params: { seats: 3, arms: 'rolled', legs: 'wood', fabric: 'velvet', colour: 'sage' } });
    expect(ok({ category: 'bed', subtype: 'bed with upholstered headboard', shape: 'tufted', colour: 'beige', approxDims: { w: 1.6, d: 2, h: 1.1 } }).params).toMatchObject({ headboardStyle: 'upholstered', upholstery: 'beige', w: 1.6, l: 2 });
    expect(ok({ category: 'rug', subtype: 'round striped rug', shape: 'circle', colour: 'cream', approxDims: { w: 1.6, d: 1.6, h: 0.02 } }).params).toMatchObject({ shape: 'round', pattern: 'stripes' });
    expect(ok({ category: 'curtain', subtype: 'sheer white curtains', shape: 'floor length', colour: 'white', approxDims: { w: 2.4, d: 0.1, h: 2.5 } }).params).toMatchObject({ sheer: true, panels: 2 });
    expect(ok({ category: 'lamp', subtype: 'pendant lamp', shape: 'rattan dome shade', colour: 'natural', approxDims: { w: 0.5, d: 0.5, h: 1.1 } })).toMatchObject({ generator: 'pendant', params: { shape: 'dome' } });
  });

  it('clamps sizes to the generator range and says so; every suggestion validates against its generator', () => {
    const big = ok({ category: 'rug', subtype: 'huge rug', shape: 'rectangular', approxDims: { w: 9, d: 7, h: 0.02 } });
    expect(big.dims).toMatchObject({ w: 6, d: 6 });
    expect(big.notes.join(' ')).toMatch(/limited/);
    for (const raw of [{ category: 'table' as const, subtype: 'oak table', material: 'oak' }, { category: 'wardrobe' as const, subtype: 'wardrobe' }, { category: 'tv_unit' as const, subtype: 'tv unit' }]) {
      const s = ok({ ...raw, approxDims: { w: 1.4, d: 0.5, h: 0.9 } });
      const g = GENERATORS.get(s.generator)!;
      expect(g.params.safeParse(s.params).success).toBe(true);
      expect(g.describeParams(g.params.parse(s.params)).dims).toEqual(s.dims);
    }
  });

  it('has no generator for plants, art or appliances, and explains', () => {
    const r = sg({ category: 'plant', subtype: 'potted fern', shape: 'bushy' });
    expect(r).toEqual({ why: expect.stringMatching(/no parametric generator for "potted fern" \(plant\)/) });
    expect('why' in sg({ category: 'lamp', subtype: 'floor lamp' })).toBe(true);
  });
});

describe('matchItems with a fake index and a fake shop', () => {
  const product = (sku: string, name: string, category: string, dims: Candidate['dims'], colours: string[], i: number): Candidate => ({ kind: 'product', id: `ikea-fr:${sku}`, name, category, dims, colours, price: 100 + i, currency: 'EUR', has3d: i % 2 === 0, textRank: i });
  const shop: Record<string, Candidate[]> = {
    'baignoire rectangulaire': [product('1', 'Baignoire rectangulaire blanche 170x75', 'other', { w: 1.7, d: 0.75, h: 0.58 }, ['blanc'], 0), product('2', 'Baignoire d’angle', 'other', { w: 1.5, d: 1.5, h: 0.6 }, ['blanc'], 1)],
    'miroir salle de bain cadre noir': [product('3', 'Miroir cadre noir 60x80', 'mirror', { w: 0.6, d: 0.03, h: 0.8 }, ['noir'], 0), product('4', 'Miroir rond doré', 'mirror', { w: 0.8, d: 0.03, h: 0.8 }, ['doré'], 1)],
  };
  const ports = (over: Partial<MatchPorts> = {}): MatchPorts & { searches: string[]; clips: string[] } => {
    const searches: string[] = [];
    const clips: string[] = [];
    return {
      searches,
      clips,
      async searchProducts(q) {
        searches.push(q);
        return shop[q] ?? [];
      },
      async clip(it) {
        clips.push(it.id);
        return it.id === 'mirror' ? [{ kind: 'product', id: 'ikea-fr:3', name: 'Miroir cadre noir 60x80', has3d: false, clip: 0.34 }, { kind: 'asset', id: 'polyhaven:mirror_01', name: 'Mirror', category: 'mirror', has3d: true, clip: 0.3 }] : [];
      },
      assets: () => [],
      ...over,
    };
  };

  it('ranks per item, judges the best product and keeps assets apart', async () => {
    const p = ports();
    const run = await matchItems(PARISIAN_BATHROOM, p, ['tub', 'mirror', 'basin']);
    expect(run.clip).toBe('used');
    const by = Object.fromEntries(run.items.map((m) => [m.itemId, m]));
    expect(by['tub']!.best!.candidate.id).toBe('ikea-fr:1');
    expect(by['tub']!.verdict).toBe('good');
    expect(by['mirror']!.candidates[0]!.candidate.id).toBe('ikea-fr:3'); // text AND picture agree
    expect(by['mirror']!.candidates.some((c) => c.candidate.kind === 'asset')).toBe(true);
    expect(by['mirror']!.verdict).toBe('good');
    expect(by['basin']).toMatchObject({ verdict: 'none', best: undefined });
    expect(by['basin']!.reasons[0]).toMatchObject({ aspect: 'missing' });
    expect(by['basin']!.generator).toMatchObject({ generator: 'washbasin', concept: true });
    expect(p.searches[0]).toBe('baignoire rectangulaire');
    expect(p.clips).toEqual(['tub', 'basin', 'mirror']);
  });

  it('degrades without the picture index or the shop, and says what it could not do', async () => {
    const noClip = await matchItems(PARISIAN_BATHROOM, ports({ clip: async () => ({ error: 'index_missing: run pnpm imagegen:index' }) }), ['tub']);
    expect(noClip.clip).toEqual({ unavailable: 'index_missing: run pnpm imagegen:index' });
    expect(noClip.items[0]!.verdict).toBe('good'); // text, size and colour alone
    const noShop = await matchItems(PARISIAN_BATHROOM, ports({ searchProducts: async () => ({ error: 'rate limited' }) }), ['tub']);
    expect(noShop.text).toEqual({ unavailable: 'rate limited' });
    expect(noShop.items[0]).toMatchObject({ verdict: 'none', pending: 'rate limited' });
    expect(noShop.items[0]!.reasons.map((r) => r.detail).join()).toMatch(/search did not run/);
  });

  it('builds the gap report: sorted by importance, with the concept alternative and a search term; markdown matches the JSON', async () => {
    const run = await matchItems(PARISIAN_BATHROOM, ports());
    const report = buildGapReport({ jobId: 'job1', index: 0, roomId: 'sdb', descriptor: PARISIAN_BATHROOM, plan: { tub: { contact: [1, 2], centre: [1, 2.4], heightM: 0, depthM: 3, widthM: 1.7 } }, planStatus: 'ok' }, run.items);
    expect(report.lines.map((l) => l.itemId)).toEqual(['tub', 'vanity', 'basin', 'mirror', 'sconce', 'towel-rail']);
    expect(report.summary.items).toBe(6);
    expect(report.summary.good + report.summary.approx + report.summary.none).toBe(6);
    const vanity = report.lines.find((l) => l.itemId === 'vanity')!;
    expect(vanity).toMatchObject({ verdict: 'none', bestMatch: null, suggestedSearch: 'meuble sous vasque marbre' });
    expect(vanity.concept).toMatchObject({ generator: 'washbasin' });
    const md = gapMarkdown(report);
    expect(md).toContain('# Gap report: french parisian bathroom');
    expect(md).toContain('| tub (5/5) |');
    expect(md).toContain('[concept]');
    expect(md).toContain('Position hints from our depth');
    for (const l of report.lines) expect(md).toContain(l.itemId);
  });
});
