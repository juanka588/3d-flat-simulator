import { z } from 'zod';
import type { Generator } from '../catalog';
import { ITEM_MATERIALS } from '../item-materials';
import { FRONT, HANDLE, Kit, addFronts, boxAnchors, count, finish, finishMaterial, metres } from './kit';

/** Shelves, tables, seating and beds. */

// ---------------------------------------------------------------------------------------------
// Bookshelf
// ---------------------------------------------------------------------------------------------

const bookshelfParams = z.strictObject({
  w: metres('Overall width of the bookshelf.', 0.8, 0.3, 3),
  d: metres('Overall depth of the bookshelf (front to back).', 0.3, 0.15, 0.6),
  h: metres('Overall height of the bookshelf.', 1.8, 0.5, 2.8),
  shelves: count('Number of interior shelves (compartments = shelves + 1).', 4, 0, 12),
  finish: finish('white'),
});
type BookshelfParams = z.infer<typeof bookshelfParams>;

export const bookshelf: Generator<BookshelfParams> = {
  id: 'bookshelf',
  label: 'Open bookshelf',
  category: 'shelf',
  params: bookshelfParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.6, back: 0 } }),
  generate({ w, d, h, shelves, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    const t = 0.022;
    const back = 0.008;
    kit.box(mat, -w / 2, 0, -d / 2, -w / 2 + t, h, d / 2);
    kit.box(mat, w / 2 - t, 0, -d / 2, w / 2, h, d / 2);
    kit.box(mat, -w / 2 + t, h - t, -d / 2, w / 2 - t, h, d / 2);
    kit.box(mat, -w / 2 + t, 0, -d / 2, w / 2 - t, t, d / 2);
    kit.box(mat, -w / 2 + t, t, -d / 2, w / 2 - t, h - t, -d / 2 + back);
    const gap = (h - 2 * t) / (shelves + 1);
    for (let i = 1; i <= shelves; i++) {
      const y = t + i * gap;
      kit.box(mat, -w / 2 + t, y - t / 2, -d / 2 + back, w / 2 - t, y + t / 2, d / 2 - 0.01);
    }
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------------------------

const tableParams = z.strictObject({
  w: metres('Width of the table top.', 1.4, 0.4, 4),
  d: metres('Depth of the table top.', 0.8, 0.4, 2),
  h: metres('Overall height of the table (dining tables are about 0.75).', 0.75, 0.3, 1.2),
  legs: z
    .union([z.literal(1), z.literal(2), z.literal(4)])
    .default(4)
    .describe('Base style: 4 = a leg at each corner, 2 = two panel legs at the ends, 1 = a central pedestal. Defaults to 4.'),
  finish: finish('wood'),
});
type TableParams = z.infer<typeof tableParams>;

export const table: Generator<TableParams> = {
  id: 'table',
  label: 'Table (dining / coffee) with corner legs, end panels or a pedestal',
  category: 'table',
  params: tableParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.7, back: 0.7, left: 0.7, right: 0.7 } }),
  generate({ w, d, h, legs, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    const top = 0.03;
    const yt = h - top;
    kit.box(mat, -w / 2, yt, -d / 2, w / 2, h, d / 2);
    if (legs === 4) {
      const s = Math.min(0.06, w / 6, d / 6);
      const m = Math.min(0.05, w / 10);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const x0 = sx < 0 ? -w / 2 + m : w / 2 - m - s;
          const z0 = sz < 0 ? -d / 2 + m : d / 2 - m - s;
          kit.box(ITEM_MATERIALS.wood, x0, 0, z0, x0 + s, yt, z0 + s);
        }
      }
    } else if (legs === 2) {
      const t = 0.04;
      const m = Math.min(0.08, w / 8);
      const dz = d * 0.8;
      kit.box(ITEM_MATERIALS.wood, -w / 2 + m, 0, -dz / 2, -w / 2 + m + t, yt, dz / 2);
      kit.box(ITEM_MATERIALS.wood, w / 2 - m - t, 0, -dz / 2, w / 2 - m, yt, dz / 2);
      kit.box(ITEM_MATERIALS.wood, -w / 2 + m + t, yt - 0.08, -0.02, w / 2 - m - t, yt - 0.04, 0.02);
    } else {
      const bw = Math.min(0.6, w * 0.8);
      const bd = Math.min(0.5, d * 0.8);
      const post = Math.min(0.1, bw / 3, bd / 3);
      kit.box(ITEM_MATERIALS.metal, -bw / 2, 0, -bd / 2, bw / 2, 0.03, bd / 2);
      kit.box(ITEM_MATERIALS.metal, -post / 2, 0.03, -post / 2, post / 2, yt, post / 2);
    }
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Chair
// ---------------------------------------------------------------------------------------------

