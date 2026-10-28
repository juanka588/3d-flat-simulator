import { createHash } from 'node:crypto';
import { Document, ImageUtils, Logger, NodeIO, type Transform } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, getBounds, meshopt, prune, quantize, textureCompress } from '@gltf-transform/functions';
import draco3d from 'draco3d';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { chooseFit, type Dims, type FitChoice } from './fit';

/**
 * Build-time normaliser of one downloaded GLB (BUILD SCRIPT ONLY; the server never runs it):
 *  1. parse it with glTF-Transform (Draco and Meshopt inputs are decoded), refuse anything unreadable or empty;
 *  2. measure the bounding box and compare it with the listed dimensions (the viewer's own rules, `fit.ts`);
 *  3. bake the quarter turn when the shop's width and depth are the other way round than the model's;
 *  4. dedupe, prune, resize textures to <= 1024 px (WebP), quantise and Meshopt-compress;
 *  5. read the result back (decoded again) and measure it: the browser-memory estimate before and after.
 */

export const TEXTURE_MAX = 1024;
/** More triangles than this is a scene, not a product. */
export const MAX_TRIANGLES = 300_000;
const MIP_FACTOR = 4 / 3;

let io: Promise<NodeIO> | undefined;
/** A NodeIO that reads Draco (IKEA ships `glb_draco`), Meshopt and every standard extension, and writes Meshopt. */
export function getIO(): Promise<NodeIO> {
  io ??= (async () => {
    await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
    const [decoder, encoder] = await Promise.all([draco3d.createDecoderModule(), draco3d.createEncoderModule()]);
    const nodeIo = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
      'draco3d.decoder': decoder,
      'draco3d.encoder': encoder,
    });
    nodeIo.setLogger(new Logger(Logger.Verbosity.ERROR));
    return nodeIo;
  })();
  return io;
}

export class GlbError extends Error {}

export interface GlbMeasure {
  triangles: number;
  /** Bounding box size [x, y, z] in metres (world space of the first scene). */
  size: [number, number, number];
  min: [number, number, number];
  textures: number;
  maxTextureSide: number;
  /** Estimated decoded size in the browser: RGBA textures with mipmaps + vertex and index buffers as three.js holds them. */
  decodedBytes: number;
  textureBytes: number;
  geometryBytes: number;
}

