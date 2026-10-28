import { z } from 'zod';
import type { Generator } from '../../items/mesh-source';
import { ITEM_MATERIALS } from '../item-materials';
import { Kit, boxAnchors, count, metres } from './kit';

/** Kitchen appliances that stand on the floor: cooking block and fridge. Item frame as in `kit.ts` (front +z). */

/** Enamelled appliance body, dark plinth, glass hob plate and oven window. */
const W = ITEM_MATERIALS.enamel;
const DARK = ITEM_MATERIALS.dark;
const GLASS = ITEM_MATERIALS.glass;
const METAL = ITEM_MATERIALS.metal;

// ---------------------------------------------------------------------------------------------
// Cooking block (hob over an oven)
// ---------------------------------------------------------------------------------------------

const cooktopParams = z.strictObject({
  w: metres('Width of the cooking block.', 0.6, 0.4, 1),
  d: metres('Depth of the cooking block (front to back).', 0.6, 0.5, 0.7),
  h: metres('Height of the hob surface; level it with the neighbouring worktop (0.9).', 0.9, 0.8, 0.95),
  burners: count('Number of hob burners.', 4, 1, 4),
});
type CooktopParams = z.infer<typeof cooktopParams>;

export const cooktop: Generator<CooktopParams> = {
  id: 'cooktop',
  label: 'Cooking block: hob over an oven, sits in a worktop run (French "bloc cuisson")',
  category: 'appliance',
  params: cooktopParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.9, back: 0 } }),
  generate({ w, d, h, burners }) {
    const kit = new Kit();
    const front = d / 2 - 0.03;
    kit.box(DARK, -w / 2 + 0.02, 0, -d / 2 + 0.02, w / 2 - 0.02, 0.07, front); // plinth
    kit.box(W, -w / 2, 0.07, -d / 2, w / 2, h - 0.03, front); // body
    kit.box(GLASS, -w / 2, h - 0.03, -d / 2, w / 2, h - 0.012, d / 2); // hob plate
    // control strip with knobs
    kit.box(W, -w / 2, h - 0.12, front, w / 2, h - 0.03, d / 2 - 0.012);
    const knobs = Math.min(4, Math.max(2, Math.floor(w / 0.14)));
    for (let i = 0; i < knobs; i++) {
      const x = -w / 2 + (w * (i + 0.5)) / knobs;
      kit.box(METAL, x - 0.015, h - 0.085, d / 2 - 0.012, x + 0.015, h - 0.055, d / 2);
    }
    // oven door: white frame, dark window, handle bar
    kit.box(W, -w / 2 + 0.02, 0.12, front, w / 2 - 0.02, h - 0.14, d / 2 - 0.012);
    kit.box(GLASS, -w / 2 + 0.07, 0.2, d / 2 - 0.012, w / 2 - 0.07, h - 0.24, d / 2 - 0.006, 0.001);
    kit.handle(METAL, 0, h - 0.19, w - 0.12, false, d / 2 - 0.006, 0.006);
    // burners
    const spots: [number, number][] = [[-1, -1], [1, 1], [1, -1], [-1, 1]];
    const r = Math.min(w, d) * 0.16;
    for (const [sx, sz] of spots.slice(0, burners)) {
      const cx = burners === 1 ? 0 : sx * Math.min(w, d) * 0.22;
      const cz = burners === 1 ? 0 : sz * Math.min(w, d) * 0.22;
      kit.prism(METAL, cx, h - 0.012, cz, r, r, h);
    }
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Fridge
// ---------------------------------------------------------------------------------------------

const fridgeParams = z.strictObject({
  w: metres('Width of the fridge.', 0.6, 0.5, 0.9),
  d: metres('Depth of the fridge (front to back) including the handle.', 0.65, 0.55, 0.8),
  h: metres('Height of the fridge; a tall fridge-freezer is about 1.85.', 1.85, 0.8, 2.1),
  freezer: z.enum(['none', 'bottom', 'top']).default('bottom').describe('Where the separate freezer door is: "bottom", "top" or "none" for a single door. Defaults to "bottom".'),
});
type FridgeParams = z.infer<typeof fridgeParams>;

export const fridge: Generator<FridgeParams> = {
  id: 'fridge',
  label: 'Fridge or fridge-freezer (door opens to the front)',
  category: 'appliance',
  params: fridgeParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.65, back: 0.05 } }),
  generate({ w, d, h, freezer }) {
    const kit = new Kit();
    const base = 0.05;
    const doorBack = d / 2 - 0.035;
    const doorFace = d / 2 - 0.012;
    kit.box(DARK, -w / 2 + 0.02, 0, -d / 2 + 0.02, w / 2 - 0.02, base, doorBack);
    kit.box(W, -w / 2, base, -d / 2, w / 2, h, doorBack);
    const doors: [number, number][] = [];
    const gap = 0.004;
    const fz = Math.min(0.7, Math.max(0.3, h * 0.33)); // height of the freezer door
    if (freezer === 'none') doors.push([base + gap, h - gap]);
    else if (freezer === 'bottom') doors.push([base + gap, base + fz - gap / 2], [base + fz + gap / 2, h - gap]);
    else doors.push([base + gap, h - fz - gap / 2], [h - fz + gap / 2, h - gap]);
    for (const [y0, y1] of doors) {
      kit.box(W, -w / 2 + gap, y0, doorBack, w / 2 - gap, y1, doorFace);
      const bar = Math.min(0.5, (y1 - y0) * 0.6);
      const ym = freezer === 'none' ? y1 - 0.4 : (y0 + y1) / 2;
      const ya = Math.max(y0 + 0.03, ym - bar / 2);
      kit.handle(METAL, w / 2 - 0.0525, (ya + Math.min(y1 - 0.03, ya + bar)) / 2, Math.min(y1 - 0.03, ya + bar) - ya, true, doorFace, d / 2 - doorFace);
    }
    return kit.build();
  },
};