const chairParams = z.strictObject({
  w: metres('Width of the chair.', 0.45, 0.3, 0.9),
  d: metres('Depth of the chair (front to back).', 0.5, 0.3, 0.9),
  h: metres('Overall height of the chair including the backrest.', 0.85, 0.75, 1.3),
  seat: metres('Height of the seat above the floor (must leave 0.2 m for the backrest).', 0.45, 0.3, 0.55),
  finish: finish('wood'),
});
type ChairParams = z.infer<typeof chairParams>;

export const chair: Generator<ChairParams> = {
  id: 'chair',
  label: 'Dining chair with backrest at the back (-z)',
  category: 'chair',
  params: chairParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.6, back: 0.2 } }),
  generate({ w, d, h, seat, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    const t = 0.04;
    const seatT = 0.04;
    const m = 0.02;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x0 = sx < 0 ? -w / 2 + m : w / 2 - m - t;
        const z0 = sz < 0 ? -d / 2 : d / 2 - m - t;
        // Back legs continue up as the backrest posts.
        kit.box(mat, x0, 0, z0, x0 + t, sz < 0 ? h : seat - seatT, z0 + t);
      }
    }
    kit.box(ITEM_MATERIALS.fabric, -w / 2, seat - seatT, -d / 2, w / 2, seat, d / 2);
    kit.box(mat, -w / 2 + m + t, h - 0.14, -d / 2, w / 2 - m - t, h - 0.02, -d / 2 + t);
    kit.box(mat, -w / 2 + m + t, seat + 0.1, -d / 2, w / 2 - m - t, seat + 0.2, -d / 2 + t);
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Sofa
// ---------------------------------------------------------------------------------------------

const sofaParams = z.strictObject({
  w: metres('Overall width of the sofa including both arms.', 2.1, 0.6, 4),
  d: metres('Overall depth of the sofa (front to back).', 0.95, 0.6, 1.4),
  h: metres('Overall height of the sofa up to the top of the backrest.', 0.85, 0.7, 1.1),
  seats: count('Number of seat cushions (1 = armchair).', 3, 1, 6),
});
type SofaParams = z.infer<typeof sofaParams>;

export const sofa: Generator<SofaParams> = {
  id: 'sofa',
  label: 'Sofa / armchair with arms, backrest and seat cushions',
  category: 'sofa',
  params: sofaParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.7, back: 0 } }),
  generate({ w, d, h, seats }) {
    const kit = new Kit();
    const leg = 0.1;
    const arm = Math.min(0.16, w / 5);
    const backT = Math.min(0.22, d / 3);
    const seatTop = Math.min(0.5, h * 0.6);
    const armTop = Math.min(h, seatTop + 0.15);
    const F = ITEM_MATERIALS.fabric;
    // Legs.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x0 = sx < 0 ? -w / 2 + 0.05 : w / 2 - 0.05 - 0.04;
        const z0 = sz < 0 ? -d / 2 + 0.05 : d / 2 - 0.05 - 0.04;
        kit.box(ITEM_MATERIALS.metal, x0, 0, z0, x0 + 0.04, leg, z0 + 0.04);
      }
    }
    kit.box(F, -w / 2, leg, -d / 2, w / 2, seatTop - 0.12, d / 2); // base
    kit.box(F, -w / 2, leg, -d / 2, -w / 2 + arm, armTop, d / 2); // arms
    kit.box(F, w / 2 - arm, leg, -d / 2, w / 2, armTop, d / 2);
    kit.box(F, -w / 2 + arm, leg, -d / 2, w / 2 - arm, h, -d / 2 + backT); // backrest
    const cw = (w - 2 * arm) / seats;
    for (let i = 0; i < seats; i++) {
      const x0 = -w / 2 + arm + i * cw;
      kit.box(F, x0 + 0.003, seatTop - 0.12, -d / 2 + backT, x0 + cw - 0.003, seatTop, d / 2);
    }
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Desk
// ---------------------------------------------------------------------------------------------

