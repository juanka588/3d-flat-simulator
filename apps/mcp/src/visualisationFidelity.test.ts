import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeImageProvider, TINY_PNG_B64, VISUALISATION_THRESHOLDS, fidelityRef, scoreFidelity, setImageProvider } from './imagegen';
import { connect, json } from './testing/inproc';

/** The visualisation (a klein edit of our render) is checked against that render's passes: a plain ceiling, the same structure, an open sky outdoors. */

afterEach(() => setImageProvider(undefined));

const W = 256;
const H = 192;
function makePng(px: (x: number, y: number) => [number, number, number]): Buffer {
  const p = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) p.data.set([...px(x, y), 255], (y * W + x) * 4);
  return PNG.sync.write(p);
}
const b64 = (b: Buffer) => b.toString('base64');

// indoor: ceiling on the upper third, walls below; one structural edge along the ceiling border
const ids = makePng((_x, y) => (y < H / 3 ? [200, 200, 255] : [128, 128, 128]));
const edges = makePng((_x, y) => (y === Math.floor(H / 3) ? [255, 255, 255] : [0, 0, 0]));
const plain = makePng((_x, y) => (y < H / 3 ? [236, 233, 226] : [60, 90, 120]));
/** A ceiling rose and a gilded frame: concentric rings of dark and gold in the middle of the ceiling. */
const ornate = makePng((x, y) => {
  if (y >= H / 3) return [60, 90, 120];
  const d = Math.hypot(x - W / 2, y - 22);
  return d < 22 && Math.floor(d / 3) % 2 === 0 ? [140, 110, 60] : [236, 233, 226];
});

describe('visualisation fidelity: plain ceiling', () => {
  const ref = () => fidelityRef(b64(ids), b64(edges));

  it('passes the plain ceiling and fails the one with a rose, for the visualisation rules only', () => {
    const good = scoreFidelity(plain, ref(), { visualisation: true });
    expect(good.ceilingClutter).toBeLessThanOrEqual(VISUALISATION_THRESHOLDS.ceilingClutter);
    expect(good.ok, good.reasons.join('; ')).toBe(true);
    const bad = scoreFidelity(ornate, ref(), { visualisation: true });
    expect(bad.ceilingClutter!).toBeGreaterThan(VISUALISATION_THRESHOLDS.ceilingClutter);
    expect(bad.ok).toBe(false);
    expect(bad.reasons.join(' ')).toMatch(/ceiling is not plain/);
    expect(bad.score).toBeLessThan(good.score);
    // a reference (not a visualisation) is not judged on this
    expect(scoreFidelity(ornate, ref()).ceilingClutter).toBeUndefined();
  });

  it('fails an edit that moved the structure (the drawing edges are gone)', () => {
    const flat = makePng(() => [200, 200, 200]);
    const r = scoreFidelity(flat, ref(), { visualisation: true });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/moved the room's structure|walls, windows and doors are not where/);
  });
});

describe('visualisation fidelity: outdoors stays outdoors', () => {
  // a balcony: sky (background, black in the ids pass) above, facade wall below; the structural edge between them
  const skyIds = makePng((_x, y) => (y < H / 2 ? [0, 0, 0] : [128, 128, 128]));
  const skyEdges = makePng((_x, y) => (y === Math.floor(H / 2) ? [255, 255, 255] : [0, 0, 0]));
  const ref = () => fidelityRef(b64(skyIds), b64(skyEdges), { outdoor: true });
  const open = makePng((_x, y) => (y < H / 2 ? [150, 195, 240] : [120, 110, 100]));
  const corridor = makePng((_x, y) => (y < H / 2 ? [70, 55, 40] : [120, 110, 100]));

  it('keeps a picture with an open sky and rejects the one where the sky became an indoor ceiling', () => {
    const good = scoreFidelity(open, ref(), { visualisation: true });
    expect(good.skyOpen).toBeGreaterThanOrEqual(VISUALISATION_THRESHOLDS.skyOpen);
    expect(good.ok, good.reasons.join('; ')).toBe(true);
    const bad = scoreFidelity(corridor, ref(), { visualisation: true });
    expect(bad.skyOpen!).toBeLessThan(VISUALISATION_THRESHOLDS.skyOpen);
    expect(bad.ok).toBe(false);
    expect(bad.reasons.join(' ')).toMatch(/open sky is gone/);
  });

  it('is off for an indoor reference', () => {
    expect(scoreFidelity(open, fidelityRef(b64(skyIds), b64(skyEdges)), { visualisation: true }).skyOpen).toBeUndefined();
  });
});

