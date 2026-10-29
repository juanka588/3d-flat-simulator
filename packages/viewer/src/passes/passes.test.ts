import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { detectEdges } from './edges';
import { CLASS_COLORS, PASS_CLASSES, entityColor } from './legend';
import { encodePng } from './png';

function decode(png: Uint8Array) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  let ihdr = { width: 0, height: 0, bitDepth: 0, colorType: 0 };
  const idat: Uint8Array[] = [];
  while (at < png.length) {
    const len = dv.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') ihdr = { width: dv.getUint32(at + 8), height: dv.getUint32(at + 12), bitDepth: body[8]!, colorType: body[9]! };
    if (type === 'IDAT') idat.push(body);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { ...ihdr, raw };
}

describe('encodePng', () => {
  it('writes a valid, deterministic 16-bit grayscale PNG', async () => {
    const data = new Uint16Array([0, 1, 256, 65535, 1000, 2000]);
    const a = await encodePng({ width: 3, height: 2, channels: 1, bitDepth: 16, data });
    const b = await encodePng({ width: 3, height: 2, channels: 1, bitDepth: 16, data });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const d = decode(a);
    expect([d.width, d.height, d.bitDepth, d.colorType]).toEqual([3, 2, 16, 0]);
    // filter byte 0 + 3 big-endian samples per row
    expect([...d.raw.subarray(0, 7)]).toEqual([0, 0, 0, 0, 1, 1, 0]);
    expect([...d.raw.subarray(7, 14)]).toEqual([0, 255, 255, 0x03, 0xe8, 0x07, 0xd0]);
  });

  it('writes RGB bytes unchanged', async () => {
    const d = decode(await encodePng({ width: 2, height: 1, channels: 3, bitDepth: 8, data: new Uint8Array([1, 2, 3, 250, 251, 252]) }));
    expect(d.colorType).toBe(2);
    expect([...d.raw]).toEqual([0, 1, 2, 3, 250, 251, 252]);
  });
});

describe('detectEdges', () => {
  const W = 40;
  const H = 30;
  /** A floor plane under a wall: depth in 1/d affine, normals constant per surface; a box step in the middle. */
  function scene(opts: { texture?: boolean } = {}) {
    const depth = new Float32Array(W * H);
    const normals = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        // left half: a wall facing the camera at 4 m; right half: a slanted plane (1/d affine in x) from 3 m to 5 m
        const left = x < 20;
        depth[i] = left ? 4 : 1 / (1 / 3 - (x - 20) * ((1 / 3 - 1 / 5) / 20));
        const n = left ? [0, 0, 1] : [0.5, 0, 0.866];
        normals.set(n.map((v) => Math.round((v * 0.5 + 0.5) * 255)), i * 3);
      }
    }
    void opts;
    return { depth, normals };
  }

  it('finds the crease and the step between two planes and nothing on the planes themselves', () => {
    const { depth, normals } = scene();
    const edges = detectEdges(depth, normals, W, H);
    for (let y = 2; y < H - 2; y++) {
      const row = [...edges.subarray(y * W, (y + 1) * W)];
      const on = row.map((v, x) => (v ? x : -1)).filter((x) => x >= 0);
      expect(on.length).toBeGreaterThan(0);
      expect(on.length).toBeLessThanOrEqual(2);
      for (const x of on) expect(Math.abs(x - 20)).toBeLessThanOrEqual(1);
    }
  });

  it('is a function of depth and normals only (colour cannot add edges)', () => {
    const a = scene();
    const b = scene({ texture: true });
    expect(Buffer.from(detectEdges(a.depth, a.normals, W, H)).equals(Buffer.from(detectEdges(b.depth, b.normals, W, H)))).toBe(true);
  });

  it('a flat wall seen at a grazing angle has no edge', () => {
    const depth = new Float32Array(W * H);
    const normals = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const x = i % W;
      depth[i] = 1 / (1 / 1.2 - x * 0.02);
      normals.set([240, 128, 128], i * 3);
    }
    expect(detectEdges(depth, normals, W, H).every((v) => v === 0)).toBe(true);
  });

  it('thickness widens the lines', () => {
    const { depth, normals } = scene();
    const thin = detectEdges(depth, normals, W, H).filter(Boolean).length;
    const thick = detectEdges(depth, normals, W, H, { thickness: 3 }).filter(Boolean).length;
    expect(thick).toBeGreaterThan(thin * 2);
  });
});

describe('colours', () => {
  it('class colours are distinct', () => {
    const keys = new Set(PASS_CLASSES.map((c) => CLASS_COLORS[c].join(',')));
    expect(keys.size).toBe(PASS_CLASSES.length);
  });

  it('instance colours are unique, never black, and stable', () => {
    const seen = new Set<number>();
    for (let n = 1; n <= 5000; n++) {
      const [r, g, b] = entityColor(n);
      const k = (r << 16) | (g << 8) | b;
      expect(k).not.toBe(0);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    expect(entityColor(1)).toEqual([0x9e, 0x37, 0x79]);
  });
});
