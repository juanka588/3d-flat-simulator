/* global console, fetch, process, Buffer */
// Environment map pipeline: pnpm env:build
// Fetches the CC0 Poly Haven interior HDRI named in ENV below (1k .hdr), checks its md5 against the API and
// the site's licence page, downsamples it to 512x256 and writes a small RGBE file plus catalog.json to
// apps/web/public/env. The viewer turns it into a PMREM for `scene.environment` (reflections of an interior).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LICENCE_POLICIES, assertPolicyPage, licenceEvidence } from '../materials/lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const outDir = resolve(root, 'apps/web/public/env');
const cacheDir = resolve(root, '.cache/env');
const UA = '3d-flat-simulator/0.1 (github.com/juanka588/3d-flat-simulator)';
const ENV = { slug: 'small-empty-room', sourceId: 'small_empty_room_1', name: 'Small empty room (neutral interior with a window)', width: 512, height: 256 };
const MAX_BYTES = 1024 * 1024;

async function http(url, { json = false, text = false } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  if (json) return res.json();
  if (text) return res.text();
  return Buffer.from(await res.arrayBuffer());
}

/** Reads an RGBE file (new-style RLE scanlines) to a float RGB array. */
export function decodeRgbe(buf) {
  let pos = 0;
  const line = () => {
    let s = '';
    while (pos < buf.length && buf[pos] !== 10) s += String.fromCharCode(buf[pos++]);
    pos++;
    return s;
  };
  if (!line().startsWith('#?')) throw new Error('not a Radiance HDR file');
  while (line() !== '') if (pos >= buf.length) throw new Error('truncated header');
  const m = line().match(/^-Y (\d+) \+X (\d+)$/);
  if (!m) throw new Error('unsupported RGBE orientation');
  const h = Number(m[1]);
  const w = Number(m[2]);
  const rgbe = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (buf[pos] !== 2 || buf[pos + 1] !== 2 || buf[pos + 2] & 0x80) throw new Error('only new-style RLE scanlines are supported');
    pos += 4;
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < w) {
        let n = buf[pos++];
        if (n > 128) {
          n -= 128;
          const v = buf[pos++];
          while (n--) rgbe[(y * w + x++) * 4 + c] = v;
        } else {
          while (n--) rgbe[(y * w + x++) * 4 + c] = buf[pos++];
        }
      }
    }
  }
  const out = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const e = rgbe[i * 4 + 3];
    const f = e === 0 ? 0 : Math.pow(2, e - 136);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = rgbe[i * 4 + c] * f;
  }
  return { w, h, data: out };
}

/** Box-filter downsample in linear light. */
export function downsample({ w, h, data }, tw, th) {
  const out = new Float32Array(tw * th * 3);
  const sx = w / tw;
  const sy = h / th;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const acc = [0, 0, 0];
      let n = 0;
      for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++) {
        for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) {
          for (let c = 0; c < 3; c++) acc[c] += data[(yy * w + xx) * 3 + c];
          n++;
        }
      }
      for (let c = 0; c < 3; c++) out[(y * tw + x) * 3 + c] = acc[c] / n;
    }
  }
  return { w: tw, h: th, data: out };
}

/** Writes new-style RLE scanlines using literal packets only (valid, simple, ~1% bigger than raw RGBE). */
export function encodeRgbe({ w, h, data }) {
  const parts = [Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`, 'latin1')];
  for (let y = 0; y < h; y++) {
    const planes = [new Uint8Array(w), new Uint8Array(w), new Uint8Array(w), new Uint8Array(w)];
    for (let x = 0; x < w; x++) {
      const r = data[(y * w + x) * 3];
      const g = data[(y * w + x) * 3 + 1];
      const b = data[(y * w + x) * 3 + 2];
      const v = Math.max(r, g, b);
      if (v < 1e-32) continue;
      const e = Math.floor(Math.log2(v)) + 1;
      const scale = 256 / Math.pow(2, e);
      planes[0][x] = Math.min(255, Math.floor(r * scale));
      planes[1][x] = Math.min(255, Math.floor(g * scale));
      planes[2][x] = Math.min(255, Math.floor(b * scale));
      planes[3][x] = e + 128;
    }
    parts.push(Buffer.from([2, 2, (w >> 8) & 0xff, w & 0xff]));
    for (const p of planes) {
      for (let i = 0; i < w; i += 128) {
        const chunk = p.subarray(i, Math.min(w, i + 128));
        parts.push(Buffer.from([chunk.length]), Buffer.from(chunk));
      }
    }
  }
  return Buffer.concat(parts);
}

async function main() {
  assertPolicyPage('polyhaven', await http(LICENCE_POLICIES.polyhaven.url, { text: true }));
  const assetApiUrl = `https://api.polyhaven.com/info/${ENV.sourceId}`;
  const info = await http(assetApiUrl, { json: true });
  if (info.type !== 0) throw new Error(`${ENV.sourceId} is not an HDRI (type ${info.type})`);
  const files = await http(`https://api.polyhaven.com/files/${ENV.sourceId}`, { json: true });
  const f = files.hdri?.['1k']?.hdr;
  if (!f) throw new Error('no 1k hdr');
  const cached = join(cacheDir, `${ENV.sourceId}_1k.hdr`);
  let src;
  if (existsSync(cached)) src = readFileSync(cached);
  else {
    src = await http(f.url);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cached, src);
  }
  const md5 = createHash('md5').update(src).digest('hex');
  if (md5 !== f.md5) throw new Error(`${ENV.sourceId}: md5 mismatch (${md5} != ${f.md5})`);
  const small = downsample(decodeRgbe(src), ENV.width, ENV.height);
  const out = encodeRgbe(small);
  if (out.length > MAX_BYTES) throw new Error(`${out.length} B is over the ${MAX_BYTES} B budget`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${ENV.slug}.hdr`), out);
  const previous = existsSync(join(outDir, 'catalog.json')) ? JSON.parse(readFileSync(join(outDir, 'catalog.json'), 'utf8'))[0] : undefined;
  const sha256 = createHash('sha256').update(out).digest('hex');
  const checkedAt = previous && previous.sha256 === sha256 ? previous.retrievedAt : new Date().toISOString();
  const entry = {
    id: ENV.slug,
    name: ENV.name,
    file: `${ENV.slug}.hdr`,
    width: ENV.width,
    height: ENV.height,
    bytes: out.length,
    sha256,
    source: 'polyhaven',
    sourceId: ENV.sourceId,
    sourceUrl: `https://polyhaven.com/a/${ENV.sourceId}`,
    license: 'CC0-1.0',
    licenseEvidence: licenceEvidence({ source: 'polyhaven', assetApiUrl, assetField: undefined, checkedAt }),
    sourceSha256: createHash('sha256').update(src).digest('hex'),
    retrievedAt: checkedAt,
    note: 'Downsampled from the 1k original (box filter) to 512x256; used only for reflections and image-based ambient light.',
  };
  writeFileSync(join(outDir, 'catalog.json'), JSON.stringify([entry], null, 2) + '\n');
  console.log(`${ENV.slug}: ${(out.length / 1024).toFixed(0)} KB -> ${outDir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`env:build failed: ${err.stack ?? err}`);
    process.exit(1);
  });
}
