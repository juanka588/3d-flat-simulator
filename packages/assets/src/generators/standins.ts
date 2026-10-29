import { z } from 'zod';
import type { Generator } from '@flat/scene';
import { ITEM_MATERIALS, ceramicMaterial, fabricMaterial, photoMaterial, tintMaterial } from '../materials/item-materials';
import type { ColourName } from '../materials/item-materials';
import { Kit, boxAnchors, colourParam, metres } from './kit';

/**
 * Stand-ins for retail products without a 3D model (CG8): cushion, throw, picture frame, plant, vase and lamp. Each takes the
 * product's exact w x d x h, a palette `colour` (from the product's colour words) and, for the soft goods and the frame,
 * `photo`: the part that shows the product photo (UV 0-1, cropped to the photo's centre by the viewer). Without a photo the
 * same part shows the palette colour, so these meshes never depend on the photo being there.
 */

const photoParam = (what: string) => z.boolean().default(false).describe(`Show the product photo (cropped to its centre) on ${what} when one is available, else the colour. Defaults to false.`);
const tintParam = (what: string) => z.boolean().default(false).describe(`Colour ${what} with the dominant colour of the product photo when one is available, else the colour. Defaults to false.`);

// ---------------------------------------------------------------------------------------------
// Cushion
// ---------------------------------------------------------------------------------------------

const cushionParams = z.strictObject({
  w: metres('Width of the cushion.', 0.45, 0.1, 1.5),
  d: metres('Depth of the cushion.', 0.45, 0.1, 1.5),
  h: metres('Thickness of the cushion lying flat.', 0.12, 0.02, 0.4),
  photo: photoParam('the top'),
  colour: colourParam('the cushion cover'),
});
type CushionParams = z.infer<typeof cushionParams>;

