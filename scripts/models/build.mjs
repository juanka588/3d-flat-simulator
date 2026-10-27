/* global console, fetch, process, Buffer, URL, setTimeout */
// Model library pipeline: pnpm models:build [--update-pins]
// Fetches the curated CC0 / CC-BY models (manifest.json), asserts licence evidence per asset, normalises each to the
// item frame (see normalise.mjs) and writes GLB + thumbnail + catalog.json into apps/web/public/models. Output is built
// in a staging dir and swapped in only on full success, so a failed or offline run never touches committed files.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { BUDGETS, documentFromFile, normalise } from './normalise.mjs';
import { renderThumb } from './render.mjs';
import { renderCredits, creditsPath } from './credits.mjs';
import {
  LICENCE_POLICIES, assertApiDims, assertCc0Text, assertPlausibleSize, budgetProblems, checkPins, cleanTags, creditLine, objaverseLicence, sha256, stableTimestamp,
} from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const outDir = resolve(root, 'apps/web/public/models');
const cacheDir = resolve(root, '.cache/models');
const stagingDir = resolve(root, '.cache/models-staging');
const UA = '3d-flat-simulator/0.1 (github.com/juanka588/3d-flat-simulator; model library build)';

class OfflineError extends Error {}

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

// ---- sources: each returns { path (cache file for NodeIO), sourceUrl, author, licence, evidence, sourceHashes, apiDimsMm? } ----
let phLicenceOk = false;
async function fetchPolyHaven(entry, now) {
  const id = entry.sourceId;
  const policy = LICENCE_POLICIES.polyhaven;
  if (!phLicenceOk) {
    assertCc0Text(`Licence page ${policy.url}`, await http(policy.url, { text: true }));
    phLicenceOk = true;
  }
  const assetApiUrl = `https://api.polyhaven.com/info/${id}`;
  const info = await http(assetApiUrl, { json: true });
  if (info.type !== 2) throw new Error(`Poly Haven "${id}" is not a model (type ${info.type})`);
  for (const [k, v] of Object.entries(info)) {
    if (/^licen[cs]e/i.test(k) && typeof v === 'string' && !/^cc0/i.test(v.trim())) throw new Error(`${id}: API licence "${v}" is not CC0`);
  }
  const files = await http(`https://api.polyhaven.com/files/${id}`, { json: true });
  const gltf = files.gltf?.['1k']?.gltf;
  if (!gltf) throw new Error(`${id}: no 1k glTF`);
  const sourceHashes = {};
  const fetchFile = async (rel, f) => {
    const buf = await cached(`polyhaven/${id}/${rel}`, () => http(f.url));
    if (f.md5) {
      const md5 = createHash('md5').update(buf).digest('hex');
      if (md5 !== f.md5) throw new Error(`${id}/${rel}: md5 mismatch (${md5} != ${f.md5})`);
    }
    sourceHashes[rel] = sha256(buf);
  };
  await fetchFile(`${id}_1k.gltf`, gltf);
  for (const [rel, f] of Object.entries(gltf.include ?? {})) await fetchFile(rel, f);
  await sleep(150);
  const author = Object.keys(info.authors ?? {}).join(', ') || undefined;
  return {
    path: join(cacheDir, 'polyhaven', id, `${id}_1k.gltf`),
    sourceUrl: `https://polyhaven.com/a/${id}`,
    author,
    licence: 'CC0-1.0',
    evidence: { basis: 'site-policy', policyUrl: policy.url, needle: policy.needle, assetApiUrl, checkedAt: now },
    sourceHashes,
    apiDimsMm: info.dimensions,
    smallObject: Math.max(...(info.dimensions ?? [1000])) < 500,
  };
}

const packCache = new Map();
async function loadPack(manifest, packId, now, pins) {
  if (packCache.has(packId)) return packCache.get(packId);
  const pack = manifest.packs[packId];
  if (!pack) throw new Error(`unknown pack "${packId}"`);
  const zip = await cached(`packs/${packId}.zip`, () => http(pack.url));
  const zipHash = sha256(zip);
  const pinned = checkPins(packId, pack.sha256 ? { zip: pack.sha256 } : undefined, { zip: zipHash }, { update: pins.update });
  if (pinned.changed) { pack.sha256 = zipHash; pins.changed = true; }
  const files = unzipSync(new Uint8Array(zip));
  const licenceName = Object.keys(files).find((n) => /(^|\/)License\.txt$/i.test(n));
  if (!licenceName) throw new Error(`${packId}: the pack has no License.txt`);
  const licenceText = Buffer.from(files[licenceName]).toString('utf8');
  assertCc0Text(`${packId} ${licenceName}`, licenceText);
  const res = { pack, files, licenceName, licenceSha: sha256(licenceText), now };
  packCache.set(packId, res);
  return res;
}

