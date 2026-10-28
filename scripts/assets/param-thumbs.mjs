/* global console, process, Buffer */
// Writes a Library thumbnail for every parametric generator at its default params:
//   pnpm assets:thumbs [outDir]        (default apps/web/public/models/thumbs)
// -> <outDir>/param-<generator>.webp, 128 x 128, transparent, at most 8 KB each. Same tiny software renderer as
// `pnpm assets:sheet` (orthographic 3/4 view, painter's algorithm, flat shading over SVG, no browser or GPU), run
// through `tsx` because the generators are TypeScript. Deterministic: re-running changes no byte unless a generator did.
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_GENERATORS, ITEM_MATERIAL_SPECS } from '../../packages/assets/src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = resolve(process.argv[2] ?? join(root, 'apps/web/public/models/thumbs'));
export const MAX_BYTES = 8 * 1024;
const SIZE = 128;
const S = SIZE * 3; // rendered at 3x and downsampled for smooth edges

const yaw = (35 * Math.PI) / 180;
const pitch = (28 * Math.PI) / 180;
const toCam = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const right = norm(cross([0, 1, 0], toCam));
const up = cross(toCam, right);
const light = norm([-0.4, 0.8, 0.5]);

function shade(hex, k) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${v.map((x) => Math.round(Math.min(255, x * k))).join(',')})`;
}

export function svgOf(gen) {
  const params = gen.params.parse({});
  const mesh = gen.generate(params);
  const n = mesh.positions.length / 3;
  const pts = Array.from({ length: n }, (_, i) => {
    const p = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
    return { x: dot(p, right), y: -dot(p, up), z: dot(p, toCam) };
  });
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const scale = Math.min((S * 0.88) / (maxX - minX || 1), (S * 0.88) / (maxY - minY || 1));
  const offX = (S - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = (S - (maxY - minY) * scale) / 2 - minY * scale;
  const tris = [];
  for (const g of mesh.groups) {
    const color = ITEM_MATERIAL_SPECS[g.materialId]?.color;
    if (!color) throw new Error(`${gen.id}: unknown item material "${g.materialId}"`);
    for (let k = g.start; k < g.start + g.count; k += 3) {
      const ids = [mesh.indices[k], mesh.indices[k + 1], mesh.indices[k + 2]];
      const nv = [mesh.normals[ids[0] * 3], mesh.normals[ids[0] * 3 + 1], mesh.normals[ids[0] * 3 + 2]];
      if (dot(nv, toCam) <= 1e-6) continue; // back face
      const ps = ids.map((i) => pts[i]);
      tris.push({ ps, depth: (ps[0].z + ps[1].z + ps[2].z) / 3, fill: shade(color, 0.55 + 0.45 * Math.max(0, dot(nv, light))) });
    }
  }
  tris.sort((a, b) => a.depth - b.depth);
  const polys = tris.map((t) => `<polygon points="${t.ps.map((p) => `${(offX + p.x * scale).toFixed(1)},${(offY + p.y * scale).toFixed(1)}`).join(' ')}" fill="${t.fill}" stroke="${t.fill}" stroke-width="0.6"/>`);
  return `<svg width="${S}" height="${S}" xmlns="http://www.w3.org/2000/svg">${polys.join('')}</svg>`;
}

/** The WebP bytes of one generator's thumbnail, lowering the quality until it fits `MAX_BYTES`. */
export async function thumbOf(gen) {
  const raw = await sharp(Buffer.from(svgOf(gen))).resize(SIZE, SIZE, { kernel: 'lanczos3' }).png().toBuffer();
  for (let quality = 82; quality >= 30; quality -= 8) {
    const buf = await sharp(raw).webp({ quality, effort: 6, alphaQuality: 80 }).toBuffer();
    if (buf.length <= MAX_BYTES) return buf;
  }
  throw new Error(`${gen.id}: thumbnail does not fit ${MAX_BYTES} B`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(outDir, { recursive: true });
  for (const gen of ALL_GENERATORS) {
    const buf = await thumbOf(gen);
    writeFileSync(join(outDir, `param-${gen.id}.webp`), buf);
    console.log(`param-${gen.id}.webp  ${buf.length} B`);
  }
}
