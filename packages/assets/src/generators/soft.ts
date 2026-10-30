import { z } from 'zod';
import type { Generator } from '@flat/scene';
import { ITEM_MATERIALS, SHEER_MATERIAL, ceramicMaterial, fabricMaterial, tintMaterial } from '../materials/item-materials';
import { Kit, boxAnchors, colourParam, metres } from './kit';

/** Curtains and the pendant lamp (CG4): soft furnishings and lighting shapes that descriptors ask for and the shops rarely give as 3D. */

// ---------------------------------------------------------------------------------------------
// Curtains
// ---------------------------------------------------------------------------------------------

const curtainParams = z.strictObject({
  w: metres('Width of the rail (the curtain hangs under it).', 1.6, 0.5, 6),
  h: metres('Length from the top of the rail to the hem (floor length is the room height minus a few cm).', 2.4, 0.8, 3),
  d: metres('Depth of the pleats and of the rail brackets (front to back).', 0.08, 0.01, 0.15),
  pleats: z.number().int().min(1).max(20).default(8).describe('Folds per panel, whole number 1-20. More folds read as a fuller curtain. Defaults to 8.'),
  panels: z
    .union([z.literal(1), z.literal(2)])
    .default(2)
    .describe('1 = one panel across the whole rail, 2 = a pair drawn to the two sides (the middle 20% open). Defaults to 2.'),
  sheer: z.boolean().default(false).describe('A translucent voile instead of an opaque fabric. Defaults to false.'),
  tint: z.boolean().default(false).describe('Colour an opaque curtain with the dominant colour of the product photo when one is available, else the colour. Defaults to false.'),
  colour: colourParam('an opaque curtain (default natural linen)'),
});
type CurtainParams = z.infer<typeof curtainParams>;

export const curtains: Generator<CurtainParams> = {
  id: 'curtains',
  label: 'Curtains on a rail with pleats, opaque or sheer (hang with mount "wall" and the item elevation; the rail is at the top)',
  category: 'curtain',
  params: curtainParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.2, back: 0 } }),
  generate({ w, d, h, pleats, panels, sheer, tint, colour }) {
    const kit = new Kit();
    const fabric = sheer ? SHEER_MATERIAL : tint ? tintMaterial(colour ?? 'cream') : colour ? fabricMaterial('weave', colour) : ITEM_MATERIALS.bedding;
    const tf = Math.min(0.012, d / 4);
    // the rail, and brackets that reach back to the wall (-d/2)
    const rz = Math.min(0.01, d / 2);
    kit.box(ITEM_MATERIALS.metal, -w / 2, h - 0.02, -rz, w / 2, h, rz);
    kit.box(ITEM_MATERIALS.metal, -w / 2, h - 0.025, -d / 2, -w / 2 + 0.02, h, Math.min(0.0105, d / 2));
    kit.box(ITEM_MATERIALS.metal, w / 2 - 0.02, h - 0.025, -d / 2, w / 2, h, Math.min(0.0105, d / 2));
    const pw = panels === 1 ? w : w * 0.4;
    const spans: [number, number][] = panels === 1 ? [[-w / 2, w / 2]] : [[-w / 2, -w / 2 + pw], [w / 2 - pw, w / 2]];
    const top = h - 0.025;
    for (const [a, b] of spans) {
      const n = pleats * 2;
      const sw = (b - a) / n;
      const conn = Math.min(0.004, sw / 2);
      for (let i = 0; i < n; i++) {
        const front = i % 2 === 1;
        const x0 = a + i * sw;
        kit.box(fabric, x0, 0, front ? d / 2 - tf : -d / 2, x0 + sw, top, front ? d / 2 : -d / 2 + tf, 0);
        if (i + 1 < n) kit.box(fabric, x0 + sw - conn / 2, 0, -d / 2 + tf, x0 + sw + conn / 2, top, d / 2 - tf, 0);
      }
    }
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Pendant lamp
// ---------------------------------------------------------------------------------------------

const pendantParams = z.strictObject({
  shape: z.enum(['globe', 'dome', 'cluster', 'sputnik']).default('globe').describe('"globe" (one round shade), "dome" (open bell shade), "cluster" (five small globes at different heights) or "sputnik" (a chrome ceiling lamp: eight curved arms ending in small crystal balls; flush to the ceiling, `h` is its drop). Defaults to "globe".'),
  w: metres('Diameter of the shade (of the whole cluster).', 0.4, 0.15, 1),
  h: metres('Overall height from the bottom of the shade to the ceiling canopy; the item elevation is where the bottom hangs.', 1.2, 0.4, 2.5),
  colour: colourParam('the shade (glossy)'),
});
type PendantParams = z.infer<typeof pendantParams>;

/** Points `[radius share, y]` of a closed globe of height `sh` standing from `y0`, bottom to top (outside on the right). */
function globeProfile(y0: number, sh: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k <= 8; k++) {
    const th = -Math.PI / 2 + (Math.PI * k) / 8;
    out.push([k === 0 || k === 8 ? 0 : Math.cos(th), y0 + sh / 2 + (sh / 2) * Math.sin(th)]);
  }
  return out;
}

/**
 * Sputnik ceiling lamp: a chrome canopy at the ceiling (top at `h`), eight curved chrome arms and a small crystal ball at the
 * end of each. Four arms (along the axes) reach the full radius, the others are shorter and hang at different heights, so the
 * outer bounding box is exact: `w` wide in x and z, the lowest ball bottom at 0, the canopy top at `h`.
 */
