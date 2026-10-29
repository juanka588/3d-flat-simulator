import { describe, expect, it } from 'vitest';
import { deltaE2000, hexToLab, kmeansLab, labToHex, rgbToLab } from './color';
import { DEFAULT_SCORE_WEIGHTS, boxIou, compareLayouts, comparePalettes, diffList, itemBoxes, overallScore, parseScoreWeights, unionIou, type Box } from './metrics';
import { decodePng, downscale, encodePng, type Rgba } from './png';

/** The metrics of score_against_reference on synthetic images (no renderer, no sidecar). */

function solid(w: number, h: number, hex: string): Rgba {
  const n = parseInt(hex.slice(1), 16);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255], i * 4);
  return { width: w, height: h, data };
}
/** Left part `frac` of the width in colour a, the rest in colour b. */
function split(w: number, h: number, a: string, b: string, frac = 0.5): Rgba {
  const img = solid(w, h, b);
  const n = parseInt(a.slice(1), 16);
  for (let y = 0; y < h; y++) for (let x = 0; x < Math.round(w * frac); x++) img.data.set([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255], (y * w + x) * 4);
  return img;
}

describe('colour maths', () => {
  it('CIEDE2000 matches the published test pairs (Sharma, Wu, Dalal 2005)', () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(deltaE2000([50, 3.1571, -77.2803], [50, 0, -82.7485])).toBeCloseTo(2.8615, 3);
    expect(deltaE2000([50, 2.5, 0], [50, 0, -2.5])).toBeCloseTo(4.3065, 3);
    expect(deltaE2000([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387])).toBeCloseTo(1.2644, 3);
    expect(deltaE2000([50, 0, 0], [50, 0, 0])).toBe(0);
  });

  it('sRGB to Lab: white, black and a mid grey; hex round trip', () => {
    expect(rgbToLab(255, 255, 255)[0]).toBeCloseTo(100, 1);
    expect(rgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 5);
    expect(rgbToLab(119, 119, 119)[0]).toBeCloseTo(50, 0);
    expect(labToHex(hexToLab('#a8b5a0'))).toBe('#a8b5a0');
  });

  it('k-means is deterministic and finds the two colours of a split image by area', () => {
    const img = split(120, 80, '#a8b5a0', '#3a3a3a', 0.75);
    const a = kmeansLab(img, 6);
    expect(a).toEqual(kmeansLab(img, 6));
    expect(a).toHaveLength(2);
    expect(a[0]!.hex).toBe('#a8b5a0');
    expect(a[0]!.area).toBeCloseTo(0.75, 1);
    expect(a[1]!.hex).toBe('#3a3a3a');
  });
});

describe('palette', () => {
  const described = [
    { hex: '#a8b5a0', role: 'walls', areaPct: 60 },
    { hex: '#3a3a3a', role: 'floor', areaPct: 40 },
  ];

  it('identical images score 1 with a ΔE of 0 for every role', () => {
    const img = split(120, 80, '#a8b5a0', '#3a3a3a', 0.6);
    const p = comparePalettes(kmeansLab(img), kmeansLab(img), described);
    expect(p.score).toBe(1);
    expect(p.meanDeltaE).toBe(0);
    expect(p.roles.map((r) => [r.role, r.deltaE])).toEqual([['walls', 0], ['floor', 0]]);
  });

  it('a shifted palette gives the CIEDE2000 of the shift, per role and in total', () => {
    const target = split(120, 80, '#a8b5a0', '#3a3a3a', 0.6);
    const ours = split(120, 80, '#c9a9a6', '#3a3a3a', 0.6); // walls turned dusty pink, floor unchanged
    const p = comparePalettes(kmeansLab(target), kmeansLab(ours), described);
    const expected = deltaE2000(hexToLab('#a8b5a0'), hexToLab('#c9a9a6'));
    expect(expected).toBeGreaterThan(10);
    expect(p.roles.find((r) => r.role === 'walls')!.deltaE).toBeCloseTo(expected, 1);
    expect(p.roles.find((r) => r.role === 'floor')!.deltaE).toBe(0);
    expect(p.roles.find((r) => r.role === 'walls')).toMatchObject({ targetHex: '#a8b5a0', oursHex: '#c9a9a6' });
    expect(p.meanDeltaE).toBeCloseTo(expected * 0.6, 1);
    expect(p.score).toBeCloseTo(1 - (expected * 0.6) / 30, 2);
    expect(p.score).toBeLessThan(1);
  });

  it('a bigger shift scores lower, a completely different palette scores near 0', () => {
    const t = solid(40, 40, '#a8b5a0');
    const near = comparePalettes(kmeansLab(t), kmeansLab(solid(40, 40, '#b0b8a8'))).score;
    const far = comparePalettes(kmeansLab(t), kmeansLab(solid(40, 40, '#802040'))).score;
    expect(near).toBeGreaterThan(far);
    expect(far).toBeLessThan(0.1);
  });
});

