import { z } from 'zod';
import type { Generator } from '@flat/scene';
import { ITEM_MATERIALS } from '../materials/item-materials';
import { Kit, boxAnchors, metres } from './kit';

/**
 * Fixed heating (the flat's own radiators): a white steel panel radiator with vertical channels and a valve, or a
 * towel radiator (a ladder of horizontal tubes). Wall mount: the back is against the wall, the item stands `elevation`
 * (about 15 cm) above the floor. Not a light source; heat is ignored. Item frame as in `kit.ts` (front +z).
 */

const ENAMEL = ITEM_MATERIALS.enamel;
const CHROME = ITEM_MATERIALS.metal;

/** Free floor-side space the layout rules keep in front of a radiator, in metres. */
export const RADIATOR_CLEARANCE_FRONT = 0.15;

const radiatorParams = z.strictObject({
  kind: z.enum(['panel', 'towel']).default('panel').describe('"panel" (a flat steel panel radiator with vertical channels) or "towel" (a ladder of horizontal tubes, sèche-serviettes). Defaults to "panel".'),
  w: metres('Width of the radiator.', 0.8, 0.3, 2),
  h: metres('Height of the radiator.', 0.6, 0.3, 2),
  d: metres('How far it stands out of the wall.', 0.1, 0.04, 0.5),
  valve: z.enum(['left', 'right']).default('right').describe('Panel only: which side carries the thermostatic valve, seen from the front. Defaults to "right".'),
});
type RadiatorParams = z.infer<typeof radiatorParams>;

export const radiator: Generator<RadiatorParams> = {
  id: 'radiator',
  label: 'Wall radiator: steel panel or towel radiator (mount "wall"; keeps 15 cm free in front)',
  category: 'radiator',
  params: radiatorParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: RADIATOR_CLEARANCE_FRONT, back: 0 } }),
  generate({ kind, w, h, d, valve }) {
    const kit = new Kit();
    const s = valve === 'right' ? 1 : -1;
    if (kind === 'towel') {
      const post = Math.min(0.035, w / 4);
      const tube = 0.022;
      // two vertical collectors, the tubes between them, and a wall bracket at the top and the bottom of each collector
      kit.box(ENAMEL, -w / 2, 0, d / 2 - 0.035, -w / 2 + post, h, d / 2, 0.004);
      kit.box(ENAMEL, w / 2 - post, 0, d / 2 - 0.035, w / 2, h, d / 2, 0.004);
      const n = Math.max(3, Math.min(24, Math.round(h / 0.08)));
      for (let i = 0; i < n; i++) {
        const y = tube / 2 + ((h - tube) * i) / (n - 1);
        kit.box(ENAMEL, -w / 2 + post, y - tube / 2, d / 2 - 0.03, w / 2 - post, y + tube / 2, d / 2 - 0.008, 0.004);
      }
      for (const x of [-w / 2 + post / 2, w / 2 - post / 2]) {
        for (const y of [0.04, h - 0.1]) kit.box(CHROME, x - 0.012, y, -d / 2, x + 0.012, y + 0.06, d / 2 - 0.035);
      }
      return kit.build();
    }
    // panel radiator: back plate, front plate with vertical channels (ribs), side covers, top grille, valve block
    const side = 0.012;
    const valveW = 0.045;
    const x0 = -w / 2 + (s < 0 ? valveW : 0);
    const x1 = w / 2 - (s > 0 ? valveW : 0);
    kit.box(ENAMEL, x0, 0.02, -d / 2, x1, h - 0.03, -d / 2 + 0.018); // back plate
    kit.box(ENAMEL, x0, 0.02, -d / 2 + 0.018, x1, h - 0.03, d / 2 - 0.014); // water body
    const ribs = Math.max(4, Math.round((x1 - x0 - 2 * side) / 0.04));
    const pitch = (x1 - x0 - 2 * side) / ribs;
    for (let i = 0; i < ribs; i++) {
      const xa = x0 + side + i * pitch;
      kit.box(ENAMEL, xa + pitch * 0.12, 0.025, d / 2 - 0.014, xa + pitch * 0.88, h - 0.035, d / 2, 0.004); // raised channel
    }
    kit.box(ENAMEL, x0, 0.02, -d / 2, x0 + side, h - 0.03, d / 2); // side covers
    kit.box(ENAMEL, x1 - side, 0.02, -d / 2, x1, h - 0.03, d / 2);
    kit.box(ENAMEL, x0, h - 0.03, -d / 2 + 0.005, x1, h, d / 2 - 0.005, 0.004); // top grille
    for (let i = 1; i < 6; i++) {
      const gx = x0 + ((x1 - x0) * i) / 6;
      kit.box(CHROME, gx - 0.004, h - 0.004, -d / 2 + 0.02, gx + 0.004, h, d / 2 - 0.02, 0); // grille slots read as dark lines
    }
    const inset = Math.min(0.02, d / 4);
    kit.box(ENAMEL, x0, 0, -d / 2 + inset, x1, 0.02, d / 2 - inset, 0.003); // bottom plate
    // valve block at the lower corner, thermostatic head sticking out sideways (kept inside the width)
    const vx0 = s > 0 ? x1 : -w / 2;
    const vx1 = s > 0 ? w / 2 : x0;
    const zv = Math.min(-d / 2 + 0.065, d / 2 - 0.005);
    kit.box(CHROME, vx0, 0.03, -d / 2 + inset, vx1, 0.075, zv);
    kit.box(ENAMEL, vx0, 0.08, -d / 2 + inset * 0.75, vx1, Math.min(0.14, h - 0.03), Math.min(-d / 2 + 0.07, d / 2 - 0.003), 0.006);
    return kit.build();
  },
};
