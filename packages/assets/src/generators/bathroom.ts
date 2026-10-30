import { z } from 'zod';
import type { Generator } from '@flat/scene';
import { ITEM_MATERIALS, ceramicMaterial } from '../materials/item-materials';
import { cabinet } from './cabinets';
import { Kit, boxAnchors, colourParam, finish, finishMaterial, metres } from './kit';

/** Fixed sanitary ware: bathtub, toilet and washbasin / sink unit. Item frame as in `kit.ts` (front +z, back against the wall). */

/** Sanitary ware is glazed ceramic; the cabinet carcass of a vanity or sink unit is lacquered. */
const CERAMIC = ITEM_MATERIALS.ceramic;
const W = CERAMIC;
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
  shape: z
    .enum(['rect', 'oval', 'freestanding'])
    .default('rect')
    .describe('"rect" is the built-in alcove tub, "oval" an elliptical tub, "freestanding" a slipper-shaped island tub (taps on the rim). Defaults to "rect".'),
  feet: z.boolean().default(false).describe('Stand the tub on feet (about 8-10 cm): clawfoot or raised look. Defaults to false.'),
  colour: colourParam('the tub shell (glazed)'),
});
type BathtubParams = z.infer<typeof bathtubParams>;

export const bathtub: Generator<BathtubParams> = {
  id: 'bathtub',
  label: 'Bathtub (long side is the front; stands against a wall, taps at one end)',
  category: 'other',
  params: bathtubParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.6, back: 0 } }),
  generate({ w, d, h, tapEnd, shape, feet, colour }) {
    const kit = new Kit();
    const W = colour ? ceramicMaterial(colour) : CERAMIC;
    const rim = h - 0.04;
    const s = tapEnd === 'right' ? 1 : -1;
    if (shape !== 'rect') {
      // Oval and freestanding: a lathe shell (smooth ellipse, wall 5 cm at the sides, thicker at the ends), a floor, taps on the rim.
      const rx = w / 2;
      const rz = d / 2;
      const y0 = shape === 'freestanding' ? (feet ? 0.1 : 0.04) : feet ? 0.08 : 0;
      const floorY = y0 + 0.16;
      const inner = 1 - 0.05 / Math.min(rx, rz);
      const profile: [number, number][] =
        shape === 'freestanding' ? [[0.8, y0], [1, y0 + 0.2], [1, rim], [inner, rim], [inner, floorY], [0, floorY]] : [[1, y0], [1, rim], [inner, rim], [inner, floorY], [0, floorY]];
      kit.lathe(W, 0, 0, rx, rz, profile, 32);
      if (feet) {
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const fx = sx * rx * 0.6;
            const fz = sz * rz * 0.55;
            kit.box(METAL, fx - 0.03, 0, fz - 0.03, fx + 0.03, y0 + 0.02, fz + 0.03);
          }
        }
      } else if (y0 > 0) {
        kit.prism(W, 0, 0, 0, rx * 0.75, rz * 0.7, y0 + 0.01);
      }
      const tx = s * rx * 0.7;
      const zEdge = rz * Math.sqrt(1 - 0.49);
      kit.box(METAL, tx - 0.025, rim, -zEdge + 0.005, tx + 0.025, h, -zEdge + 0.055);
      kit.box(METAL, tx - 0.012, rim, -zEdge + 0.055, tx + 0.012, rim + 0.025, -zEdge + 0.16);
      const drain = -s * rx * 0.55;
      kit.box(METAL, drain - 0.03, floorY, -0.03, drain + 0.03, floorY + 0.004, 0.03);
      return kit.build();
    }
    const y0 = feet ? 0.08 : 0;
    const t = 0.05;
    const floor = y0 + 0.16;
    const deck = 0.14; // the tap end is a wide deck
    if (feet) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const fx = sx < 0 ? -w / 2 + 0.08 : w / 2 - 0.08 - 0.05;
          const fz = sz < 0 ? -d / 2 + 0.08 : d / 2 - 0.08 - 0.05;
          kit.box(METAL, fx, 0, fz, fx + 0.05, y0 + 0.01, fz + 0.05);
        }
      }
    }
    kit.box(W, -w / 2, y0, -d / 2, w / 2, floor, d / 2);
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
// Hand basin (wall-hung "lave-mains")
// ---------------------------------------------------------------------------------------------