describe('layout', () => {
  const size = { width: 100, height: 100 };

  it('box IoU maths', () => {
    expect(boxIou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(boxIou([0, 0, 10, 10], [5, 5, 15, 15])).toBeCloseTo(25 / 175, 6);
    expect(boxIou([0, 0, 10, 10], [10, 0, 20, 10])).toBe(0);
    expect(boxIou([0, 0, 10, 10], [2, 2, 8, 8])).toBeCloseTo(36 / 100, 6);
  });

  it('the IoU of box sets covers their union', () => {
    const a: Box[] = [[0, 0, 50, 50], [50, 50, 100, 100]];
    expect(unionIou(a, a, size)).toBe(1);
    expect(unionIou(a, [[0, 0, 50, 50]], size)).toBeCloseTo(0.5, 1);
    expect(unionIou(a, [[0, 50, 50, 100]], size)).toBe(0);
  });

  const target = [
    { id: 'sofa', category: 'sofa', subtype: '3 seater sofa', box: [10, 40, 60, 80] as Box, importance: 5 },
    { id: 'rug', category: 'rug', subtype: 'jute rug', box: [5, 70, 70, 95] as Box, importance: 4 },
    { id: 'lamp', category: 'lamp', subtype: 'floor lamp', box: [80, 20, 90, 70] as Box, importance: 2 },
  ];

  it('matches by category, reports missing, misplaced and extra items, and weights by importance', () => {
    const ours = [
      { id: 'i-sofa', category: 'sofa', name: 'KIVIK', box: [12, 42, 58, 78] as Box, pixels: 900 },
      { id: 'i-lamp', category: 'lamp', name: 'lamp', box: [10, 5, 20, 30] as Box, pixels: 100 }, // far from the target lamp
      { id: 'i-arm', category: 'armchair', name: 'armchair', box: [70, 60, 95, 95] as Box, pixels: 300 },
      { id: 'i-wardrobe', category: 'wardrobe', name: 'existing cupboard', box: [0, 0, 5, 40] as Box, pixels: 50, locked: true },
    ];
    const r = compareLayouts(target, ours, size);
    expect(r.matched).toEqual([{ target: 'sofa', ours: 'i-sofa', iou: 0.828 }]);
    expect(r.missing).toEqual([{ id: 'rug', category: 'rug', subtype: 'jute rug', importance: 4 }]);
    expect(r.misplaced.map((m) => m.id)).toEqual(['lamp']);
    expect(r.extra.map((e) => e.id)).toEqual(['i-arm']); // the locked cupboard is never extra
    expect(r.perCategory.find((c) => c.category === 'sofa')!.iou).toBeGreaterThan(0.6);
    expect(r.perCategory.find((c) => c.category === 'rug')).toMatchObject({ iou: 0, target: 1, ours: 0 });
    // sofa 5 * 0.828 of a total importance of 11, minus 0.03 for the extra armchair
    expect(r.score).toBeCloseTo((5 * 0.828) / 11 - 0.03, 2);
    expect(diffList({ layout: r })).toEqual(['missing: jute rug (rug, importance 4)', expect.stringMatching(/^misplaced: floor lamp/), 'extra: armchair (armchair)']);
  });

  it('a perfect layout scores 1 and an empty room scores 0', () => {
    const same = target.map((t) => ({ id: `o-${t.id}`, category: t.category, name: t.subtype, box: t.box, pixels: 100 }));
    expect(compareLayouts(target, same, size).score).toBe(1);
    expect(compareLayouts(target, [], size)).toMatchObject({ score: 0, missing: expect.any(Array) });
  });

  it('item boxes come from the instance colours of the legend, ignoring specks and non-items', () => {
    const img = solid(40, 30, '#000000');
    const paint = (hex: string, x0: number, y0: number, x1: number, y1: number) => {
      const n = parseInt(hex.slice(1), 16);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255], (y * 40 + x) * 4);
    };
    paint('#ff0000', 5, 6, 25, 20);
    paint('#00ff00', 30, 2, 31, 3); // a speck
    paint('#0000ff', 0, 25, 40, 30); // a wall
    const legend = [
      { color: [255, 0, 0] as [number, number, number], id: 'sofa1', kind: 'item', class: 'item' },
      { color: [0, 255, 0] as [number, number, number], id: 'speck', kind: 'item', class: 'item' },
      { color: [0, 0, 255] as [number, number, number], id: 'w1', kind: 'wall', class: 'wall' },
    ];
    expect([...itemBoxes(img, legend)]).toEqual([['sofa1', { box: [5, 6, 25, 20], pixels: 280 }]]);
  });
});

