import { z } from 'zod';
import type { Generator } from '@flat/scene';
import { ITEM_MATERIALS, ceramicMaterial, fabricMaterial } from '../materials/item-materials';
import { Kit, boxAnchors, colourParam, metres } from './kit';

/** More stand-ins for products without a 3D model (CG8): small wall fittings (towel rail, hook, accessory) and a storage basket. */

const wallFittingParams = z.strictObject({
  w: metres('Width of the fitting.', 0.5, 0.02, 1.5),
  d: metres('How far it stands out of the wall.', 0.1, 0.01, 0.4),
  h: metres('Height of the fitting.', 0.8, 0.02, 2),
  kind: z.enum(['rail', 'hook', 'accessory']).default('rail').describe('"rail" (a ladder towel rail), "hook" (a plate with a peg) or "accessory" (a small holder or shelf). Defaults to "rail".'),
  colour: colourParam('the fitting (steel when omitted)'),
});
type WallFittingParams = z.infer<typeof wallFittingParams>;

export const wallFitting: Generator<WallFittingParams> = {
  id: 'wallFitting',
  label: 'Small wall fitting: towel rail, hook or bathroom accessory (mount "wall"; the wall is at the back)',
  category: 'towel_rail',
  params: wallFittingParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.3, back: 0 } }),
  generate({ w, d, h, kind, colour }) {
    const kit = new Kit();
    const m = colour ? ceramicMaterial(colour) : ITEM_MATERIALS.metal;
    if (kind === 'hook') {
      kit.box(m, -w / 2, 0, -d / 2, w / 2, h, -d / 2 + Math.min(0.01, d / 2));
      const peg = Math.min(0.012, w / 2, h / 2);
      kit.box(m, -peg / 2, h / 2 - peg / 2, -d / 2, peg / 2, h / 2 + peg / 2, d / 2);
    } else if (kind === 'accessory') {
      kit.box(m, -w / 2, 0, -d / 2, w / 2, h, d / 2, Math.min(0.01, Math.min(w, d, h) / 4));
    } else {
      // two posts at the sides, the full depth, and the bars between them
      const post = Math.min(0.02, w / 4);
      kit.box(m, -w / 2, 0, -d / 2, -w / 2 + post, h, d / 2);
      kit.box(m, w / 2 - post, 0, -d / 2, w / 2, h, d / 2);
      const bar = Math.min(0.016, h / 4);
      const n = Math.max(2, Math.min(12, Math.round(h / 0.07)));
      for (let i = 0; i < n; i++) {
        const y = bar / 2 + ((h - bar) * i) / (n - 1);
        kit.box(m, -w / 2 + post, y - bar / 2, -Math.min(d / 2, 0.01), w / 2 - post, y + bar / 2, Math.min(d / 2, 0.01), 0);
      }
    }
    return kit.build();
  },
};

const basketParams = z.strictObject({
  w: metres('Width of the basket.', 0.3, 0.05, 1.5),
  d: metres('Depth of the basket.', 0.25, 0.05, 1.5),
  h: metres('Height of the basket.', 0.25, 0.04, 1),
  colour: colourParam('the weave (natural sand when omitted)'),
});
type BasketParams = z.infer<typeof basketParams>;

export const basket: Generator<BasketParams> = {
  id: 'basket',
  label: 'Open storage basket or box: four walls and a floor',
  category: 'storage',
  params: basketParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: {} }),
  generate({ w, d, h, colour }) {
    const kit = new Kit();
    const m = fabricMaterial('weave', colour ?? 'sand');
    const t = Math.min(0.012, w / 4, d / 4);
    kit.box(m, -w / 2, 0, -d / 2, w / 2, t, d / 2);
    kit.box(m, -w / 2, t, -d / 2, w / 2, h, -d / 2 + t);
    kit.box(m, -w / 2, t, d / 2 - t, w / 2, h, d / 2);
    kit.box(m, -w / 2, t, -d / 2 + t, -w / 2 + t, h, d / 2 - t);
    kit.box(m, w / 2 - t, t, -d / 2 + t, w / 2, h, d / 2 - t);
    return kit.build();
  },
};