export async function readGlb(bytes: Uint8Array): Promise<Document> {
  if (bytes.byteLength < 12 || bytes[0] !== 0x67 || bytes[1] !== 0x6c || bytes[2] !== 0x54 || bytes[3] !== 0x46) throw new GlbError('not a binary glTF (GLB)');
  try {
    return await (await getIO()).readBinary(bytes);
  } catch (e) {
    throw new GlbError(`cannot be parsed as glTF: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function measureDocument(doc: Document): GlbMeasure {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new GlbError('has no scene');
  let triangles = 0;
  const accessors = new Set<import('@gltf-transform/core').Accessor>();
  let primitives = 0;
  for (const mesh of root.listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      primitives++;
      const pos = p.getAttribute('POSITION');
      if (!pos || pos.getCount() === 0) continue;
      const idx = p.getIndices();
      triangles += idx ? idx.getCount() / 3 : pos.getCount() / 3;
      for (const sem of p.listSemantics()) accessors.add(p.getAttribute(sem)!);
      if (idx) accessors.add(idx);
    }
  }
  if (primitives === 0 || triangles === 0) throw new GlbError('has no geometry');
  const b = getBounds(scene);
  const size: [number, number, number] = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  if (![...size, ...b.min, ...b.max].every(Number.isFinite)) throw new GlbError('has a non-finite bounding box');
  if (size.some((v) => v < 0) || size[0] + size[1] + size[2] < 1e-6) throw new GlbError('has an empty bounding box');
  let geometryBytes = 0;
  for (const a of accessors) geometryBytes += a.getArray()?.byteLength ?? 0;
  let textureBytes = 0;
  let maxSide = 0;
  for (const t of root.listTextures()) {
    const img = t.getImage();
    const mime = t.getMimeType();
    if (!img || !mime) continue;
    const dims = ImageUtils.getSize(img, mime);
    if (!dims) continue;
    maxSide = Math.max(maxSide, dims[0], dims[1]);
    textureBytes += Math.round(dims[0] * dims[1] * 4 * MIP_FACTOR);
  }
  return {
    triangles: Math.round(triangles),
    size,
    min: [b.min[0], b.min[1], b.min[2]],
    textures: root.listTextures().length,
    maxTextureSide: maxSide,
    decodedBytes: textureBytes + geometryBytes,
    textureBytes,
    geometryBytes,
  };
}

/** Wraps the scene content in a node turned a quarter about +y: what the viewer does at run time for `front: '+x'`. */
function bakeQuarterTurn(doc: Document): void {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]!;
  const wrapper = doc.createNode('quarter-turn').setRotation([0, -Math.SQRT1_2, 0, Math.SQRT1_2]); // -90 degrees about y
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    wrapper.addChild(child);
  }
  scene.addChild(wrapper);
}

export type NormaliseResult =
  | {
      ok: true;
      bytes: Uint8Array;
      sha256: string;
      fit: FitChoice;
      before: GlbMeasure;
      after: GlbMeasure;
      bytesBefore: number;
      flags: string[];
    }
  | { ok: false; reason: string; before?: GlbMeasure; fit?: FitChoice };

export interface NormaliseOptions {
  textureMax?: number;
  /** Skip the texture / Meshopt work (fit checks only; the file is re-written as read). */
  optimize?: boolean;
}

/** Validates, fits and shrinks a downloaded GLB. Never throws for a bad model: returns `{ ok: false, reason }`. */
export async function normaliseGlb(input: Uint8Array, dims: Dims, opts: NormaliseOptions = {}): Promise<NormaliseResult> {
  const textureMax = opts.textureMax ?? TEXTURE_MAX;
  let doc: Document;
  let before: GlbMeasure;
  try {
    doc = await readGlb(input);
    before = measureDocument(doc);
  } catch (e) {
    return { ok: false, reason: e instanceof GlbError ? `model ${e.message}` : `model unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (before.triangles > MAX_TRIANGLES) return { ok: false, reason: `model has ${before.triangles} triangles (limit ${MAX_TRIANGLES})`, before };
  const fit = chooseFit(before.size, dims);
  if (fit.verdict === 'reject') return { ok: false, reason: fit.reason ?? 'model does not fit the listed size', before, fit };

  const flags: string[] = [];
  try {
    const root = doc.getRoot();
    for (const a of root.listAnimations()) a.dispose();
    for (const s of root.listSkins()) s.dispose();
    for (const c of root.listCameras()) c.dispose();
    if (fit.quarterTurn) {
      bakeQuarterTurn(doc);
      flags.push('quarter turn baked in (the model ran along the other axis than the listed width/depth)');
    }
    if (fit.verdict === 'warn') flags.push(`dims_mismatch ${Math.round(fit.distortion * 100)}%`);
    if (opts.optimize !== false) {
      if (before.maxTextureSide > textureMax) flags.push(`textures resized ${before.maxTextureSide} -> ${textureMax} px`);
      const steps: Transform[] = [dedup(), prune()];
      if (root.listTextures().length > 0) steps.push(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [textureMax, textureMax], quality: 80 }));
      steps.push(prune(), quantize(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
      await doc.transform(...steps);
    }
    const out = await (await getIO()).writeBinary(doc);
    // Read the shipped bytes back: the numbers describe the file as the browser will decode it, and a file that cannot be re-read is dropped here.
    const after = measureDocument(await readGlb(out));
    const finalFit = chooseFit(after.size, dims);
    if (finalFit.verdict === 'reject' || finalFit.quarterTurn) return { ok: false, reason: `normalised model no longer fits the listed size (${Math.round(finalFit.distortion * 100)}% distortion)`, before, fit: finalFit };
    return {
      ok: true,
      bytes: out,
      sha256: createHash('sha256').update(out).digest('hex'),
      fit: { ...fit, distortion: finalFit.distortion, size: finalFit.size },
      before,
      after,
      bytesBefore: input.byteLength,
      flags,
    };
  } catch (e) {
    return { ok: false, reason: `normalisation failed: ${e instanceof Error ? e.message : String(e)}`, before, fit };
  }
}
