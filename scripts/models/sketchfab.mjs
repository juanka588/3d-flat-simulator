/* global console, fetch, process, Buffer, URLSearchParams, setTimeout */
// Sketchfab source of the HD model tier (M5R step 2).
//  - Metadata and licence come from the v3 API (`GET /v3/models/{uid}`): only `cc0` and `by` are accepted.
//  - The glTF archive comes from `GET /v3/models/{uid}/download` with the user's token (SKETCHFAB_TOKEN in
//    scripts/models/.env.local, gitignored, or in the environment). The token is read ONLY here, sent ONLY to
//    api.sketchfab.com (the signed archive URL is fetched without it) and redacted from every error message.
//  - Downloads are sequential and cached under .cache/models/sketchfab/<uid>/ (gitignored), so a re-run is offline.
// CLI: node scripts/models/sketchfab.mjs search "<query>" | meta <uid> | fetch <uid>...
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { objaverseLicence, sha256 } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
export const sketchfabCacheDir = resolve(root, '.cache/models/sketchfab');
const API = 'https://api.sketchfab.com/v3';
const UA = '3d-flat-simulator/0.1 (github.com/juanka588/3d-flat-simulator; HD model library build)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reads SKETCHFAB_TOKEN from the environment or scripts/models/.env.local. Never log the result. */
export function loadToken(env = process.env, file = join(here, '.env.local')) {
  if (env.SKETCHFAB_TOKEN) return env.SKETCHFAB_TOKEN.trim();
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*SKETCHFAB_TOKEN\s*=\s*['"]?([^'"\s#]+)/.exec(line);
      if (m) return m[1];
    }
  }
  return undefined;
}

/** Replaces the token (and any `Token xxx` header text) in a message. */
export function redact(text, token) {
  let out = String(text);
  if (token) out = out.split(token).join('[redacted]');
  return out.replace(/Token\s+[0-9a-f]{16,}/gi, 'Token [redacted]');
}

async function api(path, { token, query } = {}) {
  const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (token) headers.Authorization = `Token ${token}`;
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new Error(redact(`Cannot reach api.sketchfab.com (${err.cause?.code ?? err.message}). Offline?`, token), { cause: err });
  }
  if (res.status === 429) throw new Error('Sketchfab API rate limit (HTTP 429): wait and re-run; cached models are not downloaded again.');
  if (!res.ok) throw new Error(redact(`GET ${path} -> HTTP ${res.status}`, token));
  return res.json();
}

/** Accepted Sketchfab licence slugs -> SPDX-like id; throws for anything else (by-nc, by-nd, by-sa, standard, editorial). */
export function sketchfabLicence(meta, label) {
  return objaverseLicence(meta?.license?.slug, label ?? meta?.uid ?? 'model');
}

/** Metadata + licence evidence of one model (no token needed). */
export async function fetchMeta(uid, now = new Date().toISOString()) {
  const meta = await api(`/models/${uid}`);
  const licence = sketchfabLicence(meta, uid);
  return {
    uid,
    name: meta.name,
    author: meta.user?.displayName ?? meta.user?.username,
    authorUrl: meta.user?.profileUrl,
    licence,
    sourceUrl: meta.viewerUrl ?? `https://sketchfab.com/3d-models/${uid}`,
    faceCount: meta.faceCount,
    isDownloadable: meta.isDownloadable,
    evidence: {
      basis: 'asset-field',
      assetApiUrl: `${API}/models/${uid}`,
      needle: `license.slug=${meta.license?.slug}`,
      assetField: meta.license?.slug,
      licenceLabel: meta.license?.label,
      author: meta.user?.displayName ?? meta.user?.username,
      modelUrl: meta.viewerUrl ?? `https://sketchfab.com/3d-models/${uid}`,
      publishedAt: meta.publishedAt,
      checkedAt: now,
    },
  };
}

/** Downloads (once) and unpacks the glTF archive; returns the path of the .gltf/.glb inside and the archive sha256. */
export async function downloadModel(uid, { token, dir = sketchfabCacheDir } = {}) {
  const out = join(dir, uid);
  const stamp = join(out, '.source.json');
  if (existsSync(stamp)) return JSON.parse(readFileSync(stamp, 'utf8'));
  if (!token) throw new Error('SKETCHFAB_TOKEN is not set (scripts/models/.env.local); cannot download.');
  const dl = await api(`/models/${uid}/download`, { token });
  const pick = dl.gltf ?? dl.glb;
  if (!pick?.url) throw new Error(`${uid}: the download API offers no glTF (${Object.keys(dl).join(', ')})`);
  await sleep(1000);
  let res;
  try {
    res = await fetch(pick.url, { headers: { 'User-Agent': UA } }); // signed URL: the token is NOT sent here
  } catch (err) {
    throw new Error(redact(`archive download failed (${err.cause?.code ?? err.message})`, token), { cause: err });
  }
  if (!res.ok) throw new Error(`${uid}: archive download -> HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  mkdirSync(out, { recursive: true });
  const files = unzipSync(new Uint8Array(zip));
  let entry;
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/') || name.includes('..') || name.startsWith('/')) continue;
    const p = join(out, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    if (!entry && /(^|\/)scene\.gltf$/i.test(name)) entry = name;
    if (!entry && /\.glb$/i.test(name)) entry = name;
  }
  entry ??= Object.keys(files).find((n) => /\.gltf$/i.test(n));
  if (!entry) throw new Error(`${uid}: the archive has no .gltf or .glb`);
  const info = { path: join(out, entry), archiveSha256: sha256(zip), archiveBytes: zip.length };
  writeFileSync(stamp, JSON.stringify(info));
  return info;
}

/** Public search (no token): up to 24 downloadable cc0/by models per call. */
export async function search(q, { licence = 'by', limit = 24 } = {}) {
  const r = await api('/search', { query: { type: 'models', q, downloadable: 'true', license: licence, sort_by: '-likeCount', count: String(limit) } });
  return r.results.map((m) => ({ uid: m.uid, name: m.name, user: m.user?.displayName, faces: m.faceCount, likes: m.likeCount, licence: m.license?.slug ?? licence }));
}

async function cli() {
  const [cmd, ...args] = process.argv.slice(2);
  const token = loadToken();
  if (cmd === 'search') {
    for (const lic of ['cc0', 'by']) for (const m of await search(args.join(' '), { licence: lic })) console.log(`${m.uid} ${lic} ${String(m.faces).padStart(7)} f ${String(m.likes).padStart(5)} L  ${m.name} / ${m.user}`);
  } else if (cmd === 'meta') {
    for (const uid of args) { console.log(JSON.stringify(await fetchMeta(uid))); await sleep(300); }
  } else if (cmd === 'fetch') {
    for (const uid of args) { const m = await fetchMeta(uid); const d = await downloadModel(uid, { token }); console.log(uid, m.licence, d.archiveBytes, 'B', m.name); await sleep(1500); }
  } else {
    console.error('usage: sketchfab.mjs search "<q>" | meta <uid>... | fetch <uid>...');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((err) => { console.error(redact(err.message, loadToken())); process.exit(1); });
}