export const cushion: Generator<CushionParams> = {
  id: 'cushion',
  label: 'Scatter cushion lying flat, rounded edges; product photo on top when there is one',
  category: 'cushion',
  params: cushionParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: {} }),
  generate({ w, d, h, photo, colour }) {
    const kit = new Kit();
    const cover = colour ? fabricMaterial('weave', colour) : ITEM_MATERIALS.bedding;
    const r = h / 4; // the bevel of the box (see Kit.box): the photo lies on the flat part of the top
    if (photo) {
      kit.box(cover, -w / 2, 0, -d / 2, w / 2, h - 0.0004, d / 2, r);
      kit.topFace(photoMaterial(colour ?? 'cream'), -w / 2 + r, -d / 2 + r, w / 2 - r, d / 2 - r, h);
    } else {
      kit.box(cover, -w / 2, 0, -d / 2, w / 2, h, d / 2, r);
    }
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Throw
// ---------------------------------------------------------------------------------------------

const throwParams = z.strictObject({
  w: metres('Width of the throw.', 1.3, 0.3, 3),
  d: metres('Length of the throw (laid flat).', 1.7, 0.3, 3),
  h: metres('Thickness of the throw.', 0.02, 0.005, 0.3),
  photo: photoParam('the top'),
  colour: colourParam('the throw'),
});
type ThrowParams = z.infer<typeof throwParams>;

export const throwBlanket: Generator<ThrowParams> = {
  id: 'throwBlanket',
  label: 'Throw / blanket laid flat; product photo on top when there is one',
  category: 'throw',
  params: throwParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: {} }),
  generate({ w, d, h, photo, colour }) {
    const kit = new Kit();
    const cover = colour ? fabricMaterial('weave', colour) : ITEM_MATERIALS.bedding;
    if (photo) {
      kit.box(cover, -w / 2, 0, -d / 2, w / 2, h - 0.0004, d / 2, Math.min(h / 3, 0.006));
      kit.topFace(photoMaterial(colour ?? 'cream'), -w / 2, -d / 2, w / 2, d / 2, h);
    } else {
      kit.box(cover, -w / 2, 0, -d / 2, w / 2, h, d / 2, Math.min(h / 3, 0.006));
    }
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Picture frame
// ---------------------------------------------------------------------------------------------

const frameParams = z.strictObject({
  w: metres('Width of the frame.', 0.32, 0.05, 2),
  d: metres('Depth of the frame (front to back).', 0.025, 0.005, 0.2),
  h: metres('Height of the frame.', 0.42, 0.05, 2),
  photo: photoParam('the picture'),
  colour: colourParam('the frame border (wood when omitted)'),
});
type FrameParams = z.infer<typeof frameParams>;

export const frame: Generator<FrameParams> = {
  id: 'frame',
  label: 'Picture frame with a mat and a picture (the product photo when there is one); mount "wall"',
  category: 'frame',
  params: frameParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.2, back: 0 } }),
  generate({ w, d, h, photo, colour }) {
    const kit = new Kit();
    const border = colour ? fabricMaterial('velvet', colour) : ITEM_MATERIALS.wood;
    const fr = Math.min(0.03, w * 0.08, h * 0.08);
    kit.box(border, -w / 2, 0, -d / 2, -w / 2 + fr, h, d / 2);
    kit.box(border, w / 2 - fr, 0, -d / 2, w / 2, h, d / 2);
    kit.box(border, -w / 2 + fr, 0, -d / 2, w / 2 - fr, fr, d / 2);
    kit.box(border, -w / 2 + fr, h - fr, -d / 2, w / 2 - fr, h, d / 2);
    // the mat, a little behind the front of the frame; the picture just in front of it
    const zMat = d / 2 - Math.min(0.004, d / 4);
    kit.box(ITEM_MATERIALS.whiteMatte, -w / 2 + fr, fr, -d / 2, w / 2 - fr, h - fr, zMat, 0);
    const iw = w - 2 * fr;
    const ih = h - 2 * fr;
    const m = Math.min(iw, ih) >= 0.2 ? Math.min(0.06, Math.min(iw, ih) * 0.18) : 0;
    kit.frontFace(photo ? photoMaterial(colour ?? 'cream') : ITEM_MATERIALS.bedding, -w / 2 + fr + m, fr + m, w / 2 - fr - m, h - fr - m, zMat + 0.0005);
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Plant
// ---------------------------------------------------------------------------------------------

const plantParams = z.strictObject({
  w: metres('Width of the plant including leaves.', 0.3, 0.03, 1.5),
  d: metres('Depth of the plant including leaves.', 0.3, 0.03, 1.5),
  h: metres('Overall height including the pot.', 0.8, 0.05, 3),
  colour: colourParam('the pot (dark when omitted)'),
});
type PlantParams = z.infer<typeof plantParams>;

export const plant: Generator<PlantParams> = {
  id: 'plant',
  label: 'House plant in a pot: a crown of foliage on a stem',
  category: 'plant',
  params: plantParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: {} }),
  generate({ w, d, h, colour }) {
    const kit = new Kit();
    const pot = colour ? ceramicMaterial(colour) : ITEM_MATERIALS.dark;
    const leaf = fabricMaterial('velvet', 'green');
    const leaf2 = fabricMaterial('velvet', 'sage');
    const potH = Math.min(0.28 * h, 0.3);
    const potR = Math.min(w, d) * 0.3;
    kit.lathe(pot, 0, 0, potR, potR, [[0, 0], [0.8, 0], [1, potH], [0.88, potH], [0.88, potH * 0.85]], 16);
    // a stem, then the crown: a big blob that touches the full width and depth and the top, and two smaller ones inside it
    const crownBottom = Math.max(potH + 0.02, h * 0.35);
    const ch = h - crownBottom;
    kit.box(ITEM_MATERIALS.dark, -0.004, potH * 0.85, -0.004, 0.004, crownBottom + ch * 0.4, 0.004, 0);
    const blob = (m: string, cx: number, cz: number, rx: number, rz: number, y0: number, sh: number) => {
      const prof: [number, number][] = [];
      for (let k = 0; k <= 8; k++) {
        const th = -Math.PI / 2 + (Math.PI * k) / 8;
        prof.push([k === 0 || k === 8 ? 0 : Math.cos(th), y0 + sh / 2 + (sh / 2) * Math.sin(th)]);
      }
      kit.lathe(m, cx, cz, rx, rz, prof, 16);
    };
    blob(leaf, 0, 0, w / 2, d / 2, crownBottom, ch);
    blob(leaf2, -w * 0.12, d * 0.1, w * 0.2, d * 0.2, crownBottom + ch * 0.1, ch * 0.7);
    blob(leaf2, w * 0.14, -d * 0.1, w * 0.18, d * 0.18, crownBottom + ch * 0.2, ch * 0.7);
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Vase
// ---------------------------------------------------------------------------------------------

const vaseParams = z.strictObject({
  w: metres('Widest diameter of the vase.', 0.15, 0.03, 0.8),
  d: metres('Depth (widest diameter the other way; equal to the width for a round vase).', 0.15, 0.03, 0.8),
  h: metres('Height of the vase.', 0.3, 0.05, 1.5),
  tint: tintParam('the vase'),
  colour: colourParam('the vase (white ceramic when omitted)'),
});
type VaseParams = z.infer<typeof vaseParams>;

export const vase: Generator<VaseParams> = {
  id: 'vase',
  label: 'Vase: a belly with a narrower neck, open at the top',
  category: 'vase',
  params: vaseParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: {} }),
  generate({ w, d, h, tint, colour }) {
    const kit = new Kit();
    const body = tint ? tintMaterial(colour ?? 'cream') : colour ? ceramicMaterial(colour) : ITEM_MATERIALS.ceramic;
    kit.lathe(
      body,
      0,
      0,
      w / 2,
      d / 2,
      [[0, 0], [0.6, 0], [0.9, h * 0.25], [1, h * 0.45], [0.8, h * 0.72], [0.5, h * 0.92], [0.52, h], [0.42, h], [0.4, h * 0.9], [0.7, h * 0.7]],
      16,
    );
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Lamp
// ---------------------------------------------------------------------------------------------

const lampParams = z.strictObject({
  w: metres('Width of the lamp (the shade).', 0.3, 0.03, 1.5),
  d: metres('Depth of the lamp (the shade; for a wall lamp, how far it stands out of the wall).', 0.3, 0.03, 1.5),
  h: metres('Overall height.', 0.5, 0.1, 3),
  kind: z.enum(['table', 'floor', 'wall', 'hanging']).default('table').describe('"table" (base, stem and shade), "floor" (the same, tall), "wall" (a back plate with a shade; mount "wall") or "hanging" (a shade on a cord; mount "ceiling"). Defaults to "table".'),
  tint: tintParam('the shade'),
  colour: colourParam('the shade (white when omitted)'),
});
type LampParams = z.infer<typeof lampParams>;

/** An open conical shade of height `sh` from `y0`, with its widest ring (radius share 1) at the bottom. */
function shadeProfile(y0: number, sh: number): [number, number][] {
  return [[1, y0], [0.65, y0 + sh], [0.6, y0 + sh], [0.96, y0]];
}

export const lamp: Generator<LampParams> = {
  id: 'lamp',
  label: 'Lamp: table, floor, wall or hanging, conical shade (a generated lamp has no light)',
  category: 'lamp',
  params: lampParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.2, back: 0 } }),
  generate({ w, d, h, kind, tint, colour }) {
    const kit = new Kit();
    const c: ColourName = colour ?? 'cream';
    const shade = tint ? tintMaterial(c) : colour ? ceramicMaterial(colour) : ITEM_MATERIALS.white;
    const metal = ITEM_MATERIALS.metal;
    if (kind === 'wall') {
      const sh = h * 0.8;
      kit.box(metal, -Math.min(w * 0.3, 0.06), 0, -d / 2, Math.min(w * 0.3, 0.06), h, -d / 2 + 0.012, 0);
      kit.lathe(shade, 0, 0, w / 2, d / 2, shadeProfile(0, sh), 16);
      return kit.build();
    }
    if (kind === 'hanging') {
      const sh = Math.max(0.05, Math.min(h - 0.1, w * 0.8));
      kit.lathe(shade, 0, 0, w / 2, d / 2, [[1, 0], [0.55, sh], [0.5, sh], [0.96, 0]], 16);
      kit.box(ITEM_MATERIALS.dark, -0.004, sh, -0.004, 0.004, h - 0.03, 0.004, 0);
      const canopy = Math.min(0.05, Math.min(w, d) / 2);
      kit.box(metal, -canopy, h - 0.03, -canopy, canopy, h, canopy, 0);
      return kit.build();
    }
    // table / floor: a round base, a stem and the shade on top
    const sh = Math.min(kind === 'floor' ? 0.35 : 0.3, h * 0.4, Math.max(0.05, w * 0.9));
    const y0 = h - sh;
    const baseR = Math.min(Math.min(w, d) * 0.3, kind === 'floor' ? 0.17 : 0.12);
    kit.prism(metal, 0, 0, 0, baseR, baseR, 0.015, 16);
    kit.box(metal, -0.01, 0.015, -0.01, 0.01, y0 + 0.02, 0.01, 0);
    kit.lathe(shade, 0, 0, w / 2, d / 2, shadeProfile(y0, sh), 16);
    return kit.build();
  },
};
