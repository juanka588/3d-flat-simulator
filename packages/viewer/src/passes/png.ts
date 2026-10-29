/**
 * A minimal, deterministic PNG encoder for the render passes: 8 or 16 bit, 1/3/4 channels, no filtering, zlib from
 * the platform's `CompressionStream` (browser and Node). The same pixels always give the same bytes, which is what the
 * pass hashes in the tests rely on. 16-bit samples are written big-endian as the format requires.
 */

export interface RawImage {
  width: number;
  height: number;
  /** 1 = grayscale, 3 = RGB, 4 = RGBA. */
  channels: 1 | 3 | 4;
  bitDepth: 8 | 16;
  /** Row-major, top row first, `width * height * channels` samples. */
  data: Uint8Array | Uint16Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const COLOR_TYPE = { 1: 0, 3: 2, 4: 6 } as const;

let crcTable: Uint32Array | undefined;
function crc32(parts: Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = crcTable[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function chunk(type: string, body: Uint8Array): Uint8Array {
  const t = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
  const out = new Uint8Array(12 + body.length);
  out.set(u32(body.length), 0);
  out.set(t, 4);
  out.set(body, 8);
  out.set(u32(crc32([t, body])), 8 + body.length);
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng(img: RawImage): Promise<Uint8Array> {
  const { width, height, channels, bitDepth, data } = img;
  const samples = width * channels;
  if (data.length !== samples * height) throw new Error(`png: expected ${samples * height} samples, got ${data.length}`);
  const bytesPerSample = bitDepth / 8;
  const rowBytes = samples * bytesPerSample;
  const raw = new Uint8Array((rowBytes + 1) * height); // filter byte 0 (None) per row
  for (let y = 0; y < height; y++) {
    const o = y * (rowBytes + 1) + 1;
    if (bitDepth === 8) raw.set((data as Uint8Array).subarray(y * samples, (y + 1) * samples), o);
    else {
      for (let i = 0; i < samples; i++) {
        const v = (data as Uint16Array)[y * samples + i]!;
        raw[o + 2 * i] = v >> 8;
        raw[o + 2 * i + 1] = v & 255;
      }
    }
  }
  const header = new Uint8Array(13);
  header.set(u32(width), 0);
  header.set(u32(height), 4);
  header[8] = bitDepth;
  header[9] = COLOR_TYPE[channels];
  const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', header), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `data:image/png;base64,...` of PNG bytes. */
export function pngDataUrl(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}
