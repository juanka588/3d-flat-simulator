/* global console, fetch, process, Buffer, URL, setTimeout */
// Material library pipeline: pnpm materials:build
// Fetches the curated CC0 assets (manifest.json), asserts the licence, and writes processed 1K WebP
// maps + catalog.json into apps/web/public/materials. Output is built in a temp dir and swapped in
// only on full success, so a failed or offline run never touches committed files.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { renderCredits, creditsPath } from './credits.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const outDir = resolve(root, 'apps/web/public/materials');
const cacheDir = resolve(root, '.cache/materials');
const stagingDir = resolve(root, '.cache/materials-staging');
const UA = '3d-flat-simulator/0.1 (github.com/juanka588/3d-flat-simulator)';
const SIZE = 1024;
const MATERIAL_BUDGET = 350 * 1024;
const TOTAL_BUDGET = 8 * 1024 * 1024;

class OfflineError extends Error {}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function http(url, { json = false, text = false } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  } catch (err) {
    throw new OfflineError(`Cannot reach ${new URL(url).host} (${err.cause?.code ?? err.message}). Are you offline? Committed output was not modified.`);
  }
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  if (json) return res.json();
  if (text) return res.text();
  return Buffer.from(await res.arrayBuffer());
}

async function cached(name, loader) {
  const p = join(cacheDir, name);
  if (existsSync(p)) return readFileSync(p);
  const buf = await loader();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
  return buf;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- licence assertion --------------------------------------------------------------------
// Neither API exposes a per-asset licence field (verified in the spike); both sites publish a single
// site-wide CC0 policy. We assert (a) the API knows the asset and (b) the site's licence page still says CC0.
const licenceChecks = {
  ambientcg: { url: 'https://docs.ambientcg.com/license/', needle: 'CC0 1.0 Universal' },
  polyhaven: { url: 'https://polyhaven.com/license', needle: 'CC0' },
};
const licenceOk = new Set();
async function assertLicence(source) {
  if (licenceOk.has(source)) return;
  const { url, needle } = licenceChecks[source];
  const html = await http(url, { text: true });
  if (!html.includes(needle)) throw new Error(`Licence page ${url} no longer mentions "${needle}"; refusing to build.`);
  licenceOk.add(source);
}

// ---- source fetchers: return { color, normal, roughness|null, tileSizeApiM|null, sourceUrl } ---
async function fetchAmbientCg(entry) {
  const meta = await http(
    `https://ambientcg.com/api/v2/full_json?id=${encodeURIComponent(entry.sourceId)}&include=downloadData`,
    { json: true },
  );
  const asset = meta.foundAssets?.find((a) => a.assetId.toLowerCase() === entry.sourceId.toLowerCase());
  if (!asset) throw new Error(`ambientCG has no asset "${entry.sourceId}"`);
  if (asset.dataType !== 'Material') throw new Error(`${entry.sourceId} is a ${asset.dataType}, not a Material`);
  const zips = asset.downloadFolders.default.downloadFiletypeCategories.zip.downloads;
  const pick = zips.find((d) => d.attribute === '1K-JPG') ?? zips.find((d) => d.attribute === '2K-JPG');
  if (!pick) throw new Error(`${entry.sourceId}: no 1K/2K JPG zip`);
  const zip = await cached(`ambientcg/${pick.fileName}`, () => http(pick.downloadLink));
  const files = unzipSync(new Uint8Array(zip));
  const find = (re) => {
    const k = Object.keys(files).find((n) => re.test(n));
    return k ? Buffer.from(files[k]) : null;
  };
  const color = find(/_Color\.(jpg|png)$/i);
  const normal = find(/_NormalGL\.(jpg|png)$/i);
  if (!color || !normal) throw new Error(`${entry.sourceId}: zip lacks Color/NormalGL (${Object.keys(files).join(', ')})`);
  const dim = asset.dimensionX > 0 ? asset.dimensionX / 100 : null; // API gives centimetres
  return { color, normal, roughness: find(/_Roughness\.(jpg|png)$/i), tileSizeApiM: dim, sourceUrl: asset.shortLink };
}

async function fetchPolyHaven(entry) {
  const id = entry.sourceId;
  const info = await http(`https://api.polyhaven.com/info/${id}`, { json: true });
  if (info.type !== 1) throw new Error(`Poly Haven "${id}" is not a texture (type ${info.type})`);
  const files = await http(`https://api.polyhaven.com/files/${id}`, { json: true });
  const get = async (map) => {
    const f = files[map]?.['1k']?.jpg;
    if (!f) return null;
    const buf = await cached(`polyhaven/${id}/${map}_1k.jpg`, () => http(f.url));
    const md5 = createHash('md5').update(buf).digest('hex');
    if (md5 !== f.md5) throw new Error(`${id}/${map}: md5 mismatch (${md5} != ${f.md5})`);
    return buf;
  };
  const [color, normal, roughness] = [await get('Diffuse'), await get('nor_gl'), await get('Rough')];
  if (!color || !normal) throw new Error(`${id}: missing Diffuse/nor_gl 1k`);
  const dim = info.dimensions?.[0] > 0 ? info.dimensions[0] / 1000 : null; // API gives millimetres
  return { color, normal, roughness, tileSizeApiM: dim, sourceUrl: `https://polyhaven.com/a/${id}` };
}

// ---- image processing ---------------------------------------------------------------------
const base = (buf, size = SIZE) => sharp(buf, { failOn: 'none' }).resize(size, size, { fit: 'cover', position: 'centre' });

const srgbToLinear = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const linearToSrgb = (l) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055));