const handBasinParams = z.strictObject({
  w: metres('Width of the basin along the wall.', 0.4, 0.25, 0.6),
  d: metres('How far it stands out of the wall.', 0.25, 0.18, 0.4),
  h: metres('Height from the underside of the trap to the top of the tap; hang it with an elevation of about 0.68 m.', 0.22, 0.15, 0.35),
});
type HandBasinParams = z.infer<typeof handBasinParams>;

export const handBasin: Generator<HandBasinParams> = {
  id: 'handBasin',
  label: 'Small wall-hung hand basin (lave-mains) with a tap and trap; mount "wall", the wall is at the back',
  category: 'other',
  params: handBasinParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.5, back: 0 } }),
  generate({ w, d, h }) {
    const kit = new Kit();
    // Wall-hung bowl (ellipse, back flat against the wall), a chrome trap below and a small mixer on the back rim.
    const trapH = Math.min(0.06, h * 0.3);
    const rim = h - 0.05;
    const rx = w / 2;
    const rz = d / 2;
    const inner = Math.max(0.05, 1 - 0.018 / Math.min(rx, rz));
    kit.lathe(W, 0, 0, rx, rz, [[0.8, trapH], [1, trapH + 0.05], [1, rim], [inner, rim], [inner, trapH + 0.03], [0, trapH + 0.03]], 24);
    kit.box(W, -rx * 0.7, trapH + 0.03, -d / 2, rx * 0.7, rim, -d / 2 + 0.03); // flat back against the wall
    kit.box(METAL, -0.015, 0, -d / 2 + 0.025, 0.015, trapH + 0.03, -d / 2 + 0.055); // trap
    kit.box(METAL, -0.012, rim, -d / 2 + 0.01, 0.012, h - 0.012, -d / 2 + 0.034); // tap body
    kit.box(METAL, -0.01, h - 0.025, -d / 2 + 0.01, 0.01, h, -d / 2 + 0.1); // spout
    kit.box(METAL, 0.012, h - 0.022, -d / 2 + 0.014, 0.04, h - 0.01, -d / 2 + 0.03); // lever
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Bath screen
// ---------------------------------------------------------------------------------------------

const bathScreenParams = z.strictObject({
  w: metres('Width of the glass screen along the tub.', 0.75, 0.4, 1.2),
  d: metres('Depth of the item (the chrome wall channel is this deep; the glass is 8 mm).', 0.03, 0.02, 0.1),
  h: metres('Height of the screen (mount it on the tub rim with an elevation).', 1.4, 0.8, 2),
});
type BathScreenParams = z.infer<typeof bathScreenParams>;

export const bathScreen: Generator<BathScreenParams> = {
  id: 'bathScreen',
  label: 'Fixed clear-glass bath screen (pare-baignoire); its wall channel is at item-local -x',
  category: 'other',
  params: bathScreenParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0, back: 0 } }),
  generate({ w, d, h }) {
    const kit = new Kit();
    const chan = Math.min(0.02, w / 4);
    // Wall channel (the glass slots into it) and a slim chrome edge along the free side; the pane is clear glass, 8 mm.
    kit.box(ITEM_MATERIALS.aluminium, -w / 2, 0, -d / 2, -w / 2 + chan, h, d / 2, 0.001);
    const t = Math.min(0.008, d);
    kit.box(ITEM_MATERIALS.glassClear, -w / 2 + chan, 0.01, -t / 2, w / 2, h, t / 2, 0);
    kit.box(ITEM_MATERIALS.aluminium, w / 2 - 0.006, 0.01, -d / 2 + 0.008, w / 2, h, d / 2 - 0.008, 0.0005);
    kit.box(ITEM_MATERIALS.aluminium, -w / 2 + chan, 0, -d / 2 + 0.008, w / 2, 0.01, d / 2 - 0.008, 0.0005); // bottom rail
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
  h: metres('Overall height to the top of the basin rim, worktop or tap (a sink with a mixer: the tap top, the worktop is 0.2 m lower).', 0.85, 0.6, 1.2),
  basin: z
    .enum(['vessel', 'integrated'])
    .optional()
    .describe('Vanity only. "vessel": a bowl standing on the top. "integrated": the basin is moulded into the ceramic top. Omitted: the classic low oval basin.'),
  shape: z.enum(['round', 'rect']).optional().describe('Vanity only, with basin: the basin outline, "round" (oval) or "rect". Omitted: round.'),
  colour: colourParam('the ceramic (basin, pedestal and vanity top)'),
  finish: finish('white').describe('Vanity and sink only: finish of the cabinet body and fronts. Defaults to "white".'),
  bowl: z.enum(['steel', 'black']).default('steel').describe('Sink only: "steel" (stainless bowl and drainer) or "black" (black composite). Defaults to "steel".'),
  worktop: z.enum(['quartz', 'concrete']).default('quartz').describe('Sink only: worktop look, "quartz" (polished light stone) or "concrete" (light grey concrete effect). Defaults to "quartz".'),
  mixer: z.boolean().default(false).describe('Sink only: add a tall chrome mixer tap behind the bowl; `h` then counts the tap: the worktop is 0.2 m below it. Defaults to false.'),
});
type WashbasinParams = z.infer<typeof washbasinParams>;

