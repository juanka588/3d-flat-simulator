import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertLocal, ensureAccepted, mapCategory } from './local.mjs';

// SYNTHETIC sample in the ASSUMED (unverified) 3D-FUTURE layout: model_info.json + <id>/raw_model.obj + texture.png.
const box = (w, h, d) => {
  const x = w / 2, z = d / 2;
  const v = [[-x, 0, -z], [x, 0, -z], [x, h, -z], [-x, h, -z], [-x, 0, z], [x, 0, z], [x, h, z], [-x, h, z]];
  const f = [[1, 2, 3, 4], [5, 8, 7, 6], [1, 5, 6, 2], [4, 3, 7, 8], [1, 4, 8, 5], [2, 6, 7, 3]];
  return `mtllib raw_model.mtl\n${v.map((p) => `v ${p.join(' ')}`).join('\n')}\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl m0\n${f.map((q) => `f ${q.map((i, k) => `${i}/${k + 1}`).join(' ')}`).join('\n')}\n`;
};

async function makeSample() {
  const src = mkdtempSync(join(tmpdir(), 'f3d-src-'));
  const info = [
    { model_id: 'aaaa1111-0000', category: 'King-size Bed', 'super-category': 'Bed', style: 'Modern', theme: 'Others', material: 'Wood' },
    { model_id: 'bbbb2222-0000', category: 'Three-Seat / Multi-seat Sofa', 'super-category': 'Sofa', style: 'Chinoiserie', theme: 'Others', material: 'Fabric' },
    { model_id: 'cccc3333-0000', category: 'Nightstand', 'super-category': 'Cabinet/Shelf/Desk', style: 'Modern', theme: 'Others', material: 'Wood' },
    { model_id: '../evil', category: 'Bed', style: 'x' },
    { model_id: 'dddd4444-0000', category: 'Bed', style: 'x' }, // listed but no files
  ];
  writeFileSync(join(src, 'model_info.json'), JSON.stringify(info));
  for (const [id, w, h, d] of [['aaaa1111-0000', 1.8, 0.5, 2.0], ['bbbb2222-0000', 2.2, 0.8, 0.9], ['cccc3333-0000', 0.5, 0.5, 0.4]]) {
    mkdirSync(join(src, id), { recursive: true });
    writeFileSync(join(src, id, 'raw_model.obj'), box(w, h, d));
    writeFileSync(join(src, id, 'raw_model.mtl'), 'newmtl m0\nKd 0.7 0.5 0.4\nmap_Kd texture.png\n');
    writeFileSync(join(src, id, 'texture.png'), await sharp({ create: { width: 64, height: 64, channels: 3, background: '#b08060' } }).png().toBuffer());
  }
  return src;
}

describe('3D-FUTURE local pack (synthetic sample)', () => {
  it('maps dataset categories to ProductCategory', () => {
    expect(mapCategory('King-size Bed')).toBe('bed');
    expect(mapCategory('Three-Seat / Multi-seat Sofa')).toBe('sofa');
    expect(mapCategory('Nightstand')).toBe('bedside');
    expect(mapCategory('Dining Table')).toBe('table');
    expect(mapCategory('Pendant Lamp')).toBe('lamp');
    expect(mapCategory('Unknown thing')).toBe('other');
  });

  it('refuses without acceptance, records it once, and converts the sample', async () => {
    const src = await makeSample();
    const out = join(mkdtempSync(join(tmpdir(), 'f3d-out-')), '3d-future');
    const logs = [];
    const log = (m) => logs.push(m);
    await expect(convertLocal({ src, out, log })).rejects.toThrow(/licence not accepted/);
    expect(logs.join('\n')).toMatch(/NON-COMMERCIAL ACADEMIC RESEARCH/);
    expect(ensureAccepted(out, false, log)).toBe(false);

    const { catalog, skipped } = await convertLocal({ src, out, accept: true, log });
    expect(existsSync(join(out, '.licence-accepted'))).toBe(true);
    expect(ensureAccepted(out, false, log)).toBe(true); // recorded once: no flag needed again
    expect(catalog.map((c) => c.id)).toEqual(['local:3dfuture:aaaa1111-0000', 'local:3dfuture:bbbb2222-0000', 'local:3dfuture:cccc3333-0000']);
    expect(skipped.map((s) => s.id).sort()).toEqual(['../evil', 'dddd4444-0000']);

    const bed = catalog[0];
    expect(bed).toMatchObject({ source: '3dfuture', licence: 'LicenseRef-3D-FUTURE', category: 'bed', front: '+z', file: 'aaaa1111-0000.glb' });
    expect(bed.nativeDims.w).toBeCloseTo(1.8, 2);
    expect(bed.nativeDims.d).toBeCloseTo(2.0, 2);
    expect(bed.nativeDims.h).toBeCloseTo(0.5, 2);
    expect(bed.styleTags).toContain('modern');
    expect(catalog[2].category).toBe('bedside');
    const onDisk = JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8'));
    expect(onDisk).toHaveLength(3);
    for (const c of onDisk) {
      expect(existsSync(join(out, c.file))).toBe(true);
      expect(existsSync(join(out, c.thumb))).toBe(true);
      expect(readFileSync(join(out, c.file)).subarray(0, 4).toString()).toBe('glTF');
    }
  }, 60_000);
});
