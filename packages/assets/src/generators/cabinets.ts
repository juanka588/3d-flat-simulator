import { z } from 'zod';
import type { Generator } from '@flat/scene';
import { ITEM_MATERIALS } from '../materials/item-materials';
import { FRONT, HANDLE, Kit, addFronts, boxAnchors, count, finish, finishMaterial, metres, type Finish } from './kit';

/** Cabinet-like generators: wardrobe, kitchen base / wall units, sideboard, TV unit, nightstand. */

export interface CabinetSpec {
  w: number;
  d: number;
  h: number;
  base: 'none' | 'plinth' | 'legs';
  baseH: number;
  baseMat: string;
  bodyMat: string;
  frontMat: string;
  doors: number;
  drawers: number;
  /** Worktop thickness; the top slab spans the full footprint. */
  topT?: number;
  topMat?: string;
}

export function cabinet(kit: Kit, s: CabinetSpec): void {
  const { w, d, h } = s;
  const zFace = d / 2 - HANDLE;
  const narrow = w < 0.2; // too narrow for fronts and handles: a plain panel
  // A unit with no doors or drawers is a plain panel: the body itself reaches the front.
  const zBodyFront = s.doors + s.drawers === 0 || narrow ? d / 2 : zFace - FRONT; // too narrow for fronts: a plain panel
  const bodyTop = s.topT ? h - s.topT : h;
  if (s.base === 'plinth') {
    kit.box(s.baseMat, -w / 2, 0, -d / 2 + 0.02, w / 2, s.baseH, zBodyFront - 0.03);
  } else if (s.base === 'legs') {
    const t = 0.04;
    const m = 0.03;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x0 = sx < 0 ? -w / 2 + m : w / 2 - m - t;
        const z0 = sz < 0 ? -d / 2 + m : zBodyFront - m - t;
        kit.box(s.baseMat, x0, 0, z0, x0 + t, s.baseH, z0 + t);
      }
    }
  }
  kit.box(s.bodyMat, -w / 2, s.baseH, -d / 2, w / 2, bodyTop, zBodyFront);
  if (s.topT && s.topMat) kit.box(s.topMat, -w / 2, bodyTop, -d / 2, w / 2, h, d / 2);
  if (!narrow) addFronts(kit, { x0: -w / 2, x1: w / 2, y0: s.baseH, y1: bodyTop, zFace, doors: s.doors, drawers: s.drawers, frontMaterial: s.frontMat });
}

// ---------------------------------------------------------------------------------------------
// Wardrobe
// ---------------------------------------------------------------------------------------------

const wardrobeParams = z.strictObject({
  w: metres('Overall width of the wardrobe.', 1.8, 0.4, 5),
  d: metres('Overall depth of the wardrobe (front to back).', 0.6, 0.3, 1),
  h: metres('Overall height of the wardrobe.', 2.4, 1, 3),
  doors: count('Number of doors across the front.', 3, 1, 8),
  doorType: z.enum(['hinged', 'sliding']).default('sliding').describe('"hinged" doors swing open (need front clearance); "sliding" doors glide past each other. Defaults to "sliding".'),
  finish: finish('white'),
  style: z.enum(['cabinet', 'builtin']).default('cabinet').describe('"cabinet" is a freestanding wardrobe (carcass, sides, top, back). "builtin" is a closet in the wall: no carcass, only the sliding doors in their top and bottom tracks plus white shelves (and an optional hanging rail) spanning the whole cavity between the walls; w x d is that cavity. Defaults to "cabinet".'),
  doorW: z.number().min(0.3).max(5).optional().describe('Builtin only: width of the door opening (default: all of w). The shelves still run wall to wall behind the stub that hides the rest.'),
  doorShift: z.number().min(-2.5).max(2.5).default(0).describe('Builtin only: offset (m, along the item x axis) of the door opening centre from the cavity centre. Defaults to 0.'),
  doorProud: z.number().min(0).max(0.3).default(0).describe('Builtin only: how far the door plane stands in front of the cavity footprint (m), e.g. to reach the wall face past a jamb stub. Defaults to 0.'),
  shelves: count('Builtin only: number of white shelves, the top one at about 2.0 m (at least 1).', 4, 1, 8),
  rail: z.boolean().default(false).describe('Builtin only: a hanging rail under the top shelf. Defaults to false.'),
});
type WardrobeParams = z.infer<typeof wardrobeParams>;

