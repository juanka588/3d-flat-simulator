import { z } from 'zod';
import type { Generator } from '../catalog';
import { ITEM_MATERIALS } from '../item-materials';
import { cabinet } from './cabinets';
import { Kit, boxAnchors, metres } from './kit';

/** Fixed sanitary ware: bathtub, toilet and washbasin / sink unit. Item frame as in `kit.ts` (front +z, back against the wall). */

/** Sanitary ware is glazed ceramic; the cabinet carcass of a vanity or sink unit is lacquered. */
const W = ITEM_MATERIALS.ceramic;
const CARCASS = ITEM_MATERIALS.white;
const METAL = ITEM_MATERIALS.metal;

// ---------------------------------------------------------------------------------------------
// Bathtub
// ---------------------------------------------------------------------------------------------

const bathtubParams = z.strictObject({
  w: metres('Length of the bathtub (its long side is the item width, so the long side is the front).', 1.7, 1, 2.2),
  d: metres('Width of the bathtub (front to back).', 0.7, 0.6, 1),
  h: metres('Overall height including the taps; the rim is 4 cm lower.', 0.58, 0.4, 0.7),
  tapEnd: z.enum(['left', 'right']).default('right').describe('Which end of the tub carries the taps, seen from the front. Defaults to "right".'),
});
type BathtubParams = z.infer<typeof bathtubParams>;

