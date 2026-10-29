/* global console, process, Buffer */
// Writes a Library thumbnail for every parametric generator at its default params:
//   pnpm assets:thumbs [outDir]        (default apps/web/public/models/thumbs)
//   pnpm assets:thumbs --variants [outDir]   (CG4: the descriptor-driven variants, default .tmp/param-variants):
//        <outDir>/<generator>-<n>.webp and a labelled contact sheet variants-sheet.png; nothing under apps/web is touched
// -> <outDir>/param-<generator>.webp, 128 x 128, transparent, at most 8 KB each. Same tiny software renderer as
// `pnpm assets:sheet` (orthographic 3/4 view, painter's algorithm, flat shading over SVG, no browser or GPU), run
// through `tsx` because the generators are TypeScript. Deterministic: re-running changes no byte unless a generator did.
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_GENERATORS, ITEM_MATERIAL_SPECS } from '../../packages/assets/src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VARIANT_MODE = process.argv.includes('--variants');
const argDir = process.argv.slice(2).find((a) => !a.startsWith('--'));
const outDir = resolve(argDir ?? join(root, VARIANT_MODE ? '.tmp/param-variants' : 'apps/web/public/models/thumbs'));
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

export function svgOf(gen, raw = {}) {
  const params = gen.params.parse(raw);
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
export async function thumbOf(gen, raw = {}) {
  const png0 = await sharp(Buffer.from(svgOf(gen, raw))).resize(SIZE, SIZE, { kernel: 'lanczos3' }).png().toBuffer();
  for (let quality = 82; quality >= 30; quality -= 8) {
    const buf = await sharp(png0).webp({ quality, effort: 6, alphaQuality: 80 }).toBuffer();
    if (buf.length <= MAX_BYTES) return buf;
  }
  throw new Error(`${gen.id}: thumbnail does not fit ${MAX_BYTES} B`);
}

/** The CG4 showcase: one entry per descriptor-driven style of the extended generators (label, generator id, params). */
export const VARIANTS = [
  ['oval bath', 'bathtub', { shape: 'oval' }],
  ['freestanding bath on feet', 'bathtub', { shape: 'freestanding', feet: true }],
  ['alcove bath, black', 'bathtub', { shape: 'rect', colour: 'black' }],
  ['vessel basin, round', 'washbasin', { basin: 'vessel', shape: 'round' }],
  ['vessel basin, rect, black', 'washbasin', { basin: 'vessel', shape: 'rect', colour: 'black' }],
  ['integrated basin, round', 'washbasin', { basin: 'integrated', shape: 'round' }],
  ['integrated basin, rect', 'washbasin', { basin: 'integrated', shape: 'rect' }],
  ['sofa rolled arms, velvet green', 'sofa', { arms: 'rolled', legs: 'wood', fabric: 'velvet', colour: 'green' }],
  ['sofa armless, block base', 'sofa', { arms: 'none', legs: 'block', colour: 'beige' }],
  ['sofa track arms, leather brown', 'sofa', { arms: 'track', legs: 'metal', fabric: 'leather', colour: 'brown' }],
  ['bed upholstered headboard', 'bed', { headboardStyle: 'upholstered', upholstery: 'sage', linen: 'cream' }],
  ['bed slatted headboard', 'bed', { headboardStyle: 'slatted' }],
  ['bed panel, navy linen', 'bed', { linen: 'navy' }],
  ['rug round, border', 'rug', { shape: 'round', colour: 'cream', accent: 'terracotta' }],
  ['rug runner, stripes', 'rug', { shape: 'runner', w: 0.8, d: 2.6, pattern: 'stripes', colour: 'beige', accent: 'navy' }],
  ['rug checker', 'rug', { pattern: 'checker', colour: 'cream', accent: 'charcoal' }],
  ['rug round, rings', 'rug', { shape: 'round', pattern: 'stripes', w: 1.6, d: 1.6, colour: 'sand', accent: 'rust' }],
  ['curtains, opaque pair', 'curtains', { colour: 'sage' }],
  ['curtains, sheer single', 'curtains', { sheer: true, panels: 1, pleats: 12 }],
  ['pendant globe', 'pendant', { shape: 'globe' }],
  ['pendant dome, black', 'pendant', { shape: 'dome', colour: 'black', w: 0.5, h: 1 }],
  ['pendant cluster', 'pendant', { shape: 'cluster', w: 0.7, h: 1.4 }],
];

/** A labelled grid of the variants as one PNG (4 columns). */
async function variantsSheet(rows) {
  const cols = 4;
  const cell = 200;
  const label = 26;
  const height = Math.ceil(rows.length / cols) * (cell + label);
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const tiles = await Promise.all(rows.map(async (r) => sharp(await thumbOf(r.gen, r.raw)).resize(cell, cell).png().toBuffer()));
  const texts = rows.map((r, i) => `<text x="${(i % cols) * cell + cell / 2}" y="${Math.floor(i / cols) * (cell + label) + cell + 17}" font-family="Helvetica,Arial,sans-serif" font-size="13" fill="#222" text-anchor="middle">${esc(r.label)}</text>`);
  const svg = Buffer.from(`<svg width="${cols * cell}" height="${height}" xmlns="http://www.w3.org/2000/svg">${texts.join('')}</svg>`);
  return sharp({ create: { width: cols * cell, height, channels: 4, background: '#f4f2ee' } })
    .composite([...tiles.map((input, i) => ({ input, left: (i % cols) * cell, top: Math.floor(i / cols) * (cell + label) })), { input: svg, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(outDir, { recursive: true });
  if (VARIANT_MODE) {
    const rows = VARIANTS.map(([label, id, raw]) => ({ label, raw, gen: ALL_GENERATORS.find((g) => g.id === id) }));
    for (const [i, r] of rows.entries()) {
      const buf = await thumbOf(r.gen, r.raw);
      writeFileSync(join(outDir, `${r.gen.id}-${String(i + 1).padStart(2, '0')}.webp`), buf);
      console.log(`${r.gen.id}-${String(i + 1).padStart(2, '0')}.webp  ${buf.length} B  ${r.label}`);
    }
    writeFileSync(join(outDir, 'variants-sheet.png'), await variantsSheet(rows));
    console.log(`variants-sheet.png in ${outDir}`);
  } else {
    for (const gen of ALL_GENERATORS) {
      const buf = await thumbOf(gen);
      writeFileSync(join(outDir, `param-${gen.id}.webp`), buf);
      console.log(`param-${gen.id}.webp  ${buf.length} B`);
    }
  }
}
