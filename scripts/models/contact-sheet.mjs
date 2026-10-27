/* global console, process, Buffer */
// Contact sheet PNG of all catalog thumbnails: node contact-sheet.mjs [out.png] [catalogDir]
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const dir = resolve(process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '../../apps/web/public/models'));
const out = process.argv[2] ?? '/tmp/models-contact-sheet.png';
const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
const cols = 6, cell = 200, thumb = 160, labelH = 44;
const rows = Math.ceil(catalog.length / cols);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const rowH = thumb + labelH + 8;
const labels = catalog.map((e, i) => {
  const x = (i % cols) * cell, y = Math.floor(i / cols) * rowH;
  const d = e.nativeDims;
  return `<text x="${x + cell / 2}" y="${y + thumb + 14}" font-size="12" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" fill="#222">${esc(e.name.slice(0, 30))}</text>` +
    `<text x="${x + cell / 2}" y="${y + thumb + 28}" font-size="10" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" fill="#777">${e.category} · ${d.w}×${d.d}×${d.h} m</text>` +
    `<text x="${x + cell / 2}" y="${y + thumb + 40}" font-size="9" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" fill="#999">${e.licence} · ${Math.round((e.bytes ?? 0) / 1024)} KB · ${e.triangles ?? '?'} tris</text>`;
});
const W = cols * cell, H = rows * rowH;
const composites = [{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${labels.join('')}</svg>`), left: 0, top: 0 }];
for (const [i, e] of catalog.entries()) {
  const img = await sharp(join(dir, e.thumb)).resize(thumb, thumb).png().toBuffer();
  composites.push({ input: img, left: (i % cols) * cell + (cell - thumb) / 2, top: Math.floor(i / cols) * rowH });
}
await sharp({ create: { width: W, height: H, channels: 3, background: '#f4f1ec' } }).composite(composites).png().toFile(out);
console.log('wrote', out);