export const wardrobe: Generator<WardrobeParams> = {
  id: 'wardrobe',
  label: 'Wardrobe / built-in closet (hinged or sliding doors)',
  category: 'wardrobe',
  params: wardrobeParams,
  describeParams: ({ w, d, h, doors, doorType }) => ({
    dims: { w, d, h },
    anchors: boxAnchors(w, d, h),
    clearance: { front: doorType === 'hinged' ? Math.min(0.9, Math.max(0.3, w / doors)) : 0.6, back: 0 },
  }),
  generate({ w, d, h, doors, doorType, finish: f, style, doorW, doorShift, doorProud, shelves, rail }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    if (style === 'builtin') {
      builtinCloset(kit, { w, d, h, doors, finish: f, doorW: doorW ?? w, doorShift, doorProud, shelves, rail });
      return kit.build();
    }
    const ph = Math.min(0.06, h * 0.05);
    const zFace = d / 2 - HANDLE;
    if (doorType === 'hinged') {
      cabinet(kit, { w, d, h, base: 'plinth', baseH: ph, baseMat: ITEM_MATERIALS.dark, bodyMat: mat, frontMat: mat, doors, drawers: 0 });
      return kit.build();
    }
    // Sliding: the body stops behind two door layers (tracks); every door overlaps its neighbour by 3 cm.
    const gapBetween = 0.004;
    const back = zFace - 2 * FRONT - gapBetween;
    kit.box(ITEM_MATERIALS.dark, -w / 2 + 0.02, 0, -d / 2 + 0.02, w / 2 - 0.02, ph, back - 0.02);
    kit.box(f === 'grey' ? ITEM_MATERIALS.white : mat, -w / 2, ph, -d / 2, w / 2, h, back);
    const overlap = 0.03;
    const dw = (w + (doors - 1) * overlap) / doors;
    const dh = h - ph;
    for (let i = 0; i < doors; i++) {
      const front = doors === 1 || i % 2 === 1;
      const face = front ? zFace : zFace - FRONT - gapBetween;
      const xa = -w / 2 + i * (dw - overlap);
      if (f === 'grey') {
        // Matt grey panel in thin anodised-aluminium profiles (top and bottom rails, side stiles), the panel set back 2 mm.
        const pr = 0.022;
        const alu = ITEM_MATERIALS.aluminium;
        kit.box(mat, xa + 0.016, ph + 0.002 + pr, face - FRONT, xa + dw - 0.016, h - 0.002 - pr, face - 0.002, 0);
        kit.box(alu, xa, ph + 0.002, face - FRONT, xa + dw, ph + 0.002 + pr, face, 0.001);
        kit.box(alu, xa, h - 0.002 - pr, face - FRONT, xa + dw, h - 0.002, face, 0.001);
        kit.box(alu, xa, ph + 0.002 + pr, face - FRONT, xa + 0.016, h - 0.002 - pr, face, 0.001);
        kit.box(alu, xa + dw - 0.016, ph + 0.002 + pr, face - FRONT, xa + dw, h - 0.002 - pr, face, 0.001);
      } else {
        kit.box(mat, xa, ph + 0.002, face - FRONT, xa + dw, h - 0.002, face);
      }
      const hx = i < doors - 1 || doors === 1 ? xa + dw - 0.04 : xa + 0.04;
      const ym = ph + dh * 0.5;
      kit.handle(ITEM_MATERIALS.metal, hx, ym, 0.4, true, face, front ? HANDLE : 0.004);
    }
    return kit.build();
  },
};

/**
 * A closet built into the wall: no carcass (the room walls are the sides, back and top). Footprint `w x d` is the cavity;
 * the sliding doors (two layers in an aluminium top and bottom track) span `doorW` at the front, floor to ceiling, and
 * white shelves (plus an optional hanging rail) run wall to wall behind them.
 */