async function fetchKenney(entry, manifest, now, pins) {
  const p = await loadPack(manifest, entry.pack, now, pins);
  const data = p.files[entry.sourceId];
  if (!data) throw new Error(`${entry.slug}: "${entry.sourceId}" is not in the ${entry.pack} pack`);
  const path = join(cacheDir, 'packs', entry.pack, entry.sourceId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return {
    path,
    sourceUrl: p.pack.homepage,
    author: p.pack.author,
    licence: 'CC0-1.0',
    evidence: { basis: 'pack-license-file', packUrl: p.pack.url, file: p.licenceName, fileSha256: p.licenceSha, needle: LICENCE_POLICIES.kenney.needle, checkedAt: now },
    sourceHashes: { glb: sha256(Buffer.from(data)) },
    smallObject: entry.maxDimM[1] < 0.8,
  };
}

/** Objaverse: the per-object licence comes from the Sketchfab record of the uid; only cc0 and by are accepted. */
async function fetchObjaverse(entry, now) {
  const apiUrl = `https://api.sketchfab.com/v3/models/${entry.sourceId}`;
  const meta = await http(apiUrl, { json: true });
  const licence = objaverseLicence(meta.license?.slug, entry.slug);
  const buf = await cached(`objaverse/${entry.sourceId}.glb`, () => http(`https://huggingface.co/datasets/allenai/objaverse/resolve/main/${entry.hfPath}`));
  const path = join(cacheDir, 'objaverse', `${entry.sourceId}.glb`);
  return {
    path,
    sourceUrl: meta.viewerUrl ?? `https://sketchfab.com/3d-models/${entry.sourceId}`,
    author: meta.user?.displayName,
    licence,
    evidence: { basis: 'asset-field', assetApiUrl: apiUrl, assetField: meta.license?.slug, checkedAt: now },
    sourceHashes: { glb: sha256(buf) },
    smallObject: entry.maxDimM[1] < 0.8,
  };
}

// ---- main ---------------------------------------------------------------------------------
async function main() {
  const manifestPath = join(here, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const pins = { update: process.argv.includes('--update-pins'), changed: false };
  const previous = new Map();
  try {
    for (const e of JSON.parse(readFileSync(join(outDir, 'catalog.json'), 'utf8'))) previous.set(e.id, e);
  } catch {
    // first build
  }
  const slugs = new Set();
  for (const e of manifest.models) {
    if (slugs.has(e.slug)) throw new Error(`duplicate slug ${e.slug}`);
    slugs.add(e.slug);
  }
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(join(stagingDir, 'thumbs'), { recursive: true });
  const now = new Date().toISOString();
  const catalog = [];
  let total = 0;

  for (const entry of manifest.models) {
    process.stdout.write(`${entry.slug} (${entry.source}:${entry.sourceId}) ... `);
    const src =
      entry.source === 'polyhaven' ? await fetchPolyHaven(entry, now)
      : entry.source === 'kenney' ? await fetchKenney(entry, manifest, now, pins)
      : entry.source === 'objaverse' ? await fetchObjaverse(entry, now)
      : (() => { throw new Error(`${entry.slug}: unsupported source "${entry.source}"`); })();
    const pinned = checkPins(entry.slug, entry.sourceSha256, src.sourceHashes, { update: pins.update });
    if (pinned.changed) { entry.sourceSha256 = pinned.pins; pins.changed = true; }

    let thumb;
    const res = await normalise(() => documentFromFile(src.path), {
      front: entry.front ?? '+z',
      unitScale: entry.unitScale ?? 1,
      texMax: entry.texMax ?? 512,
      maxTris: entry.maxTris ?? 12000,
      onStageA: async (doc) => { thumb = await renderThumb(doc, 160); },
    });
    if (src.apiDimsMm) assertApiDims(entry.slug, res.dims, src.apiDimsMm);
    else assertPlausibleSize(entry.slug, res.dims, entry.maxDimM);
    if (entry.maxDimM) assertPlausibleSize(entry.slug, res.dims, entry.maxDimM);

    const file = `${entry.slug}.glb`;
    const thumbFile = `thumbs/${entry.slug}.webp`;
    writeFileSync(join(stagingDir, file), res.glb);
    writeFileSync(join(stagingDir, thumbFile), thumb);
    const id = `${entry.source}:${entry.slug}`;
    const outSha = sha256(res.glb);
    const retrievedAt = stableTimestamp(previous.get(id), { source: entry.source, sha256: outSha }, now);
    const record = {
      id,
      name: entry.name,
      source: 'cc0',
      licence: src.licence,
      credit: creditLine({ name: entry.name, author: src.author, source: entry.source, sourceUrl: src.sourceUrl, licence: src.licence }),
      category: entry.category,
      styleTags: cleanTags(entry.styleTags),
      nativeDims: res.dims,
      anchor: [0, 0, 0],
      front: '+z',
      file,
      // ---- extras (not part of MeshAsset; loaders strip them) ----
      thumb: thumbFile,
      thumbSha256: sha256(thumb),
      provider: entry.source,
      sourceId: entry.sourceId,
      sourceUrl: src.sourceUrl,
      author: src.author ?? null,
      sha256: outSha,
      bytes: res.glb.length,
      triangles: res.triangles,
      materials: res.materials,
      textureMax: res.textureMax,
      normalisation: { sourceFront: entry.front ?? '+z', unitScale: entry.unitScale ?? 1, sourcePivot: res.sourceAnchor, sourceTriangles: res.sourceTriangles },
      licenseEvidence: src.evidence,
      sourceSha256: entry.sourceSha256,
      retrievedAt,
    };
    const problems = budgetProblems(record, BUDGETS);
    if (problems.length) throw new Error(problems.join('; '));
    total += res.glb.length;
    catalog.push(record);
    console.log(`${(res.glb.length / 1024).toFixed(0)} KB, ${res.triangles} tris, ${res.dims.w}x${res.dims.d}x${res.dims.h} m`);
  }
  if (total > BUDGETS.totalBytes) throw new Error(`library is ${total} B, over the ${BUDGETS.totalBytes} B budget`);
  catalog.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(stagingDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');

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
  writeFileSync(creditsPath, renderCredits(catalog, manifest.packs));
  if (pins.changed) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log('manifest.json: pins written (commit them)');
  }
  console.log(`\n${catalog.length} models, ${(total / 1024 / 1024).toFixed(2)} MB -> ${outDir}`);
}

main().catch((err) => {
  rmSync(stagingDir, { recursive: true, force: true });
  if (err instanceof OfflineError) console.error(`\nmodels:build failed (offline): ${err.message}`);
  else console.error(`\nmodels:build failed: ${err.stack ?? err}`);
  process.exit(1);
});
