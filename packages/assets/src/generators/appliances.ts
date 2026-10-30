import { z } from 'zod';
import type { Generator } from '@flat/scene';
import { ITEM_MATERIALS } from '../materials/item-materials';
import { cabinet } from './cabinets';
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
  style: z.enum(['block', 'induction']).default('block').describe('"block" is a hob over an oven; "induction" is a black-glass induction hob set in a concrete worktop over three drawers with black bar handles (the flat\'s kitchen). Defaults to "block".'),
});
type CooktopParams = z.infer<typeof cooktopParams>;

export const cooktop: Generator<CooktopParams> = {
  id: 'cooktop',
  label: 'Cooking block: hob over an oven, sits in a worktop run (French "bloc cuisson")',
  category: 'appliance',
  params: cooktopParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.9, back: 0 } }),
  generate({ w, d, h, burners, style }) {
    const kit = new Kit();
    if (style === 'induction') {
      // Drawer base under a light concrete worktop; the black glass plate stands 6 mm proud of it and sets the overall height.
      const plate = 0.006;
      cabinet(kit, { w, d, h: h - plate, base: 'plinth', baseH: 0.1, baseMat: DARK, bodyMat: ITEM_MATERIALS.concreteDark, frontMat: ITEM_MATERIALS.concreteDark, doors: 0, drawers: 3, topT: 0.04, topMat: ITEM_MATERIALS.concreteLight });
      const px = w / 2 - 0.04;
      const pz0 = -d / 2 + 0.06;
      const pz1 = d / 2 - 0.08;
      kit.box(GLASS, -px, h - plate, pz0, px, h, pz1, 0.001);
      const rx = Math.min(0.09, (px * 2) / 2 / 2.4);
      const rz = Math.min(rx, (pz1 - pz0) / 2 / 2.4);
      const cz = (pz0 + pz1) / 2;
      const spots: [number, number][] = [[-1, -1], [1, 1], [1, -1], [-1, 1]];
      for (const [sx, sz] of spots.slice(0, burners)) {
        const cx = burners === 1 ? 0 : sx * (px / 2);
        const zz = burners === 1 ? cz : cz + sz * ((pz1 - pz0) / 4);
        kit.prism(DARK, cx, h - 0.0005, zz, rx, rz, h + 0.0004);
      }
      return kit.build();
    }
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
  finish: z.enum(['white', 'steel']).default('white').describe('Door finish: "white" (enamel) or "steel" (brushed stainless steel, with a horizontal handle on a bottom freezer drawer). Defaults to "white".'),
});
type FridgeParams = z.infer<typeof fridgeParams>;

export const fridge: Generator<FridgeParams> = {
  id: 'fridge',
  label: 'Fridge or fridge-freezer (door opens to the front)',
  category: 'appliance',
  params: fridgeParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.65, back: 0.05 } }),
  generate({ w, d, h, freezer, finish }) {
    const kit = new Kit();
    const steel = finish === 'steel';
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
    for (const [i, [y0, y1]] of doors.entries()) {
      kit.box(steel ? METAL : W, -w / 2 + gap, y0, doorBack, w / 2 - gap, y1, doorFace);
      if (steel && freezer === 'bottom' && i === 0) {
        // freezer drawer: a horizontal bar along the top of the drawer
        kit.handle(DARK, 0, y1 - 0.05, Math.min(0.5, w - 0.12), false, doorFace, d / 2 - doorFace);
        continue;
      }
      const bar = Math.min(0.5, (y1 - y0) * 0.6);
      const ym = freezer === 'none' ? y1 - 0.4 : (y0 + y1) / 2;
      const ya = Math.max(y0 + 0.03, ym - bar / 2);
      kit.handle(METAL, w / 2 - 0.0525, (ya + Math.min(y1 - 0.03, ya + bar)) / 2, Math.min(y1 - 0.03, ya + bar) - ya, true, doorFace, d / 2 - doorFace);
    }
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Tall oven column (built-in oven and microwave between concrete-effect fronts)
// ---------------------------------------------------------------------------------------------

const ovenColumnParams = z.strictObject({
  w: metres('Width of the column.', 0.6, 0.4, 0.8),
  d: metres('Depth of the column (front to back).', 0.6, 0.5, 0.7),
  h: metres('Overall height of the column.', 2.1, 1.8, 2.5),
  kind: z.enum(['oven', 'larder']).default('oven').describe('"oven" holds a drawer, a built-in oven, a microwave and a lift-up cabinet; "larder" is a pantry column with a tall upper door and a lower door, each with a vertical black bar handle. Defaults to "oven".'),
});
type OvenColumnParams = z.infer<typeof ovenColumnParams>;

export const ovenColumn: Generator<OvenColumnParams> = {
  id: 'ovenColumn',
  label: 'Tall kitchen column with built-in oven and microwave (concrete-effect fronts)',
  category: 'appliance_housing',
  params: ovenColumnParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.9, back: 0 } }),
  generate({ w, d, h, kind }) {
    const kit = new Kit();
    const FRONT_M = ITEM_MATERIALS.concreteDark;
    const baseH = 0.1;
    const zFace = d / 2 - 0.008;
    kit.box(DARK, -w / 2 + 0.02, 0, -d / 2 + 0.02, w / 2 - 0.02, baseH, zFace - 0.05); // plinth
    kit.box(FRONT_M, -w / 2, baseH, -d / 2, w / 2, h, zFace - 0.018); // carcass
    if (kind === 'larder') {
      // lower door up to 0.9 m, tall upper door above it; the handles sit on the oven-column side (the hinges are by the wall)
      const split = baseH + 0.8;
      for (const [a, b] of [[baseH, split], [split, h]] as const) {
        kit.box(FRONT_M, -w / 2 + 0.0015, a + 0.0015, zFace - 0.018, w / 2 - 0.0015, b - 0.0015, zFace);
        const len = Math.min(0.5, (b - a) * 0.5);
        kit.handle(DARK, -w / 2 + 0.04, a === baseH ? b - 0.05 - len / 2 : a + 0.1 + len / 2, len, true, zFace);
      }
      return kit.build();
    }
    // stacked fronts: drawer, oven, microwave, upper door. y positions scale with the height
    const y1 = baseH + 0.4; // drawer top
    const ovenTop = y1 + 0.6;
    const mwTop = ovenTop + 0.36;
    const door = (y0: number, y1_: number) => {
      kit.box(FRONT_M, -w / 2 + 0.0015, y0 + 0.0015, zFace - 0.018, w / 2 - 0.0015, y1_ - 0.0015, zFace);
      kit.handle(DARK, 0, y0 + 0.07, w - 0.12, false, zFace);
    };
    door(baseH, y1);
    // oven and microwave: steel surround, black glass, handle bar
    for (const [a, b] of [[y1, ovenTop], [ovenTop, mwTop]] as const) {
      kit.box(METAL, -w / 2 + 0.01, a + 0.004, zFace - 0.018, w / 2 - 0.01, b - 0.004, zFace - 0.004, 0.002);
      kit.box(GLASS, -w / 2 + 0.05, a + 0.06, zFace - 0.004, w / 2 - 0.05, b - 0.05, zFace, 0.001);
    }
    kit.handle(METAL, 0, ovenTop - 0.035, w - 0.14, false, zFace - 0.004, 0.012);
    door(mwTop, h);
    return kit.build();
  },
};
