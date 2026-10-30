import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { FIDELITY_THRESHOLDS, FakeImageProvider, TINY_PNG_B64, blendControl, fidelityRef, scoreFidelity, setControlImageSource, setImageProvider, type ControlImagesRequest } from './imagegen';
import { blockoutScene } from './reference/blockout';
import { layoutIntent } from './reference/views';
import { connect, json } from './testing/inproc';

afterEach(() => {
  setImageProvider(undefined);
  setControlImageSource(undefined);
});

const W = 256;
const H = 192;
const call = (client: Awaited<ReturnType<typeof connect>>['client'], args: Record<string, unknown>) => client.callTool({ name: 'generate_reference', arguments: args });

function makePng(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      p.data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return PNG.sync.write(p);
}
const b64 = (b: Buffer) => b.toString('base64');
const input = (b: Buffer) => ({ provenance: 'pass' as const, data: b64(b), mimeType: 'image/png' as const });

/** An ids pass whose upper third is ceiling, and an edge pass with one horizontal line at the ceiling's lower border. */
const ids = makePng(W, H, (_x, y) => (y < H / 3 ? [200, 200, 255] : [128, 128, 128]));
const edges = makePng(W, H, (_x, y) => (y === Math.floor(H / 3) ? [255, 255, 255] : [0, 0, 0]));
/** A room picture: pale ceiling with a hard edge at the line, or a saturated wood ceiling. */
const roomImage = (ceiling: [number, number, number]) => makePng(W, H, (_x, y) => (y < H / 3 ? ceiling : [60, 90, 120]));

describe('blockout scene', () => {
  it('draws the intended living-room layout in a scratch copy and leaves the real scene alone', async () => {
    const { client } = await connect();
    const seen: ControlImagesRequest[] = [];
    setImageProvider(new FakeImageProvider());
    setControlImageSource({ async getControlImages(req) { seen.push(req); return { canny: input(edges) }; } });
    const before = JSON.parse(JSON.stringify(json(await client.callTool({ name: 'describe_room', arguments: { roomId: 'sejour' } }))));
    const r = json(await call(client, { roomId: 'sejour', styleId: 'scandinavian', view: 'media' }));
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    expect(seen).toHaveLength(1);
    const scratch = seen[0]!.blockout;
    expect(scratch, 'a blockout scene is passed to the control source').toBeDefined();
    const blocks = scratch!.items.filter((i) => i.id.startsWith('blockout-'));
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((i) => (i as { concept?: boolean }).concept === true)).toBe(true);
    expect(r.blockout).toEqual(expect.arrayContaining(['sofa']));
    expect(r.prompt).toMatch(/blocked out in the control drawing/);
    const after = json(await client.callTool({ name: 'describe_room', arguments: { roomId: 'sejour' } }));
    expect(after).toEqual(before);
  });

  it('can be switched off: no blockout scene and the canny control as before', async () => {
    const { client } = await connect();
    const seen: ControlImagesRequest[] = [];
    const fake = new FakeImageProvider();
    setImageProvider(fake);
    setControlImageSource({ async getControlImages(req) { seen.push(req); return { canny: input(edges) }; } });
    await call(client, { roomId: 'sejour', styleId: 'scandinavian', view: 'media', blockout: false });
    expect(seen[0]!.blockout).toBeUndefined();
    expect(fake.generated[0]!.controls).toMatchObject([{ type: 'canny', strength: 1 }]);
  });

  it('sends the depth+edges blend at strength 0.8 when the passes drew the placeholders', async () => {
    const { client } = await connect();
    const fake = new FakeImageProvider();
    setImageProvider(fake);
    setControlImageSource({ async getControlImages() { return { canny: input(edges), blend: input(edges) }; } });
    await call(client, { roomId: 'sejour', styleId: 'scandinavian', view: 'media' });
    expect(fake.generated[0]!.controls).toMatchObject([{ type: 'depth', strength: 0.8 }]);
  });

  it('blockoutScene is undefined when the intent has nothing to draw', async () => {
    const { client } = await connect();
    const scene = json(await client.callTool({ name: 'describe_room', arguments: { roomId: 'sdb' } }));
    expect(scene).toBeDefined();
    expect(blockoutScene({ rooms: [], items: [] } as never, 'x', { place: [] } as never)).toBeUndefined();
    void layoutIntent;
  });
});