function builtinCloset(kit: Kit, s: { w: number; d: number; h: number; doors: number; finish: Finish; doorW: number; doorShift: number; doorProud: number; shelves: number; rail: boolean }): void {
  const { w, d, h, doors, doorW, doorShift, doorProud } = s;
  const mat = finishMaterial(s.finish);
  const alu = ITEM_MATERIALS.aluminium;
  const gap = 0.004;
  const zFront = d / 2 + doorProud; // outer face of the front door layer
  const zBackDoor = zFront - 2 * FRONT - gap; // inner face of the rear door layer
  const dW = Math.min(doorW, w);
  const shift = Math.max(-(w - dW) / 2, Math.min((w - dW) / 2, doorShift)); // the opening stays inside the cavity
  const dx0 = shift - dW / 2;
  const dx1 = shift + dW / 2;
  const trackB = 0.02;
  const trackT = 0.03;
  // Tracks: a shallow aluminium channel under and over the two door layers.
  kit.box(alu, dx0, 0, zBackDoor - 0.006, dx1, trackB, zFront);
  kit.box(alu, dx0, h - trackT, zBackDoor - 0.006, dx1, h, zFront);
  const overlap = 0.03;
  const dw = (dx1 - dx0 + (doors - 1) * overlap) / doors;
  const y0 = trackB + 0.002;
  const y1 = h - trackT - 0.002;
  for (let i = 0; i < doors; i++) {
    const front = doors === 1 || i % 2 === 1;
    const face = front ? zFront : zFront - FRONT - gap;
    const xa = dx0 + i * (dw - overlap);
    if (s.finish === 'grey') {
      const pr = 0.022;
      kit.box(mat, xa + 0.016, y0 + pr, face - FRONT, xa + dw - 0.016, y1 - pr, face - 0.002, 0);
      kit.box(alu, xa, y0, face - FRONT, xa + dw, y0 + pr, face, 0.001);
      kit.box(alu, xa, y1 - pr, face - FRONT, xa + dw, y1, face, 0.001);
      kit.box(alu, xa, y0 + pr, face - FRONT, xa + 0.016, y1 - pr, face, 0.001);
      kit.box(alu, xa + dw - 0.016, y0 + pr, face - FRONT, xa + dw, y1 - pr, face, 0.001);
    } else {
      kit.box(mat, xa, y0, face - FRONT, xa + dw, y1, face);
    }
  }
  // Shelves: white boards wall to wall. Behind the doors they stop at the rear door layer; the hidden part beside the
  // door opening (behind a jamb stub) reaches the cavity front when the doors stand proud of it.
  const t = 0.025;
  const top = Math.min(2.0, h - 0.4);
  const doorFront = zBackDoor - 0.006;
  const hiddenFront = doorProud > 0 ? d / 2 : doorFront;
  const shelfAt = (y: number) => {
    kit.box(ITEM_MATERIALS.white, -w / 2, y - t, -d / 2, w / 2, y, hiddenFront);
    if (doorFront > hiddenFront) kit.box(ITEM_MATERIALS.white, dx0, y - t, hiddenFront, dx1, y, doorFront);
  };
  for (let i = 0; i < s.shelves; i++) shelfAt(i === 0 ? top : top - (i * (top - 0.35)) / s.shelves);
  if (s.rail) kit.tube(alu, [-w / 2, top - t - 0.07, 0], [w / 2, top - t - 0.07, 0], 0.0125, 8);
}

// ---------------------------------------------------------------------------------------------
// Kitchen units
// ---------------------------------------------------------------------------------------------

const kitchenBaseParams = z.strictObject({
  w: metres('Width of the module (down to 1 cm for a slim end panel with doors 0 and drawers 0); modules placed edge to edge give a continuous worktop.', 0.6, 0.01, 2.4),
  d: metres('Depth of the module (front to back); standard worktop depth is 0.6.', 0.6, 0.3, 0.9),
  h: metres('Overall height including the worktop; standard is 0.9.', 0.9, 0.5, 1.2),
  doors: count('Number of doors side by side below the drawers (0 for none).', 1, 0, 4),
  drawers: count('Number of drawers stacked at the top (0 for none); with no doors the drawers fill the whole front.', 0, 0, 5),
  worktop: z.boolean().default(true).describe('Add a 4 cm worktop over the full footprint. Defaults to true.'),
  worktopFinish: z.enum(['quartz', 'concrete']).default('quartz').describe('Worktop look: "quartz" (polished light stone) or "concrete" (light grey concrete effect). Defaults to "quartz".'),
  finish: finish('white'),
});
type KitchenBaseParams = z.infer<typeof kitchenBaseParams>;

