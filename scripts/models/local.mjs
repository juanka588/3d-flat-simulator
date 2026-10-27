/* global console, process */
// 3D-FUTURE local pack (M5.5): pnpm models:local --src <dir> [--i-accept-the-licence] [--out <dir>] [--limit n]
//
// Converts the user's own copy of the 3D-FUTURE dataset (research licence, NOT redistributable) into normalised
// Meshopt GLBs under apps/server/local-assets/3d-future (gitignored), served by the local server only.
//
// ASSUMED SOURCE LAYOUT (from public descriptions of the dataset; UNVERIFIED against a real download):
//   <src>/model_info.json                  array of { model_id, category, super-category, style, theme, material }
//   <src>/<model_id>/raw_model.obj         Y-up OBJ, metres  (+ raw_model.mtl or model.mtl, texture.png next to it)
// A `3D-FUTURE-model/` folder inside <src> is also accepted. Adjust `findModelDir` / `readInfo` if the real layout differs.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGETS, normalise } from './normalise.mjs';
import { documentFromObj } from './obj.mjs';
import { renderThumb } from './render.mjs';
import { cleanTags, sha256 } from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_OUT = resolve(root, 'apps/server/local-assets/3d-future');
export const LICENCE_ID = 'LicenseRef-3D-FUTURE';
export const LICENCE_REMINDER = [
  '3D-FUTURE licence reminder',
  '  The 3D-FUTURE dataset (Alibaba / Tao Bao, https://tianchi.aliyun.com/specials/promotion/alibaba-3d-future) is licensed for',
  '  NON-COMMERCIAL ACADEMIC RESEARCH only and may not be redistributed. The converted files stay on this machine,',
  '  under apps/server/local-assets/ (gitignored), and are never committed, deployed or served from GitHub Pages.',
].join('\n');

/** 3D-FUTURE category names (English, as published) -> our ProductCategory. First match wins. */
const CATEGORY_MAP = [
  [/night\s*stand|bedside/i, 'bedside'], [/bed/i, 'bed'], [/wardrobe/i, 'wardrobe'], [/drawer|chest of|dresser/i, 'drawers'],
  [/book\s*case|book\s*shelf|shelf|shelves/i, 'shelf'], [/tv\s*stand|tv\s*cabinet|television/i, 'tv_unit'],
  [/sideboard|buffet|cabinet|console|entrance|shoe/i, 'sideboard'], [/desk/i, 'desk'], [/sofa|couch|loveseat|love seat/i, 'sofa'],
  [/arm\s*chair|lounge chair|recliner|chaise/i, 'armchair'], [/chair|stool|bench|ottoman/i, 'chair'],
  [/table/i, 'table'], [/lamp|light|chandelier|pendant/i, 'lamp'], [/mirror/i, 'mirror'], [/rug|carpet/i, 'rug'],
];
export function mapCategory(category, superCategory = '') {
  const text = `${category ?? ''} ${superCategory ?? ''}`;
  for (const [re, cat] of CATEGORY_MAP) if (re.test(category ?? '')) return cat;
  for (const [re, cat] of CATEGORY_MAP) if (re.test(text)) return cat;
  return 'other';
}

export function readInfo(src) {
  const p = join(src, 'model_info.json');
  if (!existsSync(p)) throw new Error(`${p} not found (expected the 3D-FUTURE model_info.json)`);
  const info = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(info)) throw new Error('model_info.json must be an array');
  return info;
}

export function findModelDir(src, id) {
  for (const base of [src, join(src, '3D-FUTURE-model')]) {
    const d = join(base, id);
    if (existsSync(join(d, 'raw_model.obj'))) return d;
  }
  return null;
}

/** Records the licence acceptance once; returns true when accepted (flag now or marker earlier). */
export function ensureAccepted(out, flag, log = console.log) {
  const marker = join(out, '.licence-accepted');
  if (existsSync(marker)) return true;
  if (!flag) return false;
  mkdirSync(out, { recursive: true });
  writeFileSync(marker, JSON.stringify({ acceptedAt: new Date().toISOString(), licence: LICENCE_ID }) + '\n');
  log(`licence acceptance recorded in ${marker}`);
  return true;
}

export async function convertLocal({ src, out = DEFAULT_OUT, accept = false, limit = Infinity, log = console.log }) {
  log(LICENCE_REMINDER);
  if (!ensureAccepted(out, accept, log)) throw new Error('licence not accepted: re-run with --i-accept-the-licence (recorded once in a local marker file)');
  const info = readInfo(src);
  const staging = `${out}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, 'thumbs'), { recursive: true });
  const catalog = [];
  const skipped = [];
  for (const m of info.slice(0, limit)) {
    const id = String(m.model_id ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/.test(id)) { skipped.push({ id, reason: 'unsafe model_id' }); continue; }
    const dir = findModelDir(src, id);
    if (!dir) { skipped.push({ id, reason: 'no raw_model.obj' }); continue; }
    try {
      let thumb;
      const res = await normalise(() => documentFromObj(join(dir, 'raw_model.obj')), {
        front: '+z', texMax: 512, maxTris: BUDGETS.triangles,
        onStageA: async (doc) => { thumb = await renderThumb(doc, 160); },
      });
      writeFileSync(join(staging, `${id}.glb`), res.glb);
      writeFileSync(join(staging, 'thumbs', `${id}.webp`), thumb);
      catalog.push({
        id: `local:3dfuture:${id}`,
        name: `${m.category ?? 'Model'} ${id.slice(0, 8)}`.slice(0, 120),
        source: '3dfuture',
        licence: LICENCE_ID,
        credit: '3D-FUTURE dataset (Alibaba), non-commercial research use only',
        category: mapCategory(m.category, m['super-category']),
        styleTags: cleanTags([m.style, m.theme, m.material, m.category].filter((t) => typeof t === 'string' && t && t !== 'Others')),
        nativeDims: res.dims,
        anchor: [0, 0, 0],
        front: '+z',
        file: `${id}.glb`,
        thumb: `thumbs/${id}.webp`,
        sha256: sha256(res.glb),
        bytes: res.glb.length,
        triangles: res.triangles,
        materials: res.materials,
        sourceCategory: m.category ?? null,
      });
    } catch (err) {
      skipped.push({ id, reason: String(err.message ?? err) });
    }
  }
  catalog.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(staging, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  // keep the acceptance marker across the swap
  const marker = join(out, '.licence-accepted');
  if (existsSync(marker)) writeFileSync(join(staging, '.licence-accepted'), readFileSync(marker));
  const backup = `${out}.old`;
  rmSync(backup, { recursive: true, force: true });
  if (existsSync(out)) renameSync(out, backup);
  try { renameSync(staging, out); } catch (err) { if (existsSync(backup)) renameSync(backup, out); throw err; }
  rmSync(backup, { recursive: true, force: true });
  log(`${catalog.length} models converted, ${skipped.length} skipped -> ${out}`);
  for (const s of skipped) log(`  skipped ${s.id}: ${s.reason}`);
  return { catalog, skipped };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = arg('--src');
  if (!src) {
    console.error('usage: pnpm models:local --src <3D-FUTURE dir> [--i-accept-the-licence] [--out <dir>] [--limit n]\n\n' + LICENCE_REMINDER);
    process.exit(2);
  }
  convertLocal({ src: resolve(src), out: arg('--out') ? resolve(arg('--out')) : DEFAULT_OUT, accept: process.argv.includes('--i-accept-the-licence'), limit: arg('--limit') ? Number(arg('--limit')) : Infinity })
    .catch((err) => { console.error(`models:local failed: ${err.message}`); process.exit(1); });
}