describe('overall score and weights', () => {
  it('is the weighted sum, renormalised over the metrics that exist', () => {
    const w = DEFAULT_SCORE_WEIGHTS;
    expect(w.palette + w.layout + w.clip + w.aesthetic).toBeCloseTo(1, 10);
    expect(overallScore({ palette: 1, layout: 1, clip: 1, aesthetic: 1 }, w).score).toBe(1);
    expect(overallScore({ palette: 0.5, layout: 1, clip: 0, aesthetic: 1 }, w).score).toBeCloseTo(0.3 * 0.5 + 0.3 + 0.1, 6);
    const partial = overallScore({ palette: 0.5, layout: 1 }, w);
    expect(partial.score).toBeCloseTo((0.5 * 0.3 + 1 * 0.3) / 0.6, 4);
    expect(partial.missing).toEqual(['clip', 'aesthetic']);
    expect(partial.used.palette).toBeCloseTo(0.5, 4);
    expect(overallScore({}, w).score).toBeNull();
  });

  it('parses FLAT_SCORE_WEIGHTS, ignoring bad entries', () => {
    expect(parseScoreWeights(undefined).weights).toEqual(DEFAULT_SCORE_WEIGHTS);
    const r = parseScoreWeights('palette=0.5, clip=0.1,nope=2,layout=abc');
    expect(r.weights).toEqual({ palette: 0.5, layout: 0.3, clip: 0.1, aesthetic: 0.1 });
    expect(r.ignored).toEqual(['nope=2', 'layout=abc']);
    expect(parseScoreWeights('palette=0,layout=0,clip=0,aesthetic=0').weights).toEqual(DEFAULT_SCORE_WEIGHTS);
  });
});

describe('diff list', () => {
  it('lists the palette roles that differ, biggest first, with the target colour', () => {
    const target = split(120, 80, '#a8b5a0', '#3a3a3a', 0.6);
    const ours = split(120, 80, '#c9a9a6', '#3a3a3a', 0.6);
    const palette = comparePalettes(kmeansLab(target), kmeansLab(ours), [
      { hex: '#a8b5a0', role: 'wall', areaPct: 60 },
      { hex: '#3a3a3a', role: 'floor', areaPct: 40 },
    ]);
    const list = diffList({ palette, clip: { cosine: 0.5 }, aesthetic: { ours: 4, target: 6 } });
    expect(list[0]).toMatch(/^wall palette ΔE \d+ \(target #a8b5a0, ours #c9a9a6\)$/);
    expect(list.some((l) => l.startsWith('floor palette'))).toBe(false);
    expect(list.some((l) => /CLIP similarity 0\.5/.test(l))).toBe(true);
    expect(list.some((l) => /aesthetic score 4 vs target 6/.test(l))).toBe(true);
  });
});

describe('png', () => {
  it('round-trips RGBA and downscales without upscaling', () => {
    const img = split(64, 48, '#ff0000', '#0000ff');
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(64);
    expect(Buffer.from(back.data).equals(Buffer.from(img.data))).toBe(true);
    const small = downscale(img, 16);
    expect([small.width, small.height]).toEqual([16, 12]);
    expect(downscale(img, 200)).toBe(img);
    expect(() => decodePng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/not a PNG/);
  });
});