async function meanColor(buf) {
  const { data, info } = await base(buf).resize(64, 64).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  const n = info.width * info.height;
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) sum[c] += srgbToLinear(data[i * info.channels + c]);
  const linear = sum.map((s) => +(s / n).toFixed(5));
  const hex = '#' + linear.map((l) => linearToSrgb(l).toString(16).padStart(2, '0')).join('');
  return { linear, hex };
}

/** Encode with decreasing quality until `maxBytes` is met. */
async function encode(pipeline, { quality, min, maxBytes, opts = {} }) {
  let q = quality;
  for (;;) {
    const buf = await pipeline.clone().webp({ quality: q, effort: 6, ...opts }).toBuffer();
    if (buf.length <= maxBytes || q <= min) return { buf, quality: q };
    q -= 5;
  }
}

async function processEntry(entry, src, dir) {
  // Fine woven textures (fabrics) are all high-frequency detail and blow the budget at 1K; the manifest may opt into 512.
  const size = entry.size ?? SIZE;
  const budgets = { color: 160 * 1024, normal: 130 * 1024, roughness: 40 * 1024 };
  const out = {};
  out.color = (await encode(base(src.color, size), { quality: 80, min: 40, maxBytes: budgets.color })).buf;
  out.normal = (await encode(base(src.normal, size), { quality: 85, min: 45, maxBytes: budgets.normal, opts: { smartSubsample: true } })).buf;
  if (src.roughness) {
    out.roughness = (await encode(base(src.roughness, size).greyscale(), { quality: 75, min: 30, maxBytes: budgets.roughness })).buf;
  } else {
    // No roughness map at source: ship a flat map at the manifest default so the viewer path stays uniform.
    const v = Math.round(entry.roughnessDefault * 255);
    out.roughness = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: v, g: v, b: v } } })
      .webp({ quality: 75 }).toBuffer();
  }
  out.thumb = await base(src.color, size).resize(128, 128).webp({ quality: 75, effort: 6 }).toBuffer();
  mkdirSync(dir, { recursive: true });
  const files = {}, fileBytes = {}, hashes = {};
  let bytes = 0;
  for (const [k, buf] of Object.entries(out)) {
    files[k] = `${k}.webp`;
    fileBytes[k] = buf.length;
    hashes[k] = sha256(buf);
    bytes += buf.length;
    writeFileSync(join(dir, files[k]), buf);
  }
  if (bytes > MATERIAL_BUDGET) throw new Error(`${entry.slug}: ${bytes} B exceeds the ${MATERIAL_BUDGET} B per-material budget`);
  return { files, fileBytes, sha256: hashes, bytes };
}

// ---- main ---------------------------------------------------------------------------------
async function main() {
  const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
  const slugs = new Set();
  for (const e of manifest) {
    if (slugs.has(e.slug)) throw new Error(`duplicate slug ${e.slug}`);
    slugs.add(e.slug);
  }
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  const retrievedAt = new Date().toISOString();
  const catalog = [];
  let total = 0;

  for (const entry of manifest) {
    process.stdout.write(`${entry.slug} (${entry.source}:${entry.sourceId}) ... `);
    await assertLicence(entry.source);
    const src = entry.source === 'ambientcg' ? await fetchAmbientCg(entry) : await fetchPolyHaven(entry);
    if (entry.tileSizeBasis === 'api') {
      if (src.tileSizeApiM == null) throw new Error(`${entry.slug}: manifest says size comes from the API but the API has none`);
      if (Math.abs(src.tileSizeApiM - entry.tileSizeM) / entry.tileSizeM > 0.02)
        throw new Error(`${entry.slug}: manifest tileSizeM ${entry.tileSizeM} != API ${src.tileSizeApiM}`);
    }
    const res = await processEntry(entry, src, join(stagingDir, entry.slug));
    const mc = await meanColor(src.color);
    total += res.bytes;
    catalog.push({
      id: entry.slug,
      name: entry.name,
      category: entry.category,
      tileSizeM: entry.tileSizeM,
      tileSizeBasis: entry.tileSizeBasis,
      resolution: entry.size ?? SIZE,
      meanColor: mc.hex,
      meanLinear: mc.linear,
      roughness: entry.roughnessDefault,
      bytes: res.bytes,
      files: res.files,
      fileBytes: res.fileBytes,
      source: entry.source,
      sourceId: entry.sourceId,
      sourceUrl: src.sourceUrl,
      license: 'CC0-1.0',
      retrievedAt,
      sha256: res.sha256,
    });
    console.log(`${(res.bytes / 1024).toFixed(0)} KB`);
    if (entry.source === 'polyhaven') await sleep(200);
  }
  if (total > TOTAL_BUDGET) throw new Error(`library is ${total} B, over the ${TOTAL_BUDGET} B budget`);
  writeFileSync(join(stagingDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');

  // swap staging into place
  const backup = outDir + '.old';
  rmSync(backup, { recursive: true, force: true });
  mkdirSync(dirname(outDir), { recursive: true });
  if (existsSync(outDir)) renameSync(outDir, backup);
  try {
    renameSync(stagingDir, outDir);
  } catch (err) {
    if (existsSync(backup)) renameSync(backup, outDir);
    throw err;
  }
  rmSync(backup, { recursive: true, force: true });
  writeFileSync(creditsPath, renderCredits(catalog));
  console.log(`\n${catalog.length} materials, ${(total / 1024 / 1024).toFixed(2)} MB -> ${outDir}`);
}

main().catch((err) => {
  rmSync(stagingDir, { recursive: true, force: true });
  if (err instanceof OfflineError) console.error(`\nmaterials:build failed (offline): ${err.message}`);
  else console.error(`\nmaterials:build failed: ${err.stack ?? err}`);
  process.exit(1);
});
