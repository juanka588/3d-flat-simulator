/* global Buffer */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { checkGlbFiles, checkModelsDir, inspectGlb } from './check-models.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const glb = Buffer.from('glTF-pretend-model');
const thumb = Buffer.from('thumb');
const entry = (over = {}) => ({
  id: 'polyhaven:chair', file: 'chair.glb', thumb: 'thumbs/chair.webp', sha256: sha(glb), thumbSha256: sha(thumb), bytes: glb.length,
  licence: 'CC0-1.0', credit: '"Chair" by A, Poly Haven, CC0-1.0', triangles: 100, materials: 1,
  licenseEvidence: { basis: 'site-policy', needle: 'CC0', checkedAt: '2026-10-27T10:00:00.000Z', policyUrl: 'https://polyhaven.com/license' }, ...over,
});
function make(entries = [entry()], extra) {
  const dir = mkdtempSync(join(tmpdir(), 'models-'));
  mkdirSync(join(dir, 'thumbs'));
  writeFileSync(join(dir, 'chair.glb'), glb);
  writeFileSync(join(dir, 'thumbs/chair.webp'), thumb);
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(entries));
  extra?.(dir);
  return dir;
}
const credits = '| Chair (`polyhaven:chair`) |';

describe('models directory gate', () => {
  it('accepts a directory that matches its catalog', () => {
    expect(checkModelsDir(make(), { credits }).problems).toEqual([]);
  });
  it('flags stray, missing and altered files', () => {
    expect(checkModelsDir(make(undefined, (d) => writeFileSync(join(d, 'stray.glb'), 'x')), { credits }).problems).toEqual(['stray.glb: not listed in catalog.json']);
    expect(checkModelsDir(make(undefined, (d) => writeFileSync(join(d, 'chair.glb'), glb.toString() + '!')), { credits }).problems).toEqual(
      expect.arrayContaining(['chair.glb: sha256 differs from catalog.json']),
    );
    expect(checkModelsDir(make([entry({ file: 'gone.glb', sha256: 'a'.repeat(64) }), ]), { credits }).problems).toContain('gone.glb: listed in catalog.json but missing');
  });
  it('accepts generator thumbnails (small WebP files) without a catalog entry, and flags big or fake ones', () => {
    const webp = (n) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(n)]);
    const withParam = (name, body) => make(undefined, (d) => writeFileSync(join(d, 'thumbs', name), body));
    expect(checkModelsDir(withParam('param-bed.webp', webp(100)), { credits }).problems).toEqual([]);
    expect(checkModelsDir(withParam('param-bed.webp', webp(9000)), { credits }).problems).toEqual([expect.stringContaining('exceeds 8192 B per generator thumbnail')]);
    expect(checkModelsDir(withParam('param-bed.webp', Buffer.from('nope, not an image')), { credits }).problems).toEqual(['thumbs/param-bed.webp: not a WebP file']);
    expect(checkModelsDir(withParam('other.webp', webp(10)), { credits }).problems).toEqual(['thumbs/other.webp: not listed in catalog.json']);
  });
  it('enforces the budgets', () => {
    expect(checkModelsDir(make([entry({ triangles: 20_001 })]), { credits }).problems).toContain('polyhaven:chair: 20001 triangles exceed 20000');
    expect(checkModelsDir(make([entry({ materials: 5 })]), { credits }).problems).toContain('polyhaven:chair: 5 materials exceed 4');
    const tiny = { modelBytes: 5, totalBytes: 5, triangles: 20_000, materials: 4 };
    const p = checkModelsDir(make(), { credits, budgets: tiny }).problems;
    expect(p.some((x) => x.includes('per model'))).toBe(true);
    expect(p.some((x) => x.includes('models total'))).toBe(true);
  });
  it('requires licence evidence: how the licence was verified', () => {
    expect(checkModelsDir(make([entry({ licenseEvidence: undefined })]), { credits }).problems[0]).toMatch(/no licence evidence/);
    expect(checkModelsDir(make([entry({ licenseEvidence: { basis: 'site-policy' } })]), { credits }).problems[0]).toMatch(/no licence evidence/);
  });
  it('requires licence, credit and a credits-document row', () => {
    expect(checkModelsDir(make([entry({ licence: 'CC-BY-NC-4.0' })]), { credits }).problems[0]).toMatch(/not CC0-1.0 or CC-BY-4.0/);
    expect(checkModelsDir(make([entry({ credit: '' })]), { credits }).problems).toContain('polyhaven:chair: no credit line');
    expect(checkModelsDir(make([entry({ licence: 'CC-BY-4.0', credit: 'Chair, Sketchfab' })]), { credits }).problems[0]).toMatch(/needs an author/);
    expect(checkModelsDir(make(), { credits: 'nothing' }).problems[0]).toMatch(/missing from docs\/MODELS-CREDITS.md/);
  });
});

