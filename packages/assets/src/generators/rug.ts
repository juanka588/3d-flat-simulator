import { z } from 'zod';
import type { Generator } from '@flat/scene';
import { ITEM_MATERIALS, fabricMaterial } from '../materials/item-materials';
import { Kit, boxAnchors, colourParam, metres } from './kit';

/** Rugs (CG4: shapes and patterns built from geometry, so they stay deterministic and need no texture). */

/** Thickness of a rug, in metres. */
export const RUG_THICKNESS = 0.012;

const rugParams = z.strictObject({
  w: metres('Width of the rug.', 2, 0.3, 6),
  d: metres('Depth of the rug.', 1.4, 0.3, 6),
  shape: z
    .enum(['rect', 'round', 'runner'])
    .default('rect')
    .describe('"rect", "round" (an ellipse of w x d; circular when w = d) or "runner" (rect with fringes at the two short ends). Defaults to "rect".'),
  pattern: z
    .enum(['border', 'plain', 'stripes', 'checker'])
    .default('border')
    .describe('Pattern built from geometry (no image): "border" (field with an edge band), "plain", "stripes" or "checker" (round rugs: concentric rings for both). Defaults to "border".'),
  colour: colourParam('the rug field'),
  accent: colourParam('the pattern (border band, stripes, checks, fringe)'),
});
type RugParams = z.infer<typeof rugParams>;

export const rug: Generator<RugParams> = {
  id: 'rug',
  label: 'Flat rug, 1.2 cm thick: rectangular, round or runner, with a border, stripes or checks',
  category: 'rug',
  params: rugParams,
  describeParams: ({ w, d }) => ({ dims: { w, d, h: RUG_THICKNESS }, anchors: boxAnchors(w, d, RUG_THICKNESS), clearance: {} }),
  generate({ w, d, shape, pattern, colour, accent }) {
    const kit = new Kit();
    const field = colour ? fabricMaterial('weave', colour) : ITEM_MATERIALS.bedding;
    const band = accent ? fabricMaterial('weave', accent) : ITEM_MATERIALS.rug;
    const T = RUG_THICKNESS;
    if (shape === 'round') {
      const rx = w / 2;
      const rz = d / 2;
      if (pattern === 'plain') {
        kit.prism(field, 0, 0, 0, rx, rz, T, 32);
      } else if (pattern === 'border') {
        const b = Math.min(0.06, rx / 4, rz / 4);
        const f = 1 - b / Math.min(rx, rz);
        kit.prism(band, 0, 0, 0, rx, rz, 0.008, 32);
        kit.lathe(band, 0, 0, rx, rz, [[1, 0.008], [1, T], [f, T], [f, 0.008]], 32);
        kit.prism(field, 0, 0.008, 0, rx * f, rz * f, T, 32);
      } else {
        // concentric rings in 2 mm steps: outer band, field, inner band
        kit.prism(band, 0, 0, 0, rx, rz, 0.008, 32);
        kit.prism(field, 0, 0.008, 0, rx * 0.8, rz * 0.8, 0.01, 32);
        kit.prism(band, 0, 0.01, 0, rx * 0.55, rz * 0.55, T, 32);
      }
      return kit.build();
    }
    // rect and runner: a runner has fringes along the short ends, so its body is shorter on the long axis
    const alongX = w >= d;
    const fringe = shape === 'runner' ? Math.min(0.06, (alongX ? w : d) / 8) : 0;
    const x0 = -w / 2 + (alongX ? fringe : 0);
    const x1 = w / 2 - (alongX ? fringe : 0);
    const z0 = -d / 2 + (alongX ? 0 : fringe);
    const z1 = d / 2 - (alongX ? 0 : fringe);
    if (fringe > 0) {
      const span = alongX ? d : w;
      const n = Math.max(3, Math.min(20, Math.round(span / 0.05)));
      const pitch = span / n;
      for (let i = 0; i < n; i++) {
        const a0 = -span / 2 + i * pitch + pitch * 0.25;
        const a1 = a0 + pitch * 0.5;
        if (alongX) {
          kit.box(band, -w / 2, 0, a0, -w / 2 + fringe + 0.001, 0.004, a1, 0);
          kit.box(band, w / 2 - fringe - 0.001, 0, a0, w / 2, 0.004, a1, 0);
        } else {
          kit.box(band, a0, 0, -d / 2, a1, 0.004, -d / 2 + fringe + 0.001, 0);
          kit.box(band, a0, 0, d / 2 - fringe - 0.001, a1, 0.004, d / 2, 0);
        }
      }
    }
    if (pattern === 'border') {
      const b = Math.min(0.06, (x1 - x0) / 4, (z1 - z0) / 4);
      kit.box(band, x0, 0, z0, x1, 0.008, z1);
      kit.box(field, x0 + b, 0.008, z0 + b, x1 - b, T, z1 - b);
      kit.box(band, x0, 0.008, z0, x1, T, z0 + b);
      kit.box(band, x0, 0.008, z1 - b, x1, T, z1);
      kit.box(band, x0, 0.008, z0 + b, x0 + b, T, z1 - b);
      kit.box(band, x1 - b, 0.008, z0 + b, x1, T, z1 - b);
    } else if (pattern === 'plain') {
      kit.box(field, x0, 0, z0, x1, T, z1);
    } else if (pattern === 'stripes') {
      kit.box(field, x0, 0, z0, x1, 0.008, z1);
      const across = alongX ? z1 - z0 : x1 - x0;
      const n = Math.max(3, Math.min(25, Math.round(across / 0.18))) | 1; // odd: both edges are the same colour
      for (let i = 0; i < n; i++) {
        const u0 = i / n;
        const u1 = (i + 1) / n;
        const m = i % 2 === 0 ? band : field;
        if (alongX) kit.box(m, x0, 0.008, z0 + u0 * (z1 - z0), x1, T, z0 + u1 * (z1 - z0));
        else kit.box(m, x0 + u0 * (x1 - x0), 0.008, z0, x0 + u1 * (x1 - x0), T, z1);
      }
    } else {
      kit.box(field, x0, 0, z0, x1, 0.008, z1);
      const nx = Math.max(2, Math.min(10, Math.round((x1 - x0) / 0.3)));
      const nz = Math.max(2, Math.min(10, Math.round((z1 - z0) / 0.3)));
      for (let i = 0; i < nx; i++) {
        for (let k = 0; k < nz; k++) {
          const m = (i + k) % 2 === 0 ? band : field;
          kit.box(m, x0 + (i / nx) * (x1 - x0), 0.008, z0 + (k / nz) * (z1 - z0), x0 + ((i + 1) / nx) * (x1 - x0), T, z0 + ((k + 1) / nz) * (z1 - z0));
        }
      }
    }
    return kit.build();
  },
};
