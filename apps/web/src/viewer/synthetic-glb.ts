/**
 * Hand-built GLB files for tests (unit tests parse them, e2e serves them through `page.route`): boxes in a
 * model's own coordinates, one glTF node and mesh per box, boxes of the same colour sharing a material.
 * No dependencies, so it runs in node and in Playwright's runner alike.
 */

export interface SyntheticBox {
  min: [number, number, number];
  max: [number, number, number];
  /** Linear RGB 0..1; boxes of equal colour share one material. */
  color?: [number, number, number];
}

const CUBE_INDICES = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];

export function buildGlb(boxes: readonly SyntheticBox[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const bufferViews: unknown[] = [];
  const accessors: unknown[] = [];
  const materials: unknown[] = [];
  const materialOf = new Map<string, number>();
  const meshes: unknown[] = [];
  const nodes: unknown[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array, target: number): number => {
    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
    padded.set(bytes);
    chunks.push(padded);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    offset += padded.length;
    return bufferViews.length - 1;
  };
  for (const box of boxes) {
    const [x0, y0, z0] = box.min;
    const [x1, y1, z1] = box.max;
    const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
    const pv = push(new Uint8Array(positions.buffer), 34962);
    accessors.push({ bufferView: pv, componentType: 5126, count: 8, type: 'VEC3', min: box.min, max: box.max });
    const pos = accessors.length - 1;
    const iv = push(new Uint8Array(new Uint16Array(CUBE_INDICES).buffer), 34963);
    accessors.push({ bufferView: iv, componentType: 5123, count: CUBE_INDICES.length, type: 'SCALAR' });
    const idx = accessors.length - 1;
    const color = box.color ?? [0.8, 0.8, 0.8];
    const colorKey = color.join(',');
    if (!materialOf.has(colorKey)) {
      materialOf.set(colorKey, materials.length);
      materials.push({ pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: true });
    }
    meshes.push({ primitives: [{ attributes: { POSITION: pos }, indices: idx, material: materialOf.get(colorKey) }] });
    nodes.push({ mesh: meshes.length - 1 });
  }
  const json = JSON.stringify({
    asset: { version: '2.0', generator: 'flat synthetic-glb' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  });
  const jsonBytes = new TextEncoder().encode(json);
  const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4).fill(0x20);
  jsonPadded.set(jsonBytes);
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.length;
  }
  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonPadded, 20);
  const binAt = 20 + jsonPadded.length;
  view.setUint32(binAt, bin.length, true);
  view.setUint32(binAt + 4, 0x004e4942, true); // 'BIN\0'
  out.set(bin, binAt + 8);
  return out;
}

/** A sofa-like model: seat block, back rest (at -z) and two armrests, in two materials, native size 2.0 x 0.9 x 0.9 (x, y, z). */
export function sofaGlb(): Uint8Array {
  const fabric: [number, number, number] = [0.2, 0.35, 0.6];
  const legs: [number, number, number] = [0.1, 0.1, 0.1];
  return buildGlb([
    { min: [-1, 0.2, -0.45], max: [1, 0.45, 0.45], color: fabric },
    { min: [-1, 0.45, -0.45], max: [1, 0.9, -0.25], color: fabric },
    { min: [-1, 0.45, -0.25], max: [-0.8, 0.65, 0.45], color: fabric },
    { min: [0.8, 0.45, -0.25], max: [1, 0.65, 0.45], color: fabric },
    { min: [-0.9, 0, -0.4], max: [-0.8, 0.2, -0.3], color: legs },
    { min: [0.8, 0, 0.3], max: [0.9, 0.2, 0.4], color: legs },
  ]);
}
