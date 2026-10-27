// Pure helpers of the model pipeline (no network, no disk), unit-tested in lib.test.mjs.
import { createHash } from 'node:crypto';

export const CC0_DEED_NEEDLE = 'creativecommons.org/publicdomain/zero';

/** Licence page / file policy per source. Pack-level sources (Kenney) assert the pack's own License.txt. */
export const LICENCE_POLICIES = {
  polyhaven: { url: 'https://polyhaven.com/license', needle: CC0_DEED_NEEDLE, licence: 'CC0-1.0' },
  kenney: { needle: CC0_DEED_NEEDLE, licence: 'CC0-1.0', file: 'License.txt' },
  quaternius: { needle: CC0_DEED_NEEDLE, licence: 'CC0-1.0', file: 'License.txt' },
};

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Throws unless `text` (a licence page or a pack's License.txt) names the CC0 1.0 deed. */
export function assertCc0Text(label, text) {
  if (typeof text !== 'string' || !text.includes(CC0_DEED_NEEDLE)) {
    throw new Error(`${label} does not link "${CC0_DEED_NEEDLE}"; refusing to build.`);
  }
}

/** Sketchfab / Objaverse licence slugs: only cc0 and by (attribution) are redistributable here. */
const OBJAVERSE_OK = { cc0: 'CC0-1.0', by: 'CC-BY-4.0' };
const OBJAVERSE_REJECT = new Set(['by-sa', 'by-nc', 'by-nd', 'by-nc-sa', 'by-nc-nd', 'st', 'sketchfab-standard', 'ed']);

/** Maps a per-object Objaverse (Sketchfab) licence slug to an SPDX-like id; throws for nc, sa, nd and unknown. */
export function objaverseLicence(slug, label = 'object') {
  const s = String(slug ?? '').trim().toLowerCase();
  if (OBJAVERSE_OK[s]) return OBJAVERSE_OK[s];
  if (OBJAVERSE_REJECT.has(s)) throw new Error(`${label}: licence "${s}" is not redistributable here (only cc0 and by); rejected.`);
  throw new Error(`${label}: unknown licence "${s}"; rejected.`);
}

/** The credit line required for an entry. CC-BY needs it; CC0 gets one anyway. */
export function creditLine({ name, author, source, sourceUrl, licence }) {
  const who = author ? ` by ${author}` : '';
  const via = { polyhaven: 'Poly Haven', kenney: 'Kenney (kenney.nl)', quaternius: 'Quaternius', objaverse: 'Objaverse / Sketchfab', sketchfab: 'Sketchfab' }[source] ?? source;
  return `"${name}"${who}, ${via}, ${licence}${sourceUrl ? ` (${sourceUrl})` : ''}`.slice(0, 300);
}

/** Pins: a missing pin is filled in; a differing pin throws unless `update`. */
export function checkPins(slug, pinned, actual, { update = false } = {}) {
  const pins = { ...(pinned ?? {}) };
  let changed = false;
  for (const [name, hash] of Object.entries(actual)) {
    if (pins[name] === undefined) { pins[name] = hash; changed = true; }
    else if (pins[name] !== hash) {
      if (!update) throw new Error(`${slug}: ${name} hash ${hash} differs from the pinned ${pins[name]}. The upstream file changed; review it, then re-run with --update-pins.`);
      pins[name] = hash; changed = true;
    }
  }
  return { pins: Object.fromEntries(Object.entries(pins).sort(([a], [b]) => a.localeCompare(b))), changed };
}

/** `retrievedAt` stays when the output is byte-identical, so a no-op rebuild leaves catalog.json untouched. */
export function stableTimestamp(previous, entry, now) {
  return previous && previous.sha256 === entry.sha256 && previous.source === entry.source && typeof previous.retrievedAt === 'string'
    ? previous.retrievedAt
    : now;
}

/** Metre-unit sanity check: the largest normalised dimension must lie in the manifest's plausible range. */
export function assertPlausibleSize(slug, dims, [lo, hi]) {
  const max = Math.max(dims.w, dims.d, dims.h);
  if (max < lo || max > hi) throw new Error(`${slug}: largest dimension ${max} m is outside the expected ${lo}-${hi} m (wrong unit scale?)`);
}

/** Poly Haven `dimensions` are millimetres; the sorted extents must match the model within 5%. */
export function assertApiDims(slug, dims, apiMm) {
  // Axis order differs between the API (Blender frame) and the glTF for some models, so compare sorted: this is a unit check.
  const want = apiMm.map((v) => v / 1000).sort((a, b) => a - b);
  const got = [dims.w, dims.d, dims.h].sort((a, b) => a - b);
  got.forEach((g, i) => {
    if (Math.abs(g - want[i]) > 0.05 * Math.max(want[i], 0.02)) throw new Error(`${slug}: measured ${got.join('x')} m (sorted) but the API says ${want.join('x')} m (sorted)`);
  });
}

/** Budget problems of one built entry, as strings (empty = fine). */
export function budgetProblems(e, budgets) {
  const out = [];
  if (e.bytes > budgets.modelBytes) out.push(`${e.id}: ${e.bytes} B exceeds ${budgets.modelBytes} B per model`);
  if (e.triangles > budgets.triangles) out.push(`${e.id}: ${e.triangles} triangles exceed ${budgets.triangles}`);
  if (e.materials !== undefined && e.materials > budgets.materials) out.push(`${e.id}: ${e.materials} materials exceed ${budgets.materials}`);
  return out;
}

/** Style-appropriate tag normalisation: lowercase, <= 32 chars, max 12, unique. */
export function cleanTags(tags) {
  return [...new Set(tags.map((t) => t.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim()).filter((t) => t && t.length <= 32))].slice(0, 12);
}