const wallTilesParams = z.strictObject({
  w: metres('Width of the tiled panel along the wall.', 1.6, 0.1, 6),
  h: metres('Height of the tiled panel.', 1.3, 0.1, 3),
  d: metres('Thickness of the tiling (tile plus adhesive).', 0.012, 0.004, 0.05),
});
type WallTilesParams = z.infer<typeof wallTilesParams>;

/** Course height of the tiles (rectangular wall tiles laid in rows), in metres. */
const TILE_COURSE = 0.1;

export const wallTiles: Generator<WallTilesParams> = {
  id: 'wallTiles',
  label: 'Tiled wall panel: beige wall tiles in rows, e.g. around a bathtub (mount "wall")',
  category: 'other',
  params: wallTilesParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: {} }),
  generate({ w, d, h }) {
    const kit = new Kit();
    const joint = 0.002;
    // rows of tiles with slightly recessed grout lines: each course is a box, the gap between courses shows the darker backing
    kit.box(ITEM_MATERIALS.whiteMatte, -w / 2, 0, -d / 2, w / 2, h, -d / 2 + d * 0.4, 0);
    const rows = Math.max(1, Math.round(h / TILE_COURSE));
    const course = h / rows;
    for (let r = 0; r < rows; r++) {
      kit.box(ITEM_MATERIALS.tileBeige, -w / 2, r * course + joint / 2, -d / 2 + d * 0.4, w / 2, (r + 1) * course - joint / 2, d / 2, 0);
    }
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Slat wall panel (TV wall, acoustic)
// ---------------------------------------------------------------------------------------------

const slatPanelParams = z.strictObject({
  w: metres('Width of the panel along the wall (a TV wall: 2.4 to 3.5).', 2.4, 0.3, 5),
  h: metres('Height of the panel; 2.5 runs floor to ceiling in a 2.5 m room.', 2.5, 0.4, 2.7),
  d: metres('How far the slats stand out of the wall, felt included (slats 22-28 mm plus the felt).', 0.03, 0.012, 0.08),
  slat: metres('Width of one slat.', 0.028, 0.02, 0.1),
  gap: metres('Gap between two slats (the felt shows in it).', 0.018, 0.01, 0.08),
  wood: z.enum(['oak', 'walnut']).default('oak').describe('Slat veneer: "oak" (light) or "walnut" (dark). Defaults to "oak".'),
  felt: z.boolean().default(true).describe('Black acoustic felt behind the slats. Defaults to true.'),
});
type SlatPanelParams = z.infer<typeof slatPanelParams>;

/**
 * How many slats of width `slat` fit across `w` with at least `gap` between them, and the gap that makes the first and the last
 * slat touch the two ends exactly (the panel is exactly `w` wide). One slat fills the whole width.
 */
export function slatLayout(w: number, slat: number, gap: number): { n: number; slat: number; gap: number } {
  const n = Math.max(1, Math.floor((w + gap) / (slat + gap)));
  if (n === 1) return { n, slat: Math.min(slat, w), gap: 0 };
  return { n, slat, gap: (w - n * slat) / (n - 1) };
}

export const slatPanel: Generator<SlatPanelParams> = {
  id: 'slatPanel',
  label: 'Slatted oak or walnut wall panel on acoustic felt: TV or accent wall (mount "wall", wall at the back)',
  category: 'decor',
  params: slatPanelParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.3, back: 0 } }),
  generate({ w, h, d, slat, gap, wood, felt }) {
    const kit = new Kit();
    const feltT = felt ? Math.min(0.008, d / 3) : 0;
    const m = wood === 'walnut' ? ITEM_MATERIALS.walnut : ITEM_MATERIALS.oak;
    if (felt) kit.box(ITEM_MATERIALS.dark, -w / 2, 0, -d / 2, w / 2, h, -d / 2 + feltT, 0);
    const lay = slatLayout(w, slat, gap);
    for (let i = 0; i < lay.n; i++) {
      const x0 = lay.n === 1 ? -lay.slat / 2 : -w / 2 + i * (lay.slat + lay.gap);
      kit.box(m, x0, 0, -d / 2 + feltT, x0 + lay.slat, h, d / 2, 0);
    }
    return kit.build();
  },
};
