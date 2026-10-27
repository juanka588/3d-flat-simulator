import { z } from 'zod';
import type { Generator } from '../catalog';
import { ITEM_MATERIALS } from '../item-materials';
import { Kit, boxAnchors, finish, finishMaterial, metres } from './kit';

/** Mirror, rug and the wall-mounted TV. */

// ---------------------------------------------------------------------------------------------
// Mirror
// ---------------------------------------------------------------------------------------------

/** Depth of a framed mirror, in metres. */
export const MIRROR_DEPTH = 0.03;

const mirrorParams = z.strictObject({
  w: metres('Width of the mirror including its frame.', 0.6, 0.2, 2),
  h: metres('Height of the mirror including its frame.', 1.6, 0.2, 2.4),
  frame: metres('Width of the frame border.', 0.03, 0.005, 0.1),
  finish: finish('wood'),
});
type MirrorParams = z.infer<typeof mirrorParams>;

export const mirror: Generator<MirrorParams> = {
  id: 'mirror',
  label: 'Framed mirror, 3 cm deep (hang it with the item elevation, mount "wall")',
  category: 'mirror',
  params: mirrorParams,
  describeParams: ({ w, h }) => ({ dims: { w, d: MIRROR_DEPTH, h }, anchors: boxAnchors(w, MIRROR_DEPTH, h), clearance: { front: 0.3, back: 0 } }),
  generate({ w, h, frame, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    const d = MIRROR_DEPTH;
    const fr = Math.min(frame, w / 2 - 0.01, h / 2 - 0.01);
    kit.box(mat, -w / 2, 0, -d / 2, -w / 2 + fr, h, d / 2);
    kit.box(mat, w / 2 - fr, 0, -d / 2, w / 2, h, d / 2);
    kit.box(mat, -w / 2 + fr, 0, -d / 2, w / 2 - fr, fr, d / 2);
    kit.box(mat, -w / 2 + fr, h - fr, -d / 2, w / 2 - fr, h, d / 2);
    kit.box(ITEM_MATERIALS.mirror, -w / 2 + fr, fr, -d / 2 + 0.005, w / 2 - fr, h - fr, d / 2 - 0.008);
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Rug
// ---------------------------------------------------------------------------------------------

/** Thickness of a rug, in metres. */
export const RUG_THICKNESS = 0.012;

const rugParams = z.strictObject({
  w: metres('Width of the rug.', 2, 0.3, 6),
  d: metres('Depth of the rug.', 1.4, 0.3, 6),
});
type RugParams = z.infer<typeof rugParams>;

export const rug: Generator<RugParams> = {
  id: 'rug',
  label: 'Flat rug, 1.2 cm thick, with a border',
  category: 'rug',
  params: rugParams,
  describeParams: ({ w, d }) => ({ dims: { w, d, h: RUG_THICKNESS }, anchors: boxAnchors(w, d, RUG_THICKNESS), clearance: {} }),
  generate({ w, d }) {
    const kit = new Kit();
    const b = Math.min(0.06, w / 4, d / 4);
    kit.box(ITEM_MATERIALS.rug, -w / 2, 0, -d / 2, w / 2, 0.008, d / 2);
    kit.box(ITEM_MATERIALS.bedding, -w / 2 + b, 0.008, -d / 2 + b, w / 2 - b, RUG_THICKNESS, d / 2 - b);
    kit.box(ITEM_MATERIALS.rug, -w / 2, 0.008, -d / 2, w / 2, RUG_THICKNESS, -d / 2 + b);
    kit.box(ITEM_MATERIALS.rug, -w / 2, 0.008, d / 2 - b, w / 2, RUG_THICKNESS, d / 2);
    kit.box(ITEM_MATERIALS.rug, -w / 2, 0.008, -d / 2 + b, -w / 2 + b, RUG_THICKNESS, d / 2 - b);
    kit.box(ITEM_MATERIALS.rug, w / 2 - b, 0.008, -d / 2 + b, w / 2, RUG_THICKNESS, d / 2 - b);
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// TV
// ---------------------------------------------------------------------------------------------

/** Diagonal of a 55 inch screen: 55 x 0.0254 m. */
export const TV_55_DIAGONAL_M = 55 * 0.0254;
/** Thin bezel: 6 mm at the sides, 12.5 mm above and below the panel. */
const TV_BEZEL_SIDE = 0.006;
const TV_BEZEL_VERTICAL = 0.0125;
const TV_D = 0.05;

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Visible 16:9 panel and the overall outer dims of a TV of `inches` diagonal. */
export function tvDims(inches: number): { screenW: number; screenH: number; w: number; d: number; h: number } {
  const diagonal = inches * 0.0254;
  const screenW = (diagonal * 16) / Math.hypot(16, 9);
  const screenH = (diagonal * 9) / Math.hypot(16, 9);
  return { screenW, screenH, w: round3(screenW + 2 * TV_BEZEL_SIDE), d: TV_D, h: round3(screenH + 2 * TV_BEZEL_VERTICAL) };
}

const tvParams = z.strictObject({
  diagonal: z.number().min(20).max(100).default(55).describe('Screen diagonal in inches, 20-100. Defaults to 55.'),
});
type TvParams = z.infer<typeof tvParams>;

export const tv: Generator<TvParams> = {
  id: 'tv',
  label: 'Flat-screen TV on a wall bracket, 5 cm deep (mount "wall"); builtin:tv-55 is the 55 inch one',
  category: 'appliance',
  params: tvParams,
  describeParams: ({ diagonal }) => {
    const { w, d, h } = tvDims(diagonal);
    return { dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 1.5, back: 0 } };
  },
  generate({ diagonal }) {
    const kit = new Kit();
    const { screenW, screenH, w, d, h } = tvDims(diagonal);
    const back = -d / 2;
    // Layers along local z: bracket plate (back 1.5 cm), body (3 cm), screen proud of the body (5 mm).
    const bracketFront = back + 0.015;
    const bodyFront = d / 2 - 0.005;
    kit.box(ITEM_MATERIALS.tvBody, -0.1, h / 2 - 0.1, back, 0.1, h / 2 + 0.1, bracketFront);
    kit.box(ITEM_MATERIALS.tvBody, -w / 2, 0, bracketFront, w / 2, h, bodyFront);
    kit.box(ITEM_MATERIALS.tvScreen, -screenW / 2, (h - screenH) / 2, bodyFront, screenW / 2, (h + screenH) / 2, d / 2);
    return kit.build();
  },
};
