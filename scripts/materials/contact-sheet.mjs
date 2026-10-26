/* global console, process, Buffer */
// Writes a contact sheet PNG of all catalog thumbnails with names: node contact-sheet.mjs [out.png]
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/web/public/materials');
const out = process.argv[2] ?? '/tmp/materials-contact-sheet.png';
const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
const cols = 6, cell = 200, thumb = 160, labelH = 36;
const rows = Math.ceil(catalog.length / cols);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const labels = catalog.map((e, i) => {
  const x = (i % cols) * cell, y = Math.floor(i / cols) * (thumb + labelH + 8);
  return `<text x="${x + cell / 2}" y="${y + thumb + 14}" font-size="12" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" fill="#222">${esc(e.name.slice(0, 30))}</text>` +
    `<text x="${x + cell / 2}" y="${y + thumb + 28}" font-size="10" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" fill="#777">${e.category} · ${e.tileSizeM} m</text>`;
});
const W = cols * cell, H = rows * (thumb + labelH + 8);
const composites = [{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${labels.join('')}</svg>`), left: 0, top: 0 }];
for (const [i, e] of catalog.entries()) {
  const img = await sharp(join(dir, e.id, e.files.thumb)).resize(thumb, thumb).png().toBuffer();
  composites.push({ input: img, left: (i % cols) * cell + (cell - thumb) / 2, top: Math.floor(i / cols) * (thumb + labelH + 8) });
}
await sharp({ create: { width: W, height: H, channels: 3, background: '#f4f1ec' } }).composite(composites).png().toFile(out);
console.log('wrote', out);
