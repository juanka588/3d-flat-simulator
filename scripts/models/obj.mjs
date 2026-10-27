// Minimal Wavefront OBJ + MTL -> glTF Document (positions, normals, uv, per-material primitives, map_Kd texture).
// Used by the 3D-FUTURE local pack (M5.5). Faces are fan-triangulated. Assumes Y-up, metres (`unitScale` handles others).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { Document } from '@gltf-transform/core';

export function parseMtl(text) {
  const mats = {};
  let cur;
  for (const raw of text.split(/\r?\n/)) {
    const [k, ...rest] = raw.trim().split(/\s+/);
    if (k === 'newmtl') mats[(cur = rest.join(' '))] = {};
    else if (cur && k === 'Kd') mats[cur].kd = rest.slice(0, 3).map(Number);
    else if (cur && k === 'map_Kd') mats[cur].map = rest[rest.length - 1];
  }
  return mats;
}

export function parseObj(text) {
  const v = [], vt = [], vn = [];
  const groups = new Map(); // material -> face list of [[vi,ti,ni] x3]
  let mtllib, cur = '';
  const idx = (s, n) => (s === undefined || s === '' ? -1 : (Number(s) < 0 ? n + Number(s) : Number(s) - 1));
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const [k, ...a] = line.split(/\s+/);
    if (k === 'v') v.push(a.slice(0, 3).map(Number));
    else if (k === 'vt') vt.push(a.slice(0, 2).map(Number));
    else if (k === 'vn') vn.push(a.slice(0, 3).map(Number));
    else if (k === 'mtllib') mtllib = a.join(' ');
    else if (k === 'usemtl') cur = a.join(' ');
    else if (k === 'f') {
      const corners = a.map((c) => { const [x, y, z] = c.split('/'); return [idx(x, v.length), idx(y, vt.length), idx(z, vn.length)]; });
      if (!groups.has(cur)) groups.set(cur, []);
      for (let i = 1; i + 1 < corners.length; i++) groups.get(cur).push([corners[0], corners[i], corners[i + 1]]);
    }
  }
  return { v, vt, vn, groups, mtllib };
}

/** Builds a Document from an OBJ file on disk. `texture` overrides the texture lookup (3D-FUTURE: texture.png next to the OBJ). */
export function documentFromObj(objPath, { texture } = {}) {
  const dir = dirname(objPath);
  const { v, vt, vn, groups, mtllib } = parseObj(readFileSync(objPath, 'utf8'));
  if (!v.length || !groups.size) throw new Error(`${objPath}: no geometry`);
  const mtl = mtllib && existsSync(join(dir, mtllib)) ? parseMtl(readFileSync(join(dir, mtllib), 'utf8')) : {};
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh('model');
  const textures = new Map();
  const getTexture = (file) => {
    const p = join(dir, file);
    if (!existsSync(p)) return null;
    if (!textures.has(p)) {
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[extname(p).toLowerCase()];
      if (!mime) return null;
      textures.set(p, doc.createTexture(file).setImage(new Uint8Array(readFileSync(p))).setMimeType(mime));
    }
    return textures.get(p);
  };
  for (const [name, faces] of groups) {
    const m = mtl[name] ?? {};
    const material = doc.createMaterial(name || 'default').setBaseColorFactor([...(m.kd ?? [0.8, 0.8, 0.8]), 1]).setRoughnessFactor(0.8).setMetallicFactor(0);
    const tex = getTexture(m.map ?? texture ?? 'texture.png');
    if (tex) material.setBaseColorTexture(tex).setBaseColorFactor([1, 1, 1, 1]);
    const key = new Map();
    const pos = [], nor = [], uv = [], ind = [];
    for (const f of faces) {
      const p0 = v[f[0][0]], p1 = v[f[1][0]], p2 = v[f[2][0]];
      const fn = norm3(cross3(sub3(p1, p0), sub3(p2, p0)));
      for (const [vi, ti, ni] of f) {
        const k = `${vi}/${ti}/${ni}`;
        let i = key.get(k);
        if (i === undefined) {
          i = pos.length / 3;
          key.set(k, i);
          pos.push(...v[vi]);
          const n = ni >= 0 && vn[ni] ? vn[ni] : fn;
          nor.push(...n);
          uv.push(...(ti >= 0 && vt[ti] ? [vt[ti][0], 1 - vt[ti][1]] : [0, 0]));
        }
        ind.push(i);
      }
    }
    const prim = doc.createPrimitive()
      .setMaterial(material)
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(ind)).setBuffer(buffer))
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nor)).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)).setBuffer(buffer));
    mesh.addPrimitive(prim);
  }
  doc.createScene('scene').addChild(doc.createNode('model').setMesh(mesh));
  return doc;
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
