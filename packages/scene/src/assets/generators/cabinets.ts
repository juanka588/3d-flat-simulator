import { z } from 'zod';
import type { Generator } from '../catalog';
import { ITEM_MATERIALS } from '../item-materials';
import { FRONT, HANDLE, Kit, addFronts, boxAnchors, count, finish, finishMaterial, metres } from './kit';

/** Cabinet-like generators: wardrobe, kitchen base / wall units, sideboard, TV unit, nightstand. */

interface CabinetSpec {
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

function cabinet(kit: Kit, s: CabinetSpec): void {
  const { w, d, h } = s;
  const zFace = d / 2 - HANDLE;
  // A unit with no doors or drawers is a plain panel: the body itself reaches the front.
  const zBodyFront = s.doors + s.drawers === 0 ? d / 2 : zFace - FRONT;
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
  addFronts(kit, { x0: -w / 2, x1: w / 2, y0: s.baseH, y1: bodyTop, zFace, doors: s.doors, drawers: s.drawers, frontMaterial: s.frontMat });
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
  generate({ w, d, h, doors, doorType, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
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
    kit.box(mat, -w / 2, ph, -d / 2, w / 2, h, back);
    const overlap = 0.03;
    const dw = (w + (doors - 1) * overlap) / doors;
    const dh = h - ph;
    for (let i = 0; i < doors; i++) {
      const front = doors === 1 || i % 2 === 1;
      const face = front ? zFace : zFace - FRONT - gapBetween;
      const xa = -w / 2 + i * (dw - overlap);
      kit.box(mat, xa, ph + 0.002, face - FRONT, xa + dw, h - 0.002, face);
      const hx = i < doors - 1 || doors === 1 ? xa + dw - 0.04 : xa + 0.04;
      const ym = ph + dh * 0.5;
      kit.box(ITEM_MATERIALS.metal, hx - 0.006, ym - 0.2, face, hx + 0.006, ym + 0.2, face + (front ? HANDLE : 0.004));
    }
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Kitchen units
// ---------------------------------------------------------------------------------------------

const kitchenBaseParams = z.strictObject({
  w: metres('Width of the module; modules placed edge to edge give a continuous worktop.', 0.6, 0.2, 2.4),
  d: metres('Depth of the module (front to back); standard worktop depth is 0.6.', 0.6, 0.3, 0.9),
  h: metres('Overall height including the worktop; standard is 0.9.', 0.9, 0.5, 1.2),
  doors: count('Number of doors side by side below the drawers (0 for none).', 1, 0, 4),
  drawers: count('Number of drawers stacked at the top (0 for none); with no doors the drawers fill the whole front.', 0, 0, 5),
  worktop: z.boolean().default(true).describe('Add a 4 cm worktop over the full footprint. Defaults to true.'),
  finish: finish('white'),
});
type KitchenBaseParams = z.infer<typeof kitchenBaseParams>;

export const kitchenBase: Generator<KitchenBaseParams> = {
  id: 'kitchenBase',
  label: 'Kitchen base unit (doors and/or drawers, optional worktop)',
  category: 'kitchen',
  params: kitchenBaseParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.9, back: 0 } }),
  generate({ w, d, h, doors, drawers, worktop, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    cabinet(kit, {
      w,
      d,
      h,
      base: 'plinth',
      baseH: 0.1,
      baseMat: ITEM_MATERIALS.metal, // aluminium kick plate: keeps the unit at 3 materials
      bodyMat: mat,
      frontMat: mat,
      doors,
      drawers,
      ...(worktop ? { topT: 0.04, topMat: ITEM_MATERIALS.worktop } : {}),
    });
    return kit.build();
  },
};

const kitchenWallParams = z.strictObject({
  w: metres('Width of the wall unit.', 0.6, 0.2, 2.4),
  d: metres('Depth of the wall unit (front to back); standard is 0.35.', 0.35, 0.2, 0.6),
  h: metres('Height of the unit body; standard is 0.7. Hang it with the item elevation.', 0.7, 0.3, 1.2),
  doors: count('Number of doors side by side.', 1, 1, 4),
  finish: finish('white'),
});
type KitchenWallParams = z.infer<typeof kitchenWallParams>;

export const kitchenWall: Generator<KitchenWallParams> = {
  id: 'kitchenWall',
  label: 'Kitchen wall unit (hung; set the item mount to "wall")',
  category: 'wall_cabinet',
  params: kitchenWallParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.3, back: 0 } }),
  generate({ w, d, h, doors, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    cabinet(kit, { w, d, h, base: 'none', baseH: 0, baseMat: mat, bodyMat: mat, frontMat: mat, doors, drawers: 0 });
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