function sputnik(kit: Kit, w: number, h: number): void {
  const rb = Math.min(0.05, w * 0.07, h * 0.2);
  const arms = 8;
  const canopyY = h - 0.03;
  const armTop = h - 0.045;
  const R = w / 2 - rb;
  const cr = Math.min(0.08, w * 0.3);
  kit.prism(ITEM_MATERIALS.chrome, 0, canopyY, 0, cr, cr, h, 16);
  kit.prism(ITEM_MATERIALS.chrome, 0, armTop - 0.03, 0, cr * 0.45, cr * 0.45, canopyY, 8);
  // ball heights: 0 = the lowest balls (bottom at y = 0), 1 = the highest, within the drop `h`
  const drop = Math.max(0, armTop - 2 * rb - 0.04);
  const level = [0, 0.7, 0.35, 0.9, 0.15, 0.6, 0.45, 1];
  for (let i = 0; i < arms; i++) {
    const ang = (2 * Math.PI * i) / arms;
    const axis = i % 2 === 0;
    const r = axis ? R : R * 0.82;
    const lv = axis ? [0, 0.35, 0.15, 0.6][i / 2]! : level[i]!;
    const cy = rb + Math.min(drop, drop * lv);
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const start: [number, number, number] = [0, armTop, 0];
    const ctrl: [number, number, number] = [dx * r * 0.45, armTop - 0.01, dz * r * 0.45];
    const end: [number, number, number] = [dx * r, cy, dz * r];
    let prev = start;
    for (let k = 1; k <= 4; k++) {
      const t = k / 4;
      const a = (1 - t) * (1 - t);
      const b = 2 * (1 - t) * t;
      const c = t * t;
      const pt: [number, number, number] = [a * start[0] + b * ctrl[0] + c * end[0], a * start[1] + b * ctrl[1] + c * end[1], a * start[2] + b * ctrl[2] + c * end[2]];
      kit.tube(ITEM_MATERIALS.chrome, prev, pt, 0.004, 6);
      prev = pt;
    }
    kit.lathe(ITEM_MATERIALS.crystal, dx * r, dz * r, rb, rb, ballProfile(cy - rb, 2 * rb), 8);
  }
}

/** A six-step globe profile (bottom, then up the outside) for the small balls. */
function ballProfile(y0: number, sh: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k <= 6; k++) {
    const th = -Math.PI / 2 + (Math.PI * k) / 6;
    out.push([k === 0 || k === 6 ? 0 : Math.cos(th), y0 + sh / 2 + (sh / 2) * Math.sin(th)]);
  }
  return out;
}

export const pendant: Generator<PendantParams> = {
  id: 'pendant',
  label: 'Pendant lamp: globe, dome or cluster of globes on cords (mount "ceiling"; a generated pendant has no light)',
  category: 'lamp',
  params: pendantParams,
  describeParams: ({ w, h }) => ({ dims: { w, d: w, h }, anchors: boxAnchors(w, w, h), clearance: { front: 0.3, back: 0.3, left: 0.3, right: 0.3 } }),
  generate({ shape, w, h, colour }) {
    const kit = new Kit();
    const shade = colour ? ceramicMaterial(colour) : ITEM_MATERIALS.white;
    const cord = ITEM_MATERIALS.dark;
    const cordTop = h - 0.03;
    if (shape === 'sputnik') {
      sputnik(kit, w, h);
      return kit.build();
    }
    kit.box(ITEM_MATERIALS.metal, -0.06, cordTop, -0.06, 0.06, h, 0.06);
    if (shape === 'globe') {
      const sh = Math.min(w, h - 0.06);
      kit.lathe(shade, 0, 0, w / 2, w / 2, globeProfile(0, sh), 32);
      kit.box(cord, -0.004, sh, -0.004, 0.004, cordTop, 0.004, 0);
    } else if (shape === 'dome') {
      const dh = Math.min(w * 0.55, h - 0.06);
      const outer: [number, number][] = [];
      const inner: [number, number][] = [];
      for (let k = 0; k <= 6; k++) {
        const th = (Math.PI / 2) * (k / 6);
        outer.push([Math.cos(th), dh * Math.sin(th)]);
        inner.push([0.96 * Math.cos(th), dh * 0.96 * Math.sin(th)]);
      }
      kit.lathe(shade, 0, 0, w / 2, w / 2, [...outer, ...inner.reverse()], 32);
      kit.box(cord, -0.004, dh, -0.004, 0.004, cordTop, 0.004, 0);
    } else {
      const g = Math.min(w * 0.38, h - 0.08);
      const a = w / 2 - g / 2;
      const spread = Math.min(0.3, Math.max(0, h - 0.08 - g));
      const spots: [number, number, number][] = [[0, 0, 0], [-a, 0, 0.55], [a, 0, 1], [0, -a, 0.8], [0, a, 0.35]];
      for (const [x, z, k] of spots) {
        const y0 = spread * k;
        kit.lathe(shade, x, z, g / 2, g / 2, globeProfile(y0, g), 16);
        kit.box(cord, x - 0.003, y0 + g, z - 0.003, x + 0.003, cordTop, z + 0.003, 0);
      }
    }
    return kit.build();
  },
};
