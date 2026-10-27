/* global console, process, Buffer */
// Writes a PNG contact sheet of every parametric generator at its default params:
//   pnpm assets:sheet [out.png]        (default /tmp/assets-contact-sheet.png)
// A tiny software renderer (orthographic 3/4 view, painter's algorithm, flat shading) draws the real generator output as SVG
// polygons, so no browser or GPU is needed. Run through `tsx` because the generators are TypeScript.
import sharp from 'sharp';
import { ALL_GENERATORS } from '../../packages/scene/src/assets/generators/index.ts';
import { ITEM_MATERIAL_SPECS } from '../../packages/scene/src/assets/item-materials.ts';

const out = process.argv[2] ?? '/tmp/assets-contact-sheet.png';
const cols = 5;
const cellW = 320;
const cellH = 300;
const labelH = 46;

const yaw = (35 * Math.PI) / 180;
const pitch = (28 * Math.PI) / 180;
const c = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]; // towards the camera
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const right = norm(cross([0, 1, 0], c));
const up = cross(c, right);
const light = norm([-0.4, 0.8, 0.5]);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function shade(hex, k) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${v.map((x) => Math.round(Math.min(255, x * k))).join(',')})`;
}

function render(gen, ox, oy) {
  const params = gen.params.parse({});
  const { dims } = gen.describeParams(params);
  const mesh = gen.generate(params);
  const project = (i) => {
    const p = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
    return { x: dot(p, right), y: -dot(p, up), z: dot(p, c) };
  };
  const pts = Array.from({ length: mesh.positions.length / 3 }, (_, i) => project(i));
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const scale = Math.min((cellW - 40) / (maxX - minX), (cellH - labelH - 30) / (maxY - minY));
  const offX = ox + (cellW - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = oy + 14 + (cellH - labelH - 30 - (maxY - minY) * scale) / 2 - minY * scale;
  const tris = [];
  for (const g of mesh.groups) {
    const color = ITEM_MATERIAL_SPECS[g.materialId]?.color ?? '#ff00ff';
    for (let k = g.start; k < g.start + g.count; k += 3) {
      const ids = [mesh.indices[k], mesh.indices[k + 1], mesh.indices[k + 2]];
      const n = [mesh.normals[ids[0] * 3], mesh.normals[ids[0] * 3 + 1], mesh.normals[ids[0] * 3 + 2]];
      if (dot(n, c) <= 1e-6) continue; // back face
      const ps = ids.map((i) => pts[i]);
      tris.push({ ps, depth: (ps[0].z + ps[1].z + ps[2].z) / 3, fill: shade(color, 0.55 + 0.45 * Math.max(0, dot(n, light))) });
    }
  }
  tris.sort((a, b) => a.depth - b.depth);
  const polys = tris.map((t) => `<polygon points="${t.ps.map((p) => `${(offX + p.x * scale).toFixed(1)},${(offY + p.y * scale).toFixed(1)}`).join(' ')}" fill="${t.fill}" stroke="${t.fill}" stroke-width="0.4"/>`);
  const label =
    `<text x="${ox + cellW / 2}" y="${oy + cellH - 26}" font-size="14" font-weight="bold" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" fill="#222">${esc(gen.id)}</text>` +
    `<text x="${ox + cellW / 2}" y="${oy + cellH - 9}" font-size="11" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" fill="#666">${dims.w.toFixed(2)} x ${dims.d.toFixed(2)} x ${dims.h.toFixed(2)} m, ${mesh.indices.length / 3} tris</text>`;
  return polys.join('') + label;
}

const rows = Math.ceil(ALL_GENERATORS.length / cols);
const W = cols * cellW;
const H = rows * cellH;
const body = ALL_GENERATORS.map((g, i) => render(g, (i % cols) * cellW, Math.floor(i / cols) * cellH)).join('');
const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#f4f1ec"/>${body}</svg>`;
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`wrote ${out} (${ALL_GENERATORS.length} generators)`);
