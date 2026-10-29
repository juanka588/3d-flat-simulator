import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Minimal PNG reading and writing for the scoring metrics (CG5). The MCP has no image library at run time, and the metrics only
 * need 8-bit pixels: render passes and generated images are non-interlaced PNGs (grey, grey+alpha, RGB, RGBA or palette).
 */

export interface Rgba {
  width: number;
  height: number;
  /** `width * height * 4` bytes, row by row. */
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decodes an 8-bit, non-interlaced PNG to RGBA. Throws a readable error for anything else (JPEG, 16-bit, interlaced). */
export function decodePng(png: Uint8Array): Rgba {
  const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG (JPEG and other formats are not read by the metrics)');
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  let interlace = 0;
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const kind = b.toString('latin1', off + 4, off + 8);
    const body = b.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  const ch = CHANNELS[type];
  if (!ch || depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${type}, interlace ${interlace}); need 8-bit, non-interlaced`);
  if (width < 1 || height < 1 || width * height > 64_000_000) throw new Error('PNG size out of range');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  if (raw.length !== (stride + 1) * height) throw new Error('unexpected PNG data size');
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : undefined;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch]! : 0;
      const up = prev ? prev[i]! : 0;
      const c = prev && i >= ch ? prev[i - ch]! : 0;
      let v = line[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      } else if (filter > 4) throw new Error('bad PNG filter');
      cur[i] = v & 0xff;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const s = i * ch;
    if (type === 6) {
      out[o] = px[s]!;
      out[o + 1] = px[s + 1]!;
      out[o + 2] = px[s + 2]!;
      out[o + 3] = px[s + 3]!;
    } else if (type === 2) {
      out[o] = px[s]!;
      out[o + 1] = px[s + 1]!;
      out[o + 2] = px[s + 2]!;
      out[o + 3] = 255;
    } else if (type === 0 || type === 4) {
      out[o] = out[o + 1] = out[o + 2] = px[s]!;
      out[o + 3] = type === 4 ? px[s + 1]! : 255;
    } else {
      const k = px[s]!;
      if (!palette || k * 3 + 2 >= palette.length) throw new Error('bad PNG palette index');
      out[o] = palette[k * 3]!;
      out[o + 1] = palette[k * 3 + 1]!;
      out[o + 2] = palette[k * 3 + 2]!;
      out[o + 3] = trns && k < trns.length ? trns[k]! : 255;
    }
  }
  return { width, height, data: out };
}

/** Encodes RGBA as a PNG (filter 0, deflate). */
export function encodePng(img: Rgba): Buffer {
  const { width, height, data } = img;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (kind: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(kind, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Box-filter downscale so the longest edge is at most `maxEdge` (never upscales). */
export function downscale(img: Rgba, maxEdge: number): Rgba {
  const k = Math.min(1, maxEdge / Math.max(img.width, img.height));
  if (k >= 1) return img;
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (let j = y0; j < y1; j++)
        for (let i = x0; i < x1; i++) {
          const s = (j * img.width + i) * 4;
          for (let c = 0; c < 4; c++) sum[c]! += img.data[s + c]!;
          n++;
        }
      for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = Math.round(sum[c]! / n);
    }
  }
  return { width: w, height: h, data: out };
}
