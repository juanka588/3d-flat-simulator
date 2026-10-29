import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Mesh } from 'three';
import type { Material, Object3D, Texture } from 'three';
import dracoWasmUrl from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url';
import dracoWrapperUrl from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url';
import type { Loaded } from '@flat/assets';
import type { Box } from './model-math';

/**
 * GLB loading (M5.12). Everything heavy is imported lazily (GLTFLoader, the Meshopt decoder, DRACOLoader), so
 * a flat without models downloads none of it. The decoders are served by us, never by a CDN: Meshopt is
 * bundled as a lazy chunk, and the Draco wasm/wrapper are build assets whose (hashed, base-path aware) URLs
 * are handed to DRACOLoader explicitly (see the `flat:trim-draco-defaults` plugin in vite.config.ts), so they work under the Pages base path and offline.
 */

/** A loaded model reduced to what the viewer draws: one geometry per material (in model coordinates). */
export interface ModelTemplate {
  parts: { geometry: BufferGeometry; material: Material | Material[] }[];
  /** Native bounding box over all parts. */
  box: Box;
  triangles: number;
  dispose(): void;
  /** After a WebGL context restore: forces buffers and textures to upload again. */
  restore(): void;
}

type Loader = { parse: (data: ArrayBuffer, path: string, onLoad: (gltf: { scene: Object3D }) => void, onError?: (e: unknown) => void) => void };
let loaderPromise: Promise<Loader> | undefined;

async function gltfLoader(): Promise<Loader> {
  return (loaderPromise ??= (async () => {
    const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three/examples/jsm/loaders/DRACOLoader.js'),
      import('three/examples/jsm/libs/meshopt_decoder.module.js'),
    ]);
    const draco = new DRACOLoader();
    draco.setDecoderPath({ js: dracoWrapperUrl, wasm: dracoWasmUrl });
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    loader.setMeshoptDecoder(MeshoptDecoder);
    return loader as unknown as Loader;
  })());
}

/** Fetches a GLB and turns it into a template. Rejects on a network error, a non-2xx status or an invalid file. */
export async function loadGlb(url: string, init?: RequestInit): Promise<Loaded<ModelTemplate>> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseGlb(await res.arrayBuffer());
}

/** Decodes GLB bytes (no network); exported for tests. */
export async function parseGlb(data: ArrayBuffer): Promise<Loaded<ModelTemplate>> {
  const loader = await gltfLoader();
  const gltf = await new Promise<{ scene: Object3D }>((resolve, reject) => loader.parse(data, '', resolve, reject));
  const template = buildTemplate(gltf.scene);
  return { value: template, bytes: estimateBytes(template) };
}

const KEEP = ['position', 'normal', 'uv'] as const;

function asFloat(attr: BufferAttribute, itemSize: number): Float32BufferAttribute {
  const out = new Float32Array(attr.count * itemSize);
  for (let i = 0; i < attr.count; i++) {
    out[i * itemSize] = attr.getX(i);
    out[i * itemSize + 1] = attr.getY(i);
    if (itemSize > 2) out[i * itemSize + 2] = attr.getZ(i);
  }
  return new Float32BufferAttribute(out, itemSize);
}

