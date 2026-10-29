import { z } from 'zod';
import type { Generator } from '@flat/scene';
import { ITEM_MATERIALS } from '../materials/item-materials';
import { tvDims } from '@flat/scene';
import { Kit, boxAnchors, finish, finishMaterial, metres } from './kit';

/** Mirror and the wall-mounted TV (rugs: rug.ts). */

// ---------------------------------------------------------------------------------------------
// Mirror
// ---------------------------------------------------------------------------------------------

/** Depth of a framed mirror, in metres. */
export const MIRROR_DEPTH = 0.03;

const mirrorParams = z.strictObject({
  w: metres('Width of the mirror including its frame.', 0.6, 0.2, 2),
  h: metres('Height of the mirror including its frame.', 1.6, 0.2, 2.4),
  d: metres('Depth of the mirror including its frame.', MIRROR_DEPTH, 0.005, 0.15),
  frame: metres('Width of the frame border.', 0.03, 0.005, 0.1),
  finish: finish('wood'),
});
type MirrorParams = z.infer<typeof mirrorParams>;

export const mirror: Generator<MirrorParams> = {
  id: 'mirror',
  label: 'Framed mirror, 3 cm deep (hang it with the item elevation, mount "wall")',
  category: 'mirror',
  params: mirrorParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.3, back: 0 } }),
  generate({ w, d, h, frame, finish: f }) {
    const kit = new Kit();
    const mat = finishMaterial(f);
    const fr = Math.min(frame, w / 2 - 0.01, h / 2 - 0.01);
    kit.box(mat, -w / 2, 0, -d / 2, -w / 2 + fr, h, d / 2);
    kit.box(mat, w / 2 - fr, 0, -d / 2, w / 2, h, d / 2);
    kit.box(mat, -w / 2 + fr, 0, -d / 2, w / 2 - fr, fr, d / 2);
    kit.box(mat, -w / 2 + fr, h - fr, -d / 2, w / 2 - fr, h, d / 2);
    kit.box(ITEM_MATERIALS.mirror, -w / 2 + fr, fr, -d / 2 + Math.min(0.005, d / 4), w / 2 - fr, h - fr, d / 2 - Math.min(0.008, d / 3));
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// TV
// ---------------------------------------------------------------------------------------------

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