describe('control blend', () => {
  it('turns a 16-bit depth pass and an edge pass into one gray PNG: edges white, near brighter than far', () => {
    const raw = Buffer.alloc(W * H * 2);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw.writeUInt16BE(x < W / 2 ? 1000 : 4000, (y * W + x) * 2);
    const png16 = encode16(raw, W, H);
    const out = PNG.sync.read(Buffer.from(blendControl(b64(png16), b64(edges)), 'base64'));
    const at = (x: number, y: number) => out.data[(y * W + x) * 4]!;
    expect(out.width).toBe(W);
    expect(at(10, 30)).toBeGreaterThan(at(200, 30));
    expect(at(10, 30)).toBeLessThanOrEqual(140);
    expect(at(10, Math.floor(H / 3))).toBe(255);
  });
});

describe('fidelity filter', () => {
  const ref = () => fidelityRef(b64(ids), b64(edges));

  it('passes a pale ceiling and fails a wood-coloured one', () => {
    const good = scoreFidelity(roomImage([235, 232, 225]), ref());
    expect(good.ceilingPale).toBeGreaterThanOrEqual(FIDELITY_THRESHOLDS.ceilingPale);
    expect(good.ok, good.reasons.join('; ')).toBe(true);
    const wood = scoreFidelity(roomImage([170, 100, 45]), ref());
    expect(wood.ok).toBe(false);
    expect(wood.reasons.join(' ')).toMatch(/ceiling is not pale/);
    expect(wood.score).toBeLessThan(good.score);
  });

  it('drops the failing candidate from generate_reference and reports why; keeps the best when all fail', async () => {
    const dir = mkdtempSync(join(process.env['TMPDIR'] ?? '.', 'fid-'));
    mkdirSync(dir, { recursive: true });
    const goodPath = join(dir, 'good.png');
    const woodPath = join(dir, 'wood.png');
    writeFileSync(goodPath, roomImage([235, 232, 225]));
    writeFileSync(woodPath, roomImage([170, 100, 45]));
    const { client } = await connect();
    setControlImageSource({ async getControlImages() { return { canny: input(edges), check: { ids: input(ids), edges: input(edges) } }; } });

    // two candidates: seed 5 is the good picture, seed 6 the wood ceiling
    const fake = new FakeImageProvider();
    const paths = [goodPath, woodPath];
    (fake as unknown as { image: (seed: number) => unknown }).image = (seed: number) => ({ path: paths[seed - 5]!, seed, seconds: 0.1, peakGb: null, preview: { data: TINY_PNG_B64, mimeType: 'image/png' } });
    setImageProvider(fake);
    const r = json(await call(client, { roomId: 'sdb', styleId: 'japandi', n: 2, seed: 5 }));
    expect(r.images.map((i: { seed: number }) => i.seed)).toEqual([5]);
    expect(r.images[0].fidelity).toBeGreaterThan(0.5);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]).toMatchObject({ seed: 6 });
    expect(r.rejected[0].reasons.join(' ')).toMatch(/ceiling/);

    // every candidate fails: the best one is still returned, with a warning
    const allBad = new FakeImageProvider({ path: woodPath });
    setImageProvider(allBad);
    const r2 = json(await call(client, { roomId: 'sdb', styleId: 'japandi', n: 2, seed: 5 }));
    expect(r2.images).toHaveLength(1);
    expect(r2.note).toMatch(/WARNING: every candidate failed/);
  });
});

/** Encodes raw big-endian 16-bit gray samples as a PNG (pngjs writes 16-bit from a Uint16 RGBA buffer with bitDepth 16). */
function encode16(raw: Buffer, w: number, h: number): Buffer {
  const p = new PNG({ width: w, height: h, bitDepth: 16, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  p.data = Buffer.alloc(w * h * 4 * 2);
  for (let i = 0; i < w * h; i++) {
    const v = raw.readUInt16BE(i * 2);
    for (let c = 0; c < 3; c++) p.data.writeUInt16LE(v, (i * 4 + c) * 2);
    p.data.writeUInt16LE(65535, (i * 4 + 3) * 2);
  }
  return PNG.sync.write(p, { bitDepth: 16, colorType: 0, inputColorType: 6, inputHasAlpha: true });
}