/** A mesh's geometry in model space, with only position/normal/uv, all float, so geometries can be concatenated. */
function bake(mesh: Mesh): BufferGeometry {
  const src = mesh.geometry;
  const g = new BufferGeometry();
  for (const name of KEEP) {
    const a = src.getAttribute(name) as BufferAttribute | undefined;
    if (a) g.setAttribute(name, asFloat(a, name === 'uv' ? 2 : 3));
  }
  if (!g.getAttribute('uv')) g.setAttribute('uv', new Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  if (src.index) g.setIndex(Array.from(src.index.array));
  g.groups = src.groups.map((x) => ({ ...x }));
  g.applyMatrix4(mesh.matrixWorld);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

/** Concatenates baked geometries (all drawn with one material) into one. */
function concat(geometries: BufferGeometry[]): BufferGeometry {
  if (geometries.length === 1) return geometries[0]!;
  const out = new BufferGeometry();
  const vertexTotal = geometries.reduce((n, g) => n + g.getAttribute('position').count, 0);
  const indexTotal = geometries.reduce((n, g) => n + (g.index ? g.index.count : g.getAttribute('position').count), 0);
  const arrays = { position: new Float32Array(vertexTotal * 3), normal: new Float32Array(vertexTotal * 3), uv: new Float32Array(vertexTotal * 2) };
  const index = new Uint32Array(indexTotal);
  let v = 0;
  let i = 0;
  for (const g of geometries) {
    const count = g.getAttribute('position').count;
    arrays.position.set(g.getAttribute('position').array as Float32Array, v * 3);
    arrays.normal.set(g.getAttribute('normal').array as Float32Array, v * 3);
    arrays.uv.set(g.getAttribute('uv').array as Float32Array, v * 2);
    if (g.index) for (let k = 0; k < g.index.count; k++) index[i++] = g.index.getX(k) + v;
    else for (let k = 0; k < count; k++) index[i++] = v + k;
    v += count;
    g.dispose();
  }
  out.setAttribute('position', new BufferAttribute(arrays.position, 3));
  out.setAttribute('normal', new BufferAttribute(arrays.normal, 3));
  out.setAttribute('uv', new BufferAttribute(arrays.uv, 2));
  out.setIndex(new BufferAttribute(index, 1));
  return out;
}

function textures(material: Material): Texture[] {
  const out: Texture[] = [];
  for (const value of Object.values(material)) if (value && (value as Texture).isTexture) out.push(value as Texture);
  return out;
}

/**
 * Flattens a glTF scene to one part per material (node transforms baked in), so a model costs as many draw
 * calls as it has materials rather than as many as it has nodes. Multi-material meshes (geometry groups) keep
 * their own part.
 */
export function buildTemplate(root: Object3D): ModelTemplate {
  root.updateMatrixWorld(true);
  const byMaterial = new Map<Material, BufferGeometry[]>();
  const parts: ModelTemplate['parts'] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const geometry = bake(mesh);
    if (Array.isArray(mesh.material)) parts.push({ geometry, material: mesh.material });
    else byMaterial.set(mesh.material, [...(byMaterial.get(mesh.material) ?? []), geometry]);
  });
  for (const [material, geometries] of byMaterial) parts.push({ geometry: concat(geometries), material });
  if (parts.length === 0) throw new Error('the model has no meshes');
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const { geometry } of parts) {
    geometry.computeBoundingBox();
    const b = geometry.boundingBox!;
    min[0] = Math.min(min[0], b.min.x);
    min[1] = Math.min(min[1], b.min.y);
    min[2] = Math.min(min[2], b.min.z);
    max[0] = Math.max(max[0], b.max.x);
    max[1] = Math.max(max[1], b.max.y);
    max[2] = Math.max(max[2], b.max.z);
    triangles += (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) throw new Error('the model has no finite geometry');
  const materialsOf = () => parts.flatMap((p) => (Array.isArray(p.material) ? p.material : [p.material]));
  return {
    parts,
    box: { min, max },
    triangles,
    dispose() {
      for (const p of parts) p.geometry.dispose();
      for (const m of materialsOf()) {
        for (const t of textures(m)) t.dispose();
        m.dispose();
      }
    },
    restore() {
      for (const p of parts) {
        for (const a of Object.values(p.geometry.attributes)) (a as BufferAttribute).needsUpdate = true;
        if (p.geometry.index) p.geometry.index.needsUpdate = true;
      }
      for (const m of materialsOf()) {
        for (const t of textures(m)) t.needsUpdate = true;
        m.needsUpdate = true;
      }
    },
  };
}

/** Estimated GPU bytes: vertex and index buffers plus decoded textures (RGBA, with mipmaps). */
export function estimateBytes(t: Pick<ModelTemplate, 'parts'>): number {
  let bytes = 0;
  const seen = new Set<Texture>();
  for (const { geometry, material } of t.parts) {
    for (const a of Object.values(geometry.attributes)) bytes += (a as BufferAttribute).array.byteLength;
    if (geometry.index) bytes += geometry.index.array.byteLength;
    for (const m of Array.isArray(material) ? material : [material]) {
      for (const tex of textures(m)) {
        if (seen.has(tex)) continue;
        seen.add(tex);
        const image = tex.image as { width?: number; height?: number } | undefined;
        if (image?.width && image.height) bytes += Math.round(image.width * image.height * 4 * 1.34);
      }
    }
  }
  return bytes;
}