/** Height of the mixer tap above the worktop of a sink unit with `mixer`. */
const SINK_MIXER_H = 0.2;

export const washbasin: Generator<WashbasinParams> = {
  id: 'washbasin',
  label: 'Washbasin: bathroom vanity, pedestal basin, or kitchen sink unit with drainer',
  category: 'other',
  params: washbasinParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.6, back: 0 } }),
  generate({ kind, w, d, h, basin, shape, colour, finish: fin, bowl: bowlStyle, worktop, mixer }) {
    const kit = new Kit();
    const BODY = finishMaterial(fin);
    const W = colour ? ceramicMaterial(colour) : CERAMIC;
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
      const wt = mixer ? h - SINK_MIXER_H : h; // worktop top
      const top = wt - slab;
      cabinet(kit, {
        w,
        d,
        h: top,
        base: 'plinth',
        baseH: 0.1,
        baseMat: ITEM_MATERIALS.dark,
        bodyMat: BODY,
        frontMat: BODY,
        doors: w >= 1 ? 2 : 1,
        drawers: 0,
      });
      const m = Math.min(0.08, d * 0.15);
      const gap = 0.04;
      const BOWL = bowlStyle === 'black' ? ITEM_MATERIALS.compositeBlack : METAL;
      const avail = w - 2 * m - gap;
      const bowlW = Math.max(0.1, Math.min(0.45, avail * 0.45));
      const drainW = Math.max(0, avail - bowlW);
      const bowl: [number, number, number, number] = [-w / 2 + m, -d / 2 + m, -w / 2 + m + bowlW, d / 2 - m];
      const holes: [number, number, number, number][] = [bowl];
      kit.box(BOWL, bowl[0], top, bowl[1], bowl[2], top + 0.004, bowl[3]);
      if (drainW >= 0.12) {
        const drain: [number, number, number, number] = [bowl[2] + gap, -d / 2 + m, w / 2 - m, d / 2 - m];
        holes.push(drain);
        kit.box(BOWL, drain[0], top, drain[1], drain[2], top + 0.004, drain[3]);
        const ribs = Math.max(2, Math.floor(drainW / 0.04));
        const pitch = drainW / ribs;
        for (let i = 0; i < ribs; i++) {
          const x = drain[0] + (i + 0.35) * pitch;
          kit.box(BOWL, x, top + 0.004, drain[1] + 0.02, x + pitch * 0.3, top + 0.012, drain[3] - 0.02, 0);
        }
      }
      kit.slab(worktop === 'concrete' ? ITEM_MATERIALS.concreteLight : ITEM_MATERIALS.worktop, -w / 2, top, -d / 2, w / 2, wt, d / 2, holes);
      if (mixer) {
        // chrome mixer behind the bowl: a post, a gooseneck over the bowl and a lever
        const mx = bowl[0] + bowlW / 2;
        const mz = -d / 2 + 0.06;
        const topY = h;
        kit.box(ITEM_MATERIALS.metal, mx - 0.016, wt, mz - 0.016, mx + 0.016, topY - 0.02, mz + 0.016, 0.003);
        kit.box(ITEM_MATERIALS.metal, mx - 0.012, topY - 0.035, mz - 0.012, mx + 0.012, topY, mz + 0.16, 0.003);
        kit.box(ITEM_MATERIALS.metal, mx - 0.045, wt + 0.07, mz - 0.01, mx - 0.016, wt + 0.085, mz + 0.01, 0.002);
      }
      return kit.build();
    }
    // vanity
    const bodyH = h - 0.14;
    cabinet(kit, { w, d, h: bodyH, base: 'plinth', baseH: 0.1, baseMat: ITEM_MATERIALS.dark, bodyMat: BODY, frontMat: BODY, doors: w >= 0.6 ? 2 : 1, drawers: 0 });
    kit.box(W, -w / 2, bodyH, -d / 2, w / 2, bodyH + 0.04, d / 2); // ceramic vanity top
    const rx = Math.min(0.22, w / 2 - 0.04);
    const rz = Math.min(0.17, d / 2 - 0.04);
    const top = bodyH + 0.04;
    if (basin === undefined) {
      kit.prism(W, 0, top, 0.02, rx, rz, h);
      kit.box(METAL, -0.012, top, -d / 2 + 0.02, 0.012, h - 0.03, -d / 2 + 0.05);
      return kit.build();
    }
    const round = shape !== 'rect';
    const cz = 0.02;
    if (basin === 'vessel') {
      // a bowl on the top (wall 1.5 cm, floor 3 cm), tap behind it
      if (round) {
        const inner = Math.max(0.05, 1 - 0.015 / Math.min(rx, rz));
        kit.lathe(W, 0, cz, rx, rz, [[1, top], [1, h], [inner, h], [inner, top + 0.03], [0, top + 0.03]], 24);
      } else {
        const t = 0.015;
        kit.box(W, -rx, top, cz - rz, rx, top + 0.03, cz + rz);
        kit.box(W, -rx, top + 0.03, cz - rz, -rx + t, h, cz + rz);
        kit.box(W, rx - t, top + 0.03, cz - rz, rx, h, cz + rz);
        kit.box(W, -rx + t, top + 0.03, cz - rz, rx - t, h, cz - rz + t);
        kit.box(W, -rx + t, top + 0.03, cz + rz - t, rx - t, h, cz + rz);
      }
      kit.box(METAL, -0.012, top, -d / 2 + 0.02, 0.012, Math.min(h, top + 0.12), -d / 2 + 0.05);
      return kit.build();
    }
    // integrated: the basin is moulded into the top; a tall mixer reaches the overall height
    if (round) {
      const inner = Math.max(0.05, 1 - 0.02 / Math.min(rx, rz));
      kit.lathe(W, 0, cz, rx, rz, [[1, top], [1, top + 0.025], [inner, top + 0.025], [inner, top + 0.005], [0, top + 0.005]], 24);
    } else {
      const t = 0.02;
      kit.box(W, -rx, top, cz - rz, rx, top + 0.005, cz + rz);
      kit.box(W, -rx, top + 0.005, cz - rz, -rx + t, top + 0.025, cz + rz);
      kit.box(W, rx - t, top + 0.005, cz - rz, rx, top + 0.025, cz + rz);
      kit.box(W, -rx + t, top + 0.005, cz - rz, rx - t, top + 0.025, cz - rz + t);
      kit.box(W, -rx + t, top + 0.005, cz + rz - t, rx - t, top + 0.025, cz + rz);
    }
    kit.box(METAL, -0.012, top, -d / 2 + 0.02, 0.012, h, -d / 2 + 0.05);
    kit.box(METAL, -0.012, h - 0.025, -d / 2 + 0.05, 0.012, h - 0.003, -d / 2 + 0.12);
    return kit.build();
  },
};