export const kitchenBase: Generator<KitchenBaseParams> = {
  id: 'kitchenBase',
  label: 'Kitchen base unit (doors and/or drawers, optional worktop)',
  category: 'kitchen',
  params: kitchenBaseParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.9, back: 0 } }),
  generate({ w, d, h, doors, drawers, worktop, worktopFinish, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    cabinet(kit, {
      w,
      d,
      h,
      base: 'plinth',
      baseH: 0.1,
      baseMat: ITEM_MATERIALS.dark, // dark kick plate (the same dark as the reveal behind the fronts)
      bodyMat: mat,
      frontMat: mat,
      doors,
      drawers,
      ...(worktop ? { topT: 0.04, topMat: worktopFinish === 'concrete' ? ITEM_MATERIALS.concreteLight : ITEM_MATERIALS.worktop } : {}),
    });
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Kitchen island
// ---------------------------------------------------------------------------------------------

const islandParams = z.strictObject({
  w: metres('Length of the island (its worktop).', 1.26, 0.6, 3.5),
  d: metres('Depth of the island including the seating overhang.', 0.77, 0.5, 1.6),
  h: metres('Overall height including the worktop; standard is 0.9.', 0.9, 0.5, 1.2),
  overhang: metres('Worktop overhang at the back (-z) for stools, 0 for none. Clamped so a cabinet at least 0.3 m deep remains.', 0.25, 0, 0.5),
  doors: count('Number of doors side by side below the drawers on the front (+z), 0 for none.', 2, 0, 6),
  drawers: count('Number of drawers at the top of the front (0 for none).', 0, 0, 5),
  finish: finish('white'),
});
type IslandParams = z.infer<typeof islandParams>;

export const island: Generator<IslandParams> = {
  id: 'island',
  label: 'Kitchen island: base cabinets with a full-footprint worktop and a stool overhang at the back (-z)',
  category: 'kitchen',
  params: islandParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.9, back: 0.6, left: 0.6, right: 0.6 } }),
  generate({ w, d, h, overhang, doors, drawers, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    const over = Math.max(0, Math.min(overhang, d - 0.3));
    const baseH = 0.1;
    const topT = 0.04;
    const bodyTop = h - topT;
    const z0 = -d / 2 + over; // back of the cabinet body
    const zFace = d / 2 - HANDLE;
    const zBodyFront = doors + drawers === 0 ? d / 2 : zFace - FRONT;
    kit.box(ITEM_MATERIALS.dark, -w / 2, 0, z0 + 0.02, w / 2, baseH, zBodyFront - 0.03);
    kit.box(mat, -w / 2, baseH, z0, w / 2, bodyTop, zBodyFront);
    // End panels carry the overhang.
    if (over > 0.05) {
      const t = Math.min(0.03, w / 10);
      kit.box(mat, -w / 2, baseH, -d / 2, -w / 2 + t, bodyTop, z0);
      kit.box(mat, w / 2 - t, baseH, -d / 2, w / 2, bodyTop, z0);
    }
    kit.box(ITEM_MATERIALS.worktop, -w / 2, bodyTop, -d / 2, w / 2, h, d / 2);
    addFronts(kit, { x0: -w / 2, x1: w / 2, y0: baseH, y1: bodyTop, zFace, doors, drawers, frontMaterial: mat });
    return kit.build();
  },
};

const kitchenWallParams = z.strictObject({
  w: metres('Width of the wall unit.', 0.6, 0.2, 2.4),
  d: metres('Depth of the wall unit (front to back); standard is 0.35.', 0.35, 0.2, 0.6),
  h: metres('Height of the unit body; standard is 0.7. Hang it with the item elevation.', 0.7, 0.3, 1.2),
  doors: count('Number of doors side by side.', 1, 1, 4),
  glassStrip: z.boolean().default(false).describe('Lay a horizontal smoked-glass strip across the doors (the flat\'s wall units). Defaults to false.'),
  niches: count('0 for a closed unit with doors; 1 or more makes an open shelf unit in the finish colour with that many stacked cubbies (no doors).', 0, 0, 6),
  finish: finish('white'),
});
type KitchenWallParams = z.infer<typeof kitchenWallParams>;