describe('generate_reference mode visualisation: checked, at most 2 tries', () => {
  const dir = mkdtempSync(join(process.env['TMPDIR'] ?? '.', 'vis-'));
  const goodPath = join(dir, 'good.png');
  const ornatePath = join(dir, 'ornate.png');
  writeFileSync(goodPath, plain);
  writeFileSync(ornatePath, ornate);
  const dataUrl = (b: Buffer) => `data:image/png;base64,${b64(b)}`;
  const renderer = (calls: unknown[]) => ({
    async render(spec: unknown, opts?: unknown) {
      calls.push({ spec, opts });
      return { image: TINY_PNG_B64, mimeType: 'image/png' as const, meta: { rev: 0 } as never, passes: { images: { ids: dataUrl(ids), edgesItems: dataUrl(edges) } } as never };
    },
  });
  /** A provider whose edit with seed s gives paths[s - first]. */
  const provider = (paths: string[], first: number) => {
    const fake = new FakeImageProvider();
    (fake as unknown as { image: (seed: number) => unknown }).image = (seed: number) => ({ path: paths[Math.min(paths.length - 1, seed - first)]!, seed, seconds: 0.1, peakGb: null, preview: { data: TINY_PNG_B64, mimeType: 'image/png' } });
    return fake;
  };

  it('asks for the passes of the same frame, lit like the honest render, and keeps the first edit when it passes', async () => {
    const calls: { spec: { preset?: string }; opts: { passes?: { kinds: string[] } } }[] = [];
    const { client } = await connect({}, undefined, { renderer: renderer(calls) as never });
    const fake = provider([goodPath], 7);
    setImageProvider(fake);
    const r = json(await client.callTool({ name: 'generate_reference', arguments: { roomId: 'sdb', styleId: 'japandi', mode: 'visualisation', seed: 7 } }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(fake.edited).toHaveLength(1);
    expect(calls[0]!.opts.passes!.kinds).toEqual(expect.arrayContaining(['ids', 'edgesItems']));
    expect(calls[0]!.spec.preset).toBe('evening'); // the bathroom has no window: lamps on
    expect(r.attempts).toEqual([expect.objectContaining({ seed: 7, ok: true })]);
    expect(r.images[0].fidelity).toBeGreaterThan(0.5);
    expect(r.prompt).toMatch(/There is no window, no skylight/);
  });

  it('makes a second edit with the next seed when the first fails, and returns the better one', async () => {
    const { client } = await connect({}, undefined, { renderer: renderer([]) as never });
    const fake = provider([ornatePath, goodPath], 7);
    setImageProvider(fake);
    const r = json(await client.callTool({ name: 'generate_reference', arguments: { roomId: 'sejour', styleId: 'japandi', mode: 'visualisation', seed: 7 } }));
    expect(fake.edited.map((e) => e.seed)).toEqual([7, 8]);
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]).toMatchObject({ seed: 7, ok: false });
    expect(r.attempts[0].reasons.join(' ')).toMatch(/ceiling is not plain/);
    expect(r.attempts[1]).toMatchObject({ seed: 8, ok: true });
    expect(r.seed).toBe(8);
    expect(r.rejected).toBeUndefined();
  });

  it('stops after 2 tries and warns when both fail', async () => {
    const { client } = await connect({}, undefined, { renderer: renderer([]) as never });
    const fake = provider([ornatePath], 7);
    setImageProvider(fake);
    const r = json(await client.callTool({ name: 'generate_reference', arguments: { roomId: 'sejour', styleId: 'japandi', mode: 'visualisation', seed: 7 } }));
    expect(fake.edited).toHaveLength(2);
    expect(r.attempts.every((a: { ok: boolean }) => a.ok === false)).toBe(true);
    expect(r.note).toMatch(/WARNING: every candidate failed the fidelity filter/);
  });
});