export const bathtub: Generator<BathtubParams> = {
  id: 'bathtub',
  label: 'Bathtub (long side is the front; stands against a wall, taps at one end)',
  category: 'other',
  params: bathtubParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.6, back: 0 } }),
  generate({ w, d, h, tapEnd }) {
    const kit = new Kit();
    const rim = h - 0.04;
    const t = 0.05;
    const floor = 0.16;
    const s = tapEnd === 'right' ? 1 : -1;
    const deck = 0.14; // the tap end is a wide deck
    kit.box(W, -w / 2, 0, -d / 2, w / 2, floor, d / 2);
    kit.box(W, -w / 2, floor, -d / 2, w / 2, rim, -d / 2 + t); // back
    kit.box(W, -w / 2, floor, d / 2 - t, w / 2, rim, d / 2); // front
    const end = (side: number, thick: number) => (side > 0 ? [w / 2 - thick, w / 2] : [-w / 2, -w / 2 + thick]) as [number, number];
    const [tapA, tapB] = end(s, deck);
    const [footA, footB] = end(-s, t);
    kit.box(W, tapA, floor, -d / 2 + t, tapB, rim, d / 2 - t);
    kit.box(W, footA, floor, -d / 2 + t, footB, rim, d / 2 - t);
    // taps and spout on the deck (their tops reach exactly h), overflow plate and drain on the floor
    const tx = s * (w / 2 - deck / 2);
    kit.box(METAL, tx - 0.025, rim, -0.025, tx + 0.025, h, 0.025);
    kit.box(METAL, tx - 0.025, rim, -0.14, tx + 0.025, rim + 0.025, -0.09);
    kit.box(METAL, tx - 0.025, rim, 0.09, tx + 0.025, rim + 0.025, 0.14);
    const drain = -s * (w / 2 - t - 0.12);
    kit.box(METAL, drain - 0.03, floor, -0.03, drain + 0.03, floor + 0.004, 0.03);
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Toilet
// ---------------------------------------------------------------------------------------------

const toiletParams = z.strictObject({
  w: metres('Width of the toilet (across the cistern).', 0.4, 0.3, 0.5),
  d: metres('Length of the toilet from the wall (cistern back) to the front of the bowl.', 0.66, 0.5, 0.8),
  h: metres('Overall height to the top of the cistern.', 0.8, 0.6, 0.95),
});
type ToiletParams = z.infer<typeof toiletParams>;

export const toilet: Generator<ToiletParams> = {
  id: 'toilet',
  label: 'Close-coupled toilet (cistern at the back against the wall, bowl in front)',
  category: 'other',
  params: toiletParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.6, back: 0, left: 0.2, right: 0.2 } }),
  generate({ w, d, h }) {
    const kit = new Kit();
    const cistern = Math.min(0.2, d * 0.35);
    const rz = (d - cistern + 0.02) / 2;
    const cz = d / 2 - rz;
    const seat = Math.min(0.4, h - 0.2);
    kit.prism(W, 0, 0, cz, (w / 2) * 0.7, rz * 0.8, seat - 0.08); // pedestal
    kit.prism(W, 0, seat - 0.08, cz, w / 2, rz, seat); // bowl
    kit.prism(CARCASS, 0, seat, cz, w / 2 - 0.02, rz - 0.02, seat + 0.025); // seat and lid
    kit.box(W, -w / 2 + 0.02, seat - 0.06, -d / 2, w / 2 - 0.02, h - 0.015, -d / 2 + cistern); // cistern
    kit.box(METAL, -0.04, h - 0.015, -d / 2 + cistern / 2 - 0.02, 0.04, h, -d / 2 + cistern / 2 + 0.02); // flush button
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Washbasin / sink unit
// ---------------------------------------------------------------------------------------------

const washbasinParams = z.strictObject({
  kind: z
    .enum(['vanity', 'pedestal', 'sink'])
    .default('vanity')
    .describe('"vanity" is a cabinet with a top and a basin on it, "pedestal" a basin on a column, "sink" a kitchen sink unit (cabinet with a worktop, a bowl and a drainer). Defaults to "vanity".'),
  w: metres('Overall width.', 0.7, 0.3, 1.8),
  d: metres('Overall depth (front to back).', 0.45, 0.3, 0.8),
  h: metres('Overall height to the top of the basin rim, worktop or tap.', 0.85, 0.6, 1),
});
type WashbasinParams = z.infer<typeof washbasinParams>;

export const washbasin: Generator<WashbasinParams> = {
  id: 'washbasin',
  label: 'Washbasin: bathroom vanity, pedestal basin, or kitchen sink unit with drainer',
  category: 'other',
  params: washbasinParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.6, back: 0 } }),
  generate({ kind, w, d, h }) {
    const kit = new Kit();
    if (kind === 'pedestal') {
      const rimT = 0.035;
      const bowl = 0.07;
      kit.box(W, -Math.min(0.07, w * 0.2), 0, -Math.min(0.08, d * 0.2), Math.min(0.07, w * 0.2), h - 0.16, Math.min(0.08, d * 0.2));
      kit.box(W, -w / 2, h - 0.16, -d / 2, w / 2, h - bowl, d / 2);
      kit.box(W, -w / 2, h - bowl, -d / 2, -w / 2 + rimT, h, d / 2);
      kit.box(W, w / 2 - rimT, h - bowl, -d / 2, w / 2, h, d / 2);
      kit.box(W, -w / 2 + rimT, h - bowl, -d / 2, w / 2 - rimT, h, -d / 2 + rimT);
      kit.box(W, -w / 2 + rimT, h - bowl, d / 2 - rimT, w / 2 - rimT, h, d / 2);
      kit.box(METAL, -0.012, h - bowl, -d / 2 + rimT, 0.012, h - 0.015, -d / 2 + rimT + 0.03);
      return kit.build();
    }
    if (kind === 'sink') {
      const slab = 0.04;
      const top = h - slab;
      cabinet(kit, {
        w,
        d,
        h: top,
        base: 'plinth',
        baseH: 0.1,
        baseMat: ITEM_MATERIALS.dark,
        bodyMat: CARCASS,
        frontMat: CARCASS,
        doors: w >= 1 ? 2 : 1,
        drawers: 0,
      });
      const m = Math.min(0.08, d * 0.15);
      const gap = 0.04;
      const avail = w - 2 * m - gap;
      const bowlW = Math.max(0.1, Math.min(0.45, avail * 0.45));
      const drainW = Math.max(0, avail - bowlW);
      const bowl: [number, number, number, number] = [-w / 2 + m, -d / 2 + m, -w / 2 + m + bowlW, d / 2 - m];
      const holes: [number, number, number, number][] = [bowl];
      kit.box(METAL, bowl[0], top, bowl[1], bowl[2], top + 0.004, bowl[3]);
      if (drainW >= 0.12) {
        const drain: [number, number, number, number] = [bowl[2] + gap, -d / 2 + m, w / 2 - m, d / 2 - m];
        holes.push(drain);
        kit.box(METAL, drain[0], top, drain[1], drain[2], top + 0.004, drain[3]);
        const ribs = Math.max(2, Math.floor(drainW / 0.04));
        const pitch = drainW / ribs;
        for (let i = 0; i < ribs; i++) {
          const x = drain[0] + (i + 0.35) * pitch;
          kit.box(METAL, x, top + 0.004, drain[1] + 0.02, x + pitch * 0.3, top + 0.012, drain[3] - 0.02, 0);
        }
      }
      kit.slab(ITEM_MATERIALS.worktop, -w / 2, top, -d / 2, w / 2, h, d / 2, holes);
      return kit.build();
    }
    // vanity
    const bodyH = h - 0.14;
    cabinet(kit, { w, d, h: bodyH, base: 'plinth', baseH: 0.1, baseMat: ITEM_MATERIALS.dark, bodyMat: CARCASS, frontMat: CARCASS, doors: w >= 0.6 ? 2 : 1, drawers: 0 });
    kit.box(W, -w / 2, bodyH, -d / 2, w / 2, bodyH + 0.04, d / 2); // ceramic vanity top
    const rx = Math.min(0.22, w / 2 - 0.04);
    const rz = Math.min(0.17, d / 2 - 0.04);
    kit.prism(W, 0, bodyH + 0.04, 0.02, rx, rz, h);
    kit.box(METAL, -0.012, bodyH + 0.04, -d / 2 + 0.02, 0.012, h - 0.03, -d / 2 + 0.05);
    return kit.build();
  },
};
