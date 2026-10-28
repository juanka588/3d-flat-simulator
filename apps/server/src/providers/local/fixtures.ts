import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Document } from '@gltf-transform/core';
import { draco } from '@gltf-transform/functions';
import { ProductRecord } from '@flat/assets';
import sharp from 'sharp';
import { getIO } from './normalise';
import { LocalEntry, emptyCatalog, type LocalCatalogFile } from './schema';

/** Test support for the local catalogue: synthetic GLBs, entries and a catalogue folder written to disk. No network, no real files. */

export interface GlbSpec {
  /** Bounding box [x, y, z] in metres (a box mesh). */
  size: [number, number, number];
  /** Square texture side in px (0 = no texture). */
  textureSide?: number;
  textures?: number;
  /** Draco-compress the geometry, like the shop's `glb_draco` files. */
  draco?: boolean;
  /** Put the box on its side (x/y swapped by a node rotation). */
  asNodeRotation?: boolean;
}

export async function makeGlb(spec: GlbSpec): Promise<Uint8Array<ArrayBuffer>> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const [sx, sy, sz] = spec.size;
  const v: number[] = [];
  const n: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  // 6 faces x 4 vertices so normals are flat
  const faces: [number[], number[]][] = [
    [[0, 0, 1], [-1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]],
    [[0, 0, -1], [1, -1, -1, -1, -1, -1, -1, 1, -1, 1, 1, -1]],
    [[1, 0, 0], [1, -1, 1, 1, -1, -1, 1, 1, -1, 1, 1, 1]],
    [[-1, 0, 0], [-1, -1, -1, -1, -1, 1, -1, 1, 1, -1, 1, -1]],
    [[0, 1, 0], [-1, 1, 1, 1, 1, 1, 1, 1, -1, -1, 1, -1]],
    [[0, -1, 0], [-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1]],
  ];
  faces.forEach(([normal, corners], f) => {
    for (let i = 0; i < 4; i++) {
      v.push((corners[i * 3]! * sx) / 2 + 0, (corners[i * 3 + 1]! * sy) / 2 + sy / 2, (corners[i * 3 + 2]! * sz) / 2);
      n.push(...normal);
      uv.push(i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0);
    }
    idx.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  const acc = (type: 'VEC3' | 'VEC2', data: number[]) => doc.createAccessor().setType(type).setArray(new Float32Array(data)).setBuffer(buffer);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', acc('VEC3', v))
    .setAttribute('NORMAL', acc('VEC3', n))
    .setAttribute('TEXCOORD_0', acc('VEC2', uv))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buffer));
  const material = doc.createMaterial('m');
  const count = spec.textureSide ? (spec.textures ?? 1) : 0;
  for (let i = 0; i < count; i++) {
    const side = spec.textureSide!;
    const png = await sharp({ create: { width: side, height: side, channels: 3, background: { r: 40 + i * 30, g: 90, b: 160 } } }).png().toBuffer();
    const tex = doc.createTexture(`t${i}`).setImage(new Uint8Array(png)).setMimeType('image/png');
    if (i === 0) material.setBaseColorTexture(tex);
    else if (i === 1) material.setNormalTexture(tex);
    else material.setOcclusionTexture(tex);
  }
  prim.setMaterial(material);
  const mesh = doc.createMesh('box').addPrimitive(prim);
  const node = doc.createNode('box').setMesh(mesh);
  doc.createScene('s').addChild(node);
  if (spec.draco) await doc.transform(draco({ method: 'edgebreaker' }));
  return new Uint8Array(await (await getIO()).writeBinary(doc));
}

let counter = 0;
export function recordFor(over: Record<string, unknown> & { sku: string }): ProductRecord {
  return ProductRecord.parse({
    provider: 'ikea-fr',
    name: 'FIXTURE Produit',
    url: `https://www.ikea.com/fr/fr/p/fixture-${over.sku}/`,
    price: 100 + counter++,
    currency: 'EUR',
    priceTtc: true,
    dims: { w: 1, d: 0.5, h: 0.5 },
    dimsSource: 'structured',
    category: 'table',
    mount: 'floor',
    styleTags: [],
    colours: [],
    variants: [],
    fetchedAt: '2026-10-27T10:00:00.000Z',
    personalUseOnly: true,
    ...over,
  });
}

export interface EntrySpec extends Record<string, unknown> {
  sku: string;
  typeName?: string;
  queries?: string[];
  has3d?: boolean;
  noModelReason?: string;
  availability?: LocalEntry['availability'];
  checkedAt?: string;
}

export function entryFor(spec: EntrySpec): LocalEntry {
  const { typeName, queries, has3d, noModelReason, availability, checkedAt, ...rec } = spec;
  const sku = spec.sku;
  return LocalEntry.parse({
    record: recordFor({ ...rec, ...(has3d ? { modelRef: `1.2/${sku}/x/glb_draco/${sku}.glb` } : {}) }),
    typeName: typeName ?? '',
    queries: queries ?? [],
    has3d: has3d ?? false,
    ...(noModelReason ? { noModelReason } : {}),
    ...(has3d ? { model: { file: `models/${sku}.glb`, bytes: 1, sha256: 'a'.repeat(64), triangles: 12, fit: { quarterTurn: false, distortion: 0, size: [1, 0.5, 0.5] }, decodedBytesBefore: 1, decodedBytesAfter: 1, bytesBefore: 1 } } : {}),
    availability: availability ?? 'in_stock',
    checkedAt: checkedAt ?? '2026-10-27T10:00:00.000Z',
  });
}

/** Writes `catalog.json` and the model / photo files of a fixture catalogue; returns the folder. `models` maps sku -> GLB bytes (a has3d entry without one gets a placeholder). */
export async function writeCatalog(
  dir: string,
  entries: LocalEntry[],
  files: { models?: Record<string, Uint8Array>; photos?: Record<string, Uint8Array> } = {},
  builtAt = '2026-10-27T12:00:00.000Z',
): Promise<string> {
  const placed = entries.map((e) => {
    const bytes = files.models?.[e.record.sku];
    const photo = files.photos?.[e.record.sku];
    return {
      ...e,
      ...(e.has3d && bytes && e.model ? { model: { ...e.model, bytes: bytes.byteLength } } : {}),
      ...(photo ? { photo: { file: `photos/${e.record.sku}.webp`, bytes: photo.byteLength } } : {}),
    } satisfies LocalEntry;
  });
  const file: LocalCatalogFile = { ...emptyCatalog(builtAt), entries: placed };
  const put = async (rel: string, data: string | Uint8Array) => {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), data);
  };
  for (const [sku, b] of Object.entries(files.models ?? {})) await put(`models/${sku}.glb`, b);
  for (const [sku, b] of Object.entries(files.photos ?? {})) await put(`photos/${sku}.webp`, b);
  await put('catalog.json', JSON.stringify(file));
  return dir;
}

/** A tiny real WebP, for photo fixtures. */
export async function tinyWebp(): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 200, b: 200 } } }).webp().toBuffer());
}