export const kitchenWall: Generator<KitchenWallParams> = {
  id: 'kitchenWall',
  label: 'Kitchen wall unit (hung; set the item mount to "wall")',
  category: 'wall_cabinet',
  params: kitchenWallParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.3, back: 0 } }),
  generate({ w, d, h, doors, glassStrip, niches, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    if (niches > 0) {
      // open shelf unit: shell of 18 mm panels with (niches - 1) shelves
      const t = Math.min(0.018, w / 4);
      const B = mat;
      kit.box(B, -w / 2, 0, -d / 2, w / 2, h, -d / 2 + 0.01); // back
      kit.box(B, -w / 2, 0, -d / 2 + 0.01, -w / 2 + t, h, d / 2);
      kit.box(B, w / 2 - t, 0, -d / 2 + 0.01, w / 2, h, d / 2);
      kit.box(B, -w / 2 + t, 0, -d / 2 + 0.01, w / 2 - t, t, d / 2);
      kit.box(B, -w / 2 + t, h - t, -d / 2 + 0.01, w / 2 - t, h, d / 2);
      for (let i = 1; i < niches; i++) {
        const y = (h * i) / niches;
        kit.box(B, -w / 2 + t, y - t / 2, -d / 2 + 0.01, w / 2 - t, y + t / 2, d / 2);
      }
      return kit.build();
    }
    cabinet(kit, { w, d, h, base: 'none', baseH: 0, baseMat: mat, bodyMat: mat, frontMat: mat, doors, drawers: 0 });
    if (glassStrip) {
      // a smoked-glass band in front of the doors, from 55% to 75% of the height (inside the handle depth, so the box stays exact)
      const zFace = d / 2 - HANDLE;
      kit.box(ITEM_MATERIALS.glassSmoked, -w / 2 + 0.02, h * 0.55, zFace, w / 2 - 0.02, h * 0.75, zFace + 0.003, 0);
    }
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Sideboard, TV unit, nightstand
// ---------------------------------------------------------------------------------------------

const sideboardParams = z.strictObject({
  w: metres('Width of the sideboard.', 1.6, 0.6, 3),
  d: metres('Depth of the sideboard (front to back).', 0.45, 0.25, 0.8),
  h: metres('Overall height of the sideboard.', 0.75, 0.4, 1.2),
  doors: count('Number of doors side by side below the drawers.', 2, 0, 6),
  drawers: count('Number of drawers at the top (0 for none).', 0, 0, 4),
  finish: finish('wood'),
});
type SideboardParams = z.infer<typeof sideboardParams>;

export const sideboard: Generator<SideboardParams> = {
  id: 'sideboard',
  label: 'Sideboard / buffet on legs (doors and/or drawers)',
  category: 'sideboard',
  params: sideboardParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.6, back: 0 } }),
  generate({ w, d, h, doors, drawers, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    cabinet(kit, { w, d, h, base: 'legs', baseH: Math.min(0.15, h * 0.3), baseMat: ITEM_MATERIALS.wood, bodyMat: mat, frontMat: mat, doors, drawers });
    return kit.build();
  },
};

const tvUnitParams = z.strictObject({
  w: metres('Width of the TV unit.', 1.5, 0.6, 3),
  d: metres('Depth of the TV unit (front to back).', 0.4, 0.25, 0.7),
  h: metres('Overall height of the TV unit (low, usually 0.4-0.6).', 0.5, 0.25, 1),
  doors: count('Number of doors side by side below the drawers.', 2, 0, 6),
  drawers: count('Number of drawers at the top (0 for none).', 0, 0, 4),
  finish: finish('dark'),
});
type TvUnitParams = z.infer<typeof tvUnitParams>;

export const tvUnit: Generator<TvUnitParams> = {
  id: 'tvUnit',
  label: 'Low TV unit on short legs',
  category: 'tv_unit',
  params: tvUnitParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.5, back: 0 } }),
  generate({ w, d, h, doors, drawers, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    cabinet(kit, { w, d, h, base: 'legs', baseH: Math.min(0.1, h * 0.25), baseMat: ITEM_MATERIALS.metal, bodyMat: mat, frontMat: mat, doors, drawers });
    return kit.build();
  },
};

const nightstandParams = z.strictObject({
  w: metres('Width of the nightstand.', 0.45, 0.25, 0.8),
  d: metres('Depth of the nightstand (front to back).', 0.4, 0.25, 0.6),
  h: metres('Overall height of the nightstand (about the mattress height).', 0.5, 0.3, 0.8),
  drawers: count('Number of drawers.', 2, 1, 4),
  finish: finish('wood'),
});
type NightstandParams = z.infer<typeof nightstandParams>;

export const nightstand: Generator<NightstandParams> = {
  id: 'nightstand',
  label: 'Bedside table with drawers',
  category: 'bedside',
  params: nightstandParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.4, back: 0 } }),
  generate({ w, d, h, drawers, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    cabinet(kit, { w, d, h, base: 'legs', baseH: Math.min(0.12, h * 0.3), baseMat: ITEM_MATERIALS.wood, bodyMat: mat, frontMat: mat, doors: 0, drawers });
    return kit.build();
  },
};
