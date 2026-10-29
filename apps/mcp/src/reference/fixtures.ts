import { deflateSync } from 'node:zlib';
import type { ReferenceDescriptor } from './descriptor';

/** Test helpers of the CG4 reference tools: a hand-written descriptor and a synthetic depth map. Not imported by the server. */

/**
 * The CG0 French Parisian bathroom reference (`.tmp/cg-spike/out/qcn-sdb-french-parisian-s1.png`, 1024x768) read by hand:
 * a white alcove bath along the right wall, a marble vanity with an oval vessel basin and brass fittings, a black-framed mirror,
 * two brass sconces, a towel rail and a small plant.
 */
export const PARISIAN_BATHROOM: ReferenceDescriptor = {
  style: 'french parisian bathroom: wall panelling, marble, brass, herringbone oak',
  palette: [
    { hex: '#e4dccd', role: 'walls and panelling', areaPct: 48 },
    { hex: '#d9a066', role: 'floor (herringbone oak)', areaPct: 10 },
    { hex: '#f4f2ee', role: 'bath and basin', areaPct: 14 },
    { hex: '#1f2a38', role: 'dark navy door', areaPct: 14 },
    { hex: '#b8943a', role: 'brass fittings', areaPct: 2 },
  ],
  materials: { floor: 'herringbone oak parquet', walls: 'painted plaster with moulded panelling', accents: ['brass taps and handles', 'white marble vanity', 'black wood mirror frame'] },
  lighting: { mood: 'soft warm evening', kelvin: 2700, fixtures: ['two brass wall sconces with opal glass shades'] },
  items: [
    {
      id: 'tub',
      category: 'other',
      subtype: 'alcove bathtub',
      shape: 'straight rectangular, rounded inner corners, taps on the right end',
      colour: 'white',
      material: 'glossy acrylic',
      approxDims: { w: 1.7, d: 0.75, h: 0.58 },
      box: [420, 425, 795, 730],
      placementHint: { relation: 'against_wall', wall: 'back' },
      importance: 5,
      searchTerms: ['baignoire rectangulaire', 'baignoire 170x75'],
    },
    {
      id: 'vanity',
      category: 'other',
      subtype: 'marble vanity unit with two doors and a drawer',
      shape: 'rectangular cabinet on short legs, brass bar handles',
      colour: 'white marble',
      material: 'marble',
      approxDims: { w: 0.8, d: 0.5, h: 0.85 },
      box: [190, 445, 455, 715],
      placementHint: { relation: 'against_wall', wall: 'left' },
      importance: 4,
      searchTerms: ['meuble sous vasque marbre', 'meuble lavabo blanc'],
    },
    {
      id: 'basin',
      category: 'other',
      subtype: 'oval vessel basin',
      shape: 'oval bowl standing on the vanity top',
      colour: 'white',
      material: 'glazed ceramic',
      approxDims: { w: 0.5, d: 0.38, h: 0.14 },
      box: [270, 430, 405, 525],
      placementHint: { relation: 'on', nearItemId: 'vanity' },
      importance: 3,
      searchTerms: ['vasque ovale à poser'],
    },
    {
      id: 'mirror',
      category: 'mirror',
      subtype: 'rectangular wall mirror with a thick black frame',
      shape: 'portrait rectangle, black wood frame',
      colour: 'black',
      material: 'wood and glass',
      approxDims: { w: 0.6, d: 0.04, h: 0.8 },
      box: [125, 100, 335, 410],
      placementHint: { relation: 'wall_mounted', wall: 'left' },
      importance: 3,
      searchTerms: ['miroir salle de bain cadre noir'],
    },
    {
      id: 'sconce',
      category: 'lamp',
      subtype: 'brass wall sconce with opal glass shade',
      shape: 'curved brass arm, square-ish frosted shade',
      colour: 'brass gold',
      material: 'brass and opal glass',
      approxDims: { w: 0.15, d: 0.2, h: 0.25 },
      box: [20, 150, 100, 265],
      placementHint: { relation: 'wall_mounted', wall: 'left', nearItemId: 'mirror' },
      importance: 2,
      searchTerms: ['applique murale laiton'],
    },
    {
      id: 'towel-rail',
      category: 'other',
      subtype: 'brass towel rail with grey towel',
      shape: 'single bar with two brass brackets',
      colour: 'brass gold',
      material: 'brass',
      approxDims: { w: 0.5, d: 0.1, h: 0.05 },
      box: [60, 535, 210, 640],
      placementHint: { relation: 'wall_mounted', wall: 'left' },
      importance: 1,
      searchTerms: ['porte-serviettes laiton'],
    },
  ],
  decor: ['small green plant on the vanity top', 'soap dispenser in brass', 'folded grey towel'],
};

const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
};

/** A 16-bit grayscale PNG (filter 0) of `values` (row-major). */
export function encodePng16Gray(width: number, height: number, values: Uint16Array): Buffer {
  const raw = Buffer.alloc((width * 2 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 2 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.writeUInt16BE(values[y * width + x]!, y * (width * 2 + 1) + 1 + x * 2);
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 16;
  ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * The depth (millimetres) of a camera at height `camY` looking horizontally along -Z over a flat floor with a back wall at
 * `wallZ` metres: below the horizon the floor, above it (or beyond the wall) the wall.
 */
export function floorAndWallDepth(width: number, height: number, fovDeg: number, camY: number, wallDistance: number): Uint16Array {
  const f = height / 2 / Math.tan((fovDeg * Math.PI) / 360);
  const out = new Uint16Array(width * height);
  for (let j = 0; j < height; j++) {
    const below = (j + 0.5 - height / 2) / f; // tan of the angle below the horizon
    const floor = below > 1e-6 ? camY / below : Infinity;
    const d = Math.min(floor, wallDistance);
    for (let i = 0; i < width; i++) out[j * width + i] = Math.round(d * 1000);
  }
  return out;
}
