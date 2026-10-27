/* global Buffer */
// Shared model normaliser (M5.4 library build and M5.5 local 3D-FUTURE pack).
// Brings any source glTF into the ITEM FRAME: metres, bottom at y=0, footprint centre at the origin, front = +z.
// Then welds, simplifies (triangle cap), dedupes, prunes, joins, re-encodes textures as WebP, quantises and
// applies Meshopt. Output is deterministic for a given input.
import { Document, Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, dequantize, flatten, getBounds, join, meshopt, prune, quantize, simplify, textureCompress, transformMesh, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

export const BUDGETS = { modelBytes: 300 * 1024, totalBytes: 6 * 1024 * 1024, triangles: 20_000, materials: 4 };

let ready;
export async function getIO() {
  ready ??= Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  await ready;
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

/** Rotation about +y (radians) that sends the source FRONT axis to +z. */
export const FRONT_ANGLE = { '+z': 0, '-z': Math.PI, '+x': -Math.PI / 2, '-x': Math.PI / 2 };

// column-major 4x4 helpers
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const rotY = (t) => { const c = Math.cos(t), s = Math.sin(t); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
const scaleM = (k) => [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1];
const transM = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

export function countTriangles(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      const idx = p.getIndices();
      n += idx ? idx.getCount() / 3 : (p.getAttribute('POSITION')?.getCount() ?? 0) / 3;
    }
  }
  return Math.round(n);
}

function bakeIntoMeshes(doc) {
  const root = doc.getRoot();
  const seen = new Set();
  const nodes = [];
  for (const scene of root.listScenes()) scene.traverse((n) => { if (n.getMesh()) nodes.push(n); });
  for (const node of nodes) {
    let mesh = node.getMesh();
    if (seen.has(mesh)) { mesh = mesh.clone(); node.setMesh(mesh); }
    seen.add(mesh);
  }
  const world = new Map(nodes.map((n) => [n, n.getWorldMatrix()]));
  return { nodes, world };
}

/**
 * Stage A: pivot/units/front, weld, simplify, dedupe, prune, join, WebP textures. Mutates `doc`.
 * @param opts { front, unitScale=1, texMax=1024, quality=80, maxTris=20000 }
 * @returns { dims:{w,d,h}, triangles, materials, sourceAnchor:[x,y,z], sourceTriangles }
 */
export async function normaliseStageA(doc, opts) {
  const { front = '+z', unitScale = 1, texMax = 1024, quality = 80, maxTris = BUDGETS.triangles } = opts;
  if (!(front in FRONT_ANGLE)) throw new Error(`bad front axis "${front}"`);
  doc.setLogger(new Logger(Logger.Verbosity.WARN));
  const root = doc.getRoot();
  for (const a of root.listAnimations()) a.dispose();
  for (const s of root.listSkins()) s.dispose();
  for (const c of root.listCameras()) c.dispose();
  await doc.transform(dequantize(), flatten());

  const sourceTriangles = countTriangles(doc);
  const { nodes, world } = bakeIntoMeshes(doc);
  const R = mul(rotY(FRONT_ANGLE[front]), scaleM(unitScale));
  for (const node of nodes) {
    const m = mul(R, world.get(node));
    transformMesh(node.getMesh(), m);
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
  }
  const scene = root.listScenes()[0];
  const b0 = getBounds(scene);
  const cx = (b0.min[0] + b0.max[0]) / 2, cz = (b0.min[2] + b0.max[2]) / 2, y0 = b0.min[1];
  for (const node of nodes) transformMesh(node.getMesh(), transM(-cx, -y0, -cz));
  const sourceAnchor = [cx / unitScale, y0 / unitScale, cz / unitScale]; // pivot in the (front-rotated) source frame, informational
  const b = getBounds(scene);
  const dims = { w: r3(b.max[0] - b.min[0]), d: r3(b.max[2] - b.min[2]), h: r3(b.max[1] - b.min[1]) };

  await doc.transform(weld(), dedup(), prune());
  for (const error of [0.02, 0.05, 0.1, 0.2]) {
    const tris = countTriangles(doc);
    if (tris <= maxTris) break;
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: (maxTris * 0.95) / tris, error }), prune());
  }
  if (countTriangles(doc) > maxTris) throw new Error(`cannot simplify below ${maxTris} triangles`);
  await doc.transform(
    join({ keepMeshes: false, keepNamed: false }),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [texMax, texMax], quality, effort: 80 }),
    dedup(),
    prune(),
  );
  return { dims, triangles: countTriangles(doc), materials: root.listMaterials().length, sourceAnchor: sourceAnchor.map(r3), sourceTriangles };
}

/** Stage B: quantise + Meshopt, serialise. */
export async function finishGlb(doc) {
  doc.setLogger(new Logger(Logger.Verbosity.ERROR));
  await doc.transform(quantize(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  const io = await getIO();
  return Buffer.from(await io.writeBinary(doc));
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/** Width (x), depth (z) and height (y) of a document's first scene, in metres. */
export function measureDims(doc) {
  const b = getBounds(doc.getRoot().listScenes()[0]);
  return { w: r3(b.max[0] - b.min[0]), d: r3(b.max[2] - b.min[2]), h: r3(b.max[1] - b.min[1]) };
}

/** Dims of a finished GLB (decoded again, so quantisation and Meshopt are included); `fallback` when it cannot be read. */
export async function measureGlb(glb, fallback) {
  try {
    return measureDims(await documentFromBuffer(glb));
  } catch {
    return fallback;
  }
}

/**
 * Full normalisation with a size ladder: lowers texture quality, then texture size, until the GLB fits `maxBytes`.
 * `load` returns a FRESH Document for each attempt. `onStageA(doc, info)` may render a thumbnail from the document.
 */
export async function normalise(load, opts) {
  const { maxBytes = BUDGETS.modelBytes, texMax = 1024 } = opts;
  const ladder = [];
  for (const size of [texMax, texMax / 2, texMax / 4].filter((s) => s >= 128)) for (const q of [80, 65, 50]) ladder.push({ size, q });
  let last;
  for (const step of ladder) {
    const doc = await load();
    const info = await normaliseStageA(doc, { ...opts, texMax: step.size, quality: step.q });
    if (opts.onStageA) await opts.onStageA(doc, info);
    const glb = await finishGlb(doc);
    // `nativeDims` is what the delivered file measures: stage A measured BEFORE simplification, quantisation and
    // Meshopt, which move vertices a little. Measure the GLB that is shipped.
    const dims = await measureGlb(glb, info.dims);
    last = { glb, ...info, dims, textureMax: step.size, textureQuality: step.q };
    if (glb.length <= maxBytes || doc.getRoot().listTextures().length === 0) return last;
  }
  return last; // over budget: the caller fails with the numbers
}

export async function documentFromFile(path) {
  return (await getIO()).read(path);
}
export async function documentFromBuffer(buf) {
  return (await getIO()).readBinary(new Uint8Array(buf));
}
export { Document };