// ---- the GLBs themselves: a real (tiny) file is parsed, the catalog is not trusted ----

/** A box w x d x h with its bottom at y0 and its footprint centre at (cx, cz); optionally a texture and Meshopt. */
async function makeGlb({ w = 1, d = 0.5, h = 0.8, y0 = 0, cx = 0, cz = 0, meshopt = true, texture } = {}) {
  await MeshoptEncoder.ready;
  const doc = new Document();
  const buffer = doc.createBuffer();
  const [x0, x1, z0, z1, y1] = [cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, y0 + h];
  const pos = [x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  const material = doc.createMaterial('m');
  if (texture) material.setBaseColorTexture(doc.createTexture('t').setImage(texture).setMimeType('image/png'));
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buffer))
    .setMaterial(material);
  const mesh = doc.createMesh('box').addPrimitive(prim);
  doc.createScene('s').addChild(doc.createNode('n').setMesh(mesh));
  if (meshopt) {
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  }
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  return Buffer.from(await io.writeBinary(doc));
}

async function modelDir(glbBytes, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'glb-'));
  writeFileSync(join(dir, 'box.glb'), glbBytes);
  const dims = over.nativeDims ?? { w: 1, d: 0.5, h: 0.8 };
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify([{ id: 'test:box', file: 'box.glb', licence: 'CC0-1.0', triangles: 12, materials: 1, nativeDims: dims, front: '+z', ...over }]));
  return dir;
}

describe('GLB inspection', () => {
  it('measures a real GLB: triangles, materials, size, frame and Meshopt', async () => {
    const info = await inspectGlb(await makeGlb());
    expect(info).toMatchObject({ triangles: 12, materials: 1, meshopt: true, hasMesh: true, textures: [] });
    expect(info.max[1] - info.min[1]).toBeCloseTo(0.8, 2);
  });
  it('accepts a well-formed model', async () => {
    expect(await checkGlbFiles(await modelDir(await makeGlb()))).toEqual([]);
  });
  it('flags a model that is not Meshopt-compressed', async () => {
    expect(await checkGlbFiles(await modelDir(await makeGlb({ meshopt: false })))).toEqual(['box.glb: is not Meshopt-compressed (EXT_meshopt_compression missing)']);
  });
  it('flags a bottom off the floor and an off-centre footprint (more than 2 cm)', async () => {
    const lifted = await checkGlbFiles(await modelDir(await makeGlb({ y0: 0.1 }), { nativeDims: { w: 1, d: 0.5, h: 0.8 } }));
    expect(lifted.join('\n')).toMatch(/bottom is at y = 0\.1\d\d m, not 0/);
    const shifted = await checkGlbFiles(await modelDir(await makeGlb({ cx: 0.3 })));
    expect(shifted.join('\n')).toMatch(/footprint centre/);
    expect(await checkGlbFiles(await modelDir(await makeGlb({ y0: 0.01, cx: 0.015 })))).toEqual([]);
  });
  it('flags textures over 1024 px, too many triangles / materials and a catalog that lies about its size', async () => {
    const big = await sharp({ create: { width: 2048, height: 16, channels: 3, background: '#888' } }).png().toBuffer();
    expect((await checkGlbFiles(await modelDir(await makeGlb({ texture: big })))).join('\n')).toMatch(/2048x16 texture exceeds 1024 px/);
    const dir = await modelDir(await makeGlb());
    expect((await checkGlbFiles(dir, { budgets: { modelBytes: 1, totalBytes: 1, triangles: 10, materials: 0, textureSize: 1024 } })).join('\n')).toMatch(/12 triangles \(measured\) exceed 10[\s\S]*1 materials \(measured\) exceed 0/);
    const liar = await checkGlbFiles(await modelDir(await makeGlb(), { nativeDims: { w: 2, d: 0.5, h: 0.8 }, triangles: 99 }));
    expect(liar.join('\n')).toMatch(/catalog says 99 triangles, the file has 12/);
    expect(liar.join('\n')).toMatch(/measures 1\.000 x 0\.500 x 0\.800 m but the catalog says 2 x 0\.5 x 0\.8 m/);
  });
  it('reports a file that is not a GLB', async () => {
    expect((await checkGlbFiles(await modelDir(Buffer.from('glTF-pretend-model')))).join('\n')).toMatch(/cannot be parsed as GLB/);
  });
});
