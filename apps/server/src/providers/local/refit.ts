import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MeshoptEncoder } from 'meshoptimizer';
import { meshopt } from '@gltf-transform/functions';
import type { Dims } from '@flat/scene';
import { chooseFit } from './fit';
import { bakeQuarterTurn, getIO, measureDocument, QUARTER_TURN_NODE, readGlb, undoQuarterTurn } from './normalise';
import { LocalCatalogFile, type LocalEntry } from './schema';

/**
 * Offline re-fit of an existing catalogue (`pnpm catalog:refit [--dry] [--sku X]`): recomputes, from the GLBs already on disk, the
 * orientation (quarter turn) and overall dims with the CURRENT fit rules (`fit.ts`) and rewrites only what changed. Nothing is downloaded.
 *
 * The original downloads are not kept, but the baked turn is a dedicated wrapper node (`quarter-turn`, a -90 degree rotation about +y,
 * no translation, no scale) around the scene content, so undoing it is exact and deterministic (the node is dissolved), and baking one is
 * the very same step the build uses. The model's native size is its measured size, with x and z swapped back when a turn is baked.
 */

export interface RefitChange {
  sku: string;
  name: string;
  typeName: string;
  category: string;
  turn: { from: boolean; to: boolean };
  dims: { from: Dims; to: Dims };
  /** Native (authored) model size, metres [x, y, z]. */
  native: [number, number, number];
}

export interface RefitReport {
  total: number;
  withModel: number;
  changes: RefitChange[];
  /** Entries left alone although the current rules disagree (they would reject the model) or whose file does not match the entry. */
  skipped: { sku: string; name: string; reason: string }[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const sameDims = (a: Dims, b: Dims) => Math.abs(a.w - b.w) < 0.0015 && Math.abs(a.d - b.d) < 0.0015 && Math.abs(a.h - b.h) < 0.0015;
const TURN_FLAG = /^quarter turn baked/;

export async function refitCatalog(dir: string, options: { dryRun?: boolean; sku?: string } = {}): Promise<RefitReport> {
  const path = join(dir, 'catalog.json');
  const file = LocalCatalogFile.parse(JSON.parse(await readFile(path, 'utf8')));
  const report: RefitReport = { total: file.entries.length, withModel: 0, changes: [], skipped: [] };
  const io = await getIO();
  await Promise.all([MeshoptEncoder.ready]);
  let touched = false;

  for (let i = 0; i < file.entries.length; i++) {
    const entry = file.entries[i]!;
    const rec = entry.record;
    if (!entry.has3d || !entry.model) continue;
    if (options.sku && rec.sku !== options.sku) continue;
    report.withModel++;
    const skip = (reason: string) => report.skipped.push({ sku: rec.sku, name: rec.name, reason });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(dir, entry.model.file)));
    } catch {
      skip('model file missing');
      continue;
    }
    const doc = await readGlb(bytes);
    const measured = measureDocument(doc).size;
    const wrapped = doc.getRoot().listScenes()[0]?.listChildren().some((n) => n.getName() === QUARTER_TURN_NODE) ?? false;
    if (wrapped !== entry.model.fit.quarterTurn) {
      skip(`entry says quarterTurn=${entry.model.fit.quarterTurn} but the file ${wrapped ? 'has' : 'has no'} ${QUARTER_TURN_NODE} node`);
      continue;
    }
    const native: [number, number, number] = wrapped ? [measured[2], measured[1], measured[0]] : [measured[0], measured[1], measured[2]];
    const fit = chooseFit(native, rec.dims, { category: rec.category, typeName: entry.typeName, name: rec.name });
    if (fit.verdict === 'reject') {
      skip(`the current rules would reject this model (${fit.reason ?? 'misfit'}); left as it is`);
      continue;
    }
    const nextDims = fit.dims ?? rec.dims;
    const turnChanged = fit.quarterTurn !== wrapped;
    const dimsChanged = !sameDims(nextDims, rec.dims);
    if (!turnChanged && !dimsChanged) continue;
    report.changes.push({ sku: rec.sku, name: rec.name, typeName: entry.typeName, category: rec.category, turn: { from: wrapped, to: fit.quarterTurn }, dims: { from: rec.dims, to: nextDims }, native });
    if (options.dryRun) continue;

    if (turnChanged) {
      if (wrapped) {
        if (!undoQuarterTurn(doc)) {
          report.changes.pop();
          skip('the quarter-turn node is not a plain rotation; not touched');
          continue;
        }
      } else bakeQuarterTurn(doc);
      await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
    }
    const out = turnChanged ? await io.writeBinary(doc) : bytes;
    const after = measureDocument(await readGlb(out));
    const finalFit = chooseFit(after.size, nextDims, { category: rec.category, typeName: entry.typeName, name: rec.name });
    if (finalFit.verdict === 'reject' || finalFit.quarterTurn) {
      report.changes.pop();
      skip(`the re-written model no longer fits (${Math.round(finalFit.distortion * 100)}% distortion); not touched`);
      continue;
    }
    if (turnChanged) {
      const tmp = join(dir, `${entry.model.file}.refit.tmp`);
      await writeFile(tmp, out);
      await rename(tmp, join(dir, entry.model.file));
    }
    const flags = entry.flags.filter((f) => !TURN_FLAG.test(f) && !/^dims_mismatch/.test(f) && !/^overall size taken/.test(f) && !/^width and depth swapped/.test(f) && !(fit.dimsFrom === 'model' && /^a dimension missing on the page/.test(f)));
    if (finalFit.quarterTurn || fit.quarterTurn) flags.unshift('quarter turn baked in (the model ran along the other axis than the listed width/depth)');
    if (fit.dims && fit.dimsFrom === 'swap') flags.push('width and depth swapped (the shop lists the length as the depth; the model keeps its authored front)');
    else if (fit.dims) flags.push(`overall size taken from the 3D model (${Math.round(fit.dims.w * 100)}x${Math.round(fit.dims.d * 100)}x${Math.round(fit.dims.h * 100)} cm w x d x h; the listed ${Math.round(rec.dims.w * 100)}x${Math.round(rec.dims.d * 100)}x${Math.round(rec.dims.h * 100)} cm describe the frame only)`);
    if (finalFit.verdict === 'warn') flags.push(`dims_mismatch ${Math.round(finalFit.distortion * 100)}%`);
    const next: LocalEntry = {
      ...entry,
      record: dimsChanged ? { ...rec, dims: nextDims, ...(fit.dimsFrom === 'model' ? { dimsSource: 'model' as const } : {}) } : rec,
      model: { ...entry.model, bytes: out.byteLength, sha256: createHash('sha256').update(out).digest('hex'), fit: { quarterTurn: fit.quarterTurn, distortion: r3(finalFit.distortion), size: after.size.map(r3) as [number, number, number] } },
      flags: flags.slice(0, 12),
    };
    file.entries[i] = next;
    touched = true;
  }

  if (touched) {
    const parsed = LocalCatalogFile.parse(file); // never write something the reader would refuse
    const backup = `${path}.pre-refit`;
    if (!(await stat(backup).then(() => true, () => false))) await copyFile(path, backup);
    const tmp = `${path}.refit.tmp`;
    await writeFile(tmp, JSON.stringify(parsed, null, 2) + '\n');
    await rename(tmp, path);
  }
  return report;
}