const deskParams = z.strictObject({
  w: metres('Width of the desk top.', 1.4, 0.6, 3),
  d: metres('Depth of the desk top.', 0.7, 0.4, 1.2),
  h: metres('Overall height of the desk (about 0.75).', 0.75, 0.6, 1.2),
  drawers: count('Number of drawers in the pedestal under the right end (0 = two panel legs, no pedestal).', 2, 0, 4),
  finish: finish('wood'),
});
type DeskParams = z.infer<typeof deskParams>;

export const desk: Generator<DeskParams> = {
  id: 'desk',
  label: 'Desk with panel legs and optional drawer pedestal',
  category: 'desk',
  params: deskParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.9, back: 0 } }),
  generate({ w, d, h, drawers, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    const top = 0.03;
    const yt = h - top;
    const t = 0.03;
    kit.box(mat, -w / 2, yt, -d / 2, w / 2, h, d / 2);
    kit.box(mat, -w / 2 + 0.02, 0, -d / 2 + 0.03, -w / 2 + 0.02 + t, yt, d / 2 - 0.03); // left panel leg
    kit.box(mat, -w / 2 + 0.05, yt - 0.25, -d / 2 + 0.05, w / 2 - 0.05, yt, -d / 2 + 0.05 + 0.015); // modesty panel
    if (drawers === 0) {
      kit.box(mat, w / 2 - 0.02 - t, 0, -d / 2 + 0.03, w / 2 - 0.02, yt, d / 2 - 0.03);
    } else {
      const pw = Math.min(0.45, w * 0.4);
      const zFace = d / 2 - 0.03 - HANDLE;
      kit.box(mat, w / 2 - 0.02 - pw, 0.0, -d / 2 + 0.03, w / 2 - 0.02, yt, zFace - FRONT);
      addFronts(kit, { x0: w / 2 - 0.02 - pw, x1: w / 2 - 0.02, y0: 0.02, y1: yt, zFace, doors: 0, drawers, frontMaterial: mat });
    }
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Bed
// ---------------------------------------------------------------------------------------------

const bedParams = z.strictObject({
  w: metres('Width of the bed frame (a 160 cm double bed is 1.6 wide).', 1.6, 0.7, 2.4),
  l: metres('Length of the bed frame, head to foot (the item depth).', 2, 1.6, 2.4),
  h: metres('Overall height: the headboard top, or the pillow top when there is no headboard.', 0.9, 0.6, 1.6),
  headboard: z.boolean().default(true).describe('Add a headboard at the back (-z). Defaults to true.'),
});
type BedParams = z.infer<typeof bedParams>;

export const bed: Generator<BedParams> = {
  id: 'bed',
  label: 'Bed with mattress, pillows and optional headboard (head at the back, -z)',
  category: 'bed',
  params: bedParams,
  describeParams: ({ w, l, h }) => ({
    dims: { w, d: l, h },
    anchors: [...boxAnchors(w, l, h), { name: 'head-centre', position: [0, h, -l / 2] }],
    clearance: { front: 0.6, left: 0.6, right: 0.6, back: 0 },
  }),
  generate({ w, l, h, headboard }) {
    const kit = new Kit();
    const leg = 0.12;
    const frameTop = 0.26;
    const mt = headboard ? Math.min(0.55, h - 0.2) : h - 0.1;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x0 = sx < 0 ? -w / 2 : w / 2 - 0.06;
        const z0 = sz < 0 ? -l / 2 : l / 2 - 0.06;
        kit.box(ITEM_MATERIALS.wood, x0, 0, z0, x0 + 0.06, leg, z0 + 0.06);
      }
    }
    kit.box(ITEM_MATERIALS.wood, -w / 2, leg, -l / 2, w / 2, frameTop, l / 2);
    kit.box(ITEM_MATERIALS.bedding, -w / 2 + 0.02, frameTop, -l / 2 + (headboard ? 0.07 : 0.02), w / 2 - 0.02, mt, l / 2 - 0.02);
    if (headboard) kit.box(ITEM_MATERIALS.wood, -w / 2, leg, -l / 2, w / 2, h, -l / 2 + 0.06);
    const pillows = w >= 1.3 ? 2 : 1;
    const pw = Math.min(0.6, (w - 0.1) / pillows - 0.04);
    const z0 = -l / 2 + (headboard ? 0.1 : 0.05);
    for (let i = 0; i < pillows; i++) {
      const cx = ((i + 0.5) / pillows - 0.5) * (w - 0.04);
      kit.box(ITEM_MATERIALS.bedding, cx - pw / 2, mt, z0, cx + pw / 2, mt + 0.1, z0 + 0.35);
    }
    return kit.build();
  },
};
