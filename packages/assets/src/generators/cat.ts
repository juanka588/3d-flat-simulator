import { z } from 'zod';
import type { Generator } from '@flat/scene';
import { ITEM_MATERIALS, fabricMaterial } from '../materials/item-materials';
import { Kit, boxAnchors, colourParam, count, finish, finishMaterial, metres } from './kit';

/**
 * Cat furniture, drawn from boxes: `catWall` (wall-mounted steps, a bridge, a hammock, a cave and a sisal post; mount "wall") and
 * `catTree` (a floor tree: base, sisal post, platforms, a cave). Both are CONCEPT shapes (no retailer product); the item frame is
 * the usual one (back at -z, front +z, origin at the footprint centre on the floor / at the lowest board of the wall set).
 */

/** Wood board and the pad glued on top of it, in metres. */
const BOARD = 0.032;
const PAD = 0.008;
const TOP = BOARD + PAD;
/** Largest jump between two boards a cat makes comfortably, in metres. */
export const CAT_MAX_RISE = 0.45;

const SISAL = fabricMaterial('weave', 'sand');

// ---------------------------------------------------------------------------------------------
// Cat wall
// ---------------------------------------------------------------------------------------------

const catWallParams = z.strictObject({
  w: metres('Width of the whole climbing wall.', 2, 0.8, 3.2),
  h: metres('Height from the lowest board to the top of the highest one (hang it with the item elevation).', 1.8, 0.8, 2.4),
  d: metres('How far the boards stand out of the wall.', 0.3, 0.2, 0.6),
  steps: count('Number of boards (steps, bridge included). Keep the rise between two boards under 0.45 m.', 6, 2, 9),
  layout: z.enum(['stairs', 'zigzag']).default('stairs').describe('"stairs" (the boards climb from one side to the other) or "zigzag" (they alternate left and right, narrow walls only). Defaults to "stairs".'),
  rising: z.enum(['left', 'right']).default('right').describe('Which side the climb ends on (the top board / bridge), seen from the front. Defaults to "right".'),
  bridge: z.boolean().default(true).describe('The top board is a long bridge across most of the width. Defaults to true.'),
  hammock: z.boolean().default(false).describe('Hang a hammock on one of the middle boards. Defaults to false.'),
  cave: z.boolean().default(true).describe('Put a small open-front cat cave (box) on a board. Defaults to true.'),
  post: z.boolean().default(false).describe('A vertical sisal scratching post along the low side, wall to wall in height. Defaults to false.'),
  finish: finish('oak'),
  pad: colourParam('the pads on the boards and the hammock (default charcoal)'),
});
type CatWallParams = z.infer<typeof catWallParams>;

interface Board {
  x0: number;
  x1: number;
  y: number;
}

/** The boards of a cat wall, lowest first (y = underside of the wood). */
export function catWallBoards(p: Pick<CatWallParams, 'w' | 'h' | 'steps' | 'layout' | 'rising' | 'bridge' | 'post'>): Board[] {
  const { w, h, steps: n, layout, rising, bridge, post } = p;
  const postW = post ? 0.12 : 0;
  const left = rising === 'right' ? -w / 2 : w / 2; // the side the climb starts on
  const sgn = rising === 'right' ? 1 : -1; // +1: x grows with the height
  const lo = -w / 2 + (rising === 'right' ? postW : 0);
  const hi = w / 2 - (rising === 'left' ? postW : 0);
  const span = hi - lo;
  const sw = layout === 'zigzag' ? Math.min(0.8, (span + 0.3) / 2) : Math.min(0.5, Math.max(0.3, span / 3));
  const boards: Board[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const y = (h - TOP) * t;
    let x0: number;
    if (layout === 'zigzag') x0 = (i % 2 === 0) === (sgn > 0) ? lo : hi - sw;
    else x0 = sgn > 0 ? lo + (span - sw) * t : hi - sw - (span - sw) * t;
    boards.push({ x0, x1: x0 + sw, y });
  }
  void left;
  if (bridge) {
    // the last board becomes the bridge: from the top step across most of the width
    const top = boards[n - 1]!;
    const len = Math.min(span, Math.max(sw * 2, span * 0.7));
    if (sgn > 0) boards[n - 1] = { x0: hi - len, x1: hi, y: top.y };
    else boards[n - 1] = { x0: lo, x1: lo + len, y: top.y };
  }
  return boards;
}

export const catWall: Generator<CatWallParams> = {
  id: 'catWall',
  label: 'Cat climbing wall: staggered wall-mounted boards, optional bridge, hammock, cave and sisal post (concept, mount "wall")',
  category: 'decor',
  params: catWallParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.4, back: 0 } }),
  generate(p) {
    const { w, d, h, steps: n, hammock, cave, post, finish: f, pad: padColour } = p;
    const kit = new Kit();
    const wood = finishMaterial(f);
    const padMat = padColour ? fabricMaterial('weave', padColour) : fabricMaterial('weave', 'charcoal');
    const boards = catWallBoards(p);
    const z0 = -d / 2;
    const z1 = d / 2;
    const used = new Set<number>();
    const board = (b: Board) => {
      kit.box(wood, b.x0, b.y, z0, b.x1, b.y + BOARD, z1);
      kit.box(padMat, b.x0 + 0.01, b.y + BOARD, z0 + 0.01, b.x1 - 0.01, b.y + TOP, z1 - 0.02, 0.003);
      // two steel angle brackets under the board, against the wall
      for (const bx of [b.x0 + 0.06, b.x1 - 0.06]) kit.box(ITEM_MATERIALS.metal, bx - 0.01, Math.max(0, b.y - 0.1), z0, bx + 0.01, b.y, z0 + 0.012);
    };
    // the hammock hangs on the middle board (never the top one), the cave on the highest board with room above it
    // a piece of height `ph` on board i must not run into the next board up (same x range, too close above)
    const clear = (i: number, ph: number): boolean => {
      const b = boards[i]!;
      const up = boards[i + 1];
      if (!up) return b.y + TOP + ph <= h + 1e-9;
      const overlap = Math.min(b.x1, up.x1) - Math.max(b.x0, up.x0) > 0.02;
      return b.y + TOP + ph <= h + 1e-9 && (!overlap || b.y + TOP + ph + 0.02 <= up.y);
    };
    const mid0 = Math.max(0, Math.min(n - 2, Math.floor((n - 1) / 2)));
    let mid = -1;
    for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      const i = mid0 + k;
      if (i >= 0 && i <= n - 2 && clear(i, 0.22)) {
        mid = i;
        break;
      }
    }
    if (post) {
      const postW = 0.12;
      const px0 = p.rising === 'right' ? -w / 2 : w / 2 - postW;
      kit.box(SISAL, px0, 0, z0, px0 + postW, h, z0 + postW);
    }
    boards.forEach((b, i) => {
      board(b);
      if (hammock && i === mid) {
        used.add(i);
        const bw = b.x1 - b.x0;
        const hw = Math.min(bw, 0.6);
        const hx0 = b.x0 + (bw - hw) / 2;
        const hx1 = hx0 + hw;
        const hy = b.y + TOP;
        // the sling: two end plates standing on the board and a fabric belly sagging between them (stepped in three)
        kit.box(wood, hx0, hy, z0, hx0 + 0.03, hy + 0.2, z1);
        kit.box(wood, hx1 - 0.03, hy, z0, hx1, hy + 0.2, z1);
        const inner0 = hx0 + 0.03;
        const inner1 = hx1 - 0.03;
        const third = (inner1 - inner0) / 3;
        kit.box(padMat, inner0, hy + 0.15, z0 + 0.04, inner0 + third, hy + 0.165, z1 - 0.04, 0.002);
        kit.box(padMat, inner0 + third, hy + 0.07, z0 + 0.04, inner1 - third, hy + 0.085, z1 - 0.04, 0.002);
        kit.box(padMat, inner1 - third, hy + 0.15, z0 + 0.04, inner1, hy + 0.165, z1 - 0.04, 0.002);
      }
    });
    if (cave) {
      // the highest board that is not the top one, not the hammock's, with a 0.36 m cave below the next-but-one or the roof of the wall
      for (let i = n - 2; i >= 0; i--) {
        if (used.has(i)) continue;
        const b = boards[i]!;
        const cy = b.y + TOP;
        const ch = 0.36;
        if (!clear(i, ch)) continue;
        const bw = b.x1 - b.x0;
        const cw = Math.min(0.4, bw);
        const cx0 = b.x0 + (bw - cw) / 2;
        const cx1 = cx0 + cw;
        const t = 0.02;
        kit.box(wood, cx0, cy, z0, cx0 + t, cy + ch, z1 - 0.02);
        kit.box(wood, cx1 - t, cy, z0, cx1, cy + ch, z1 - 0.02);
        kit.box(wood, cx0, cy + ch - t, z0, cx1, cy + ch, z1 - 0.02);
        kit.box(wood, cx0 + t, cy, z0, cx1 - t, cy + ch - t, z0 + t);
        // front lintel and jambs leave a round-ish entrance of about 0.2 m
        const open = Math.min(0.2, cw - 2 * t - 0.08);
        const ox0 = (cx0 + cx1) / 2 - open / 2;
        const ox1 = ox0 + open;
        kit.box(wood, cx0 + t, cy, z1 - 0.04, ox0, cy + ch - t, z1 - 0.02);
        kit.box(wood, ox1, cy, z1 - 0.04, cx1 - t, cy + ch - t, z1 - 0.02);
        kit.box(wood, ox0, cy + 0.26, z1 - 0.04, ox1, cy + ch - t, z1 - 0.02);
        used.add(i);
        break;
      }
    }
    // keep the highest point at exactly h: the top board's pad ends at h by construction; the wall hangs from its lowest board (y = 0)
    return kit.build();
  },
};

// ---------------------------------------------------------------------------------------------
// Cat tree
// ---------------------------------------------------------------------------------------------

const catTreeParams = z.strictObject({
  w: metres('Width of the tree (the base plate).', 0.6, 0.4, 1.2),
  d: metres('Depth of the tree (the base plate).', 0.5, 0.4, 1),
  h: metres('Height up to the top perch.', 1.5, 0.8, 2.4),
  levels: count('Number of platforms above the base (the top one is the perch).', 3, 2, 5),
  cave: z.boolean().default(true).describe('A cave under the first platform. Defaults to true.'),
  finish: finish('light-oak'),
  pad: colourParam('the base and the pads (default charcoal)'),
});
type CatTreeParams = z.infer<typeof catTreeParams>;

export const catTree: Generator<CatTreeParams> = {
  id: 'catTree',
  label: 'Cat tree: base plate, sisal post, platforms and an optional cave (concept, floor)',
  category: 'decor',
  params: catTreeParams,
  describeParams: ({ w, d, h }) => ({ dims: { w, d, h }, anchors: boxAnchors(w, d, h), clearance: { front: 0.5, back: 0 } }),
  generate({ w, d, h, levels, cave, finish: f, pad: padColour }) {
    const kit = new Kit();
    const wood = finishMaterial(f);
    const padMat = padColour ? fabricMaterial('weave', padColour) : fabricMaterial('weave', 'charcoal');
    const baseT = 0.05;
    kit.box(padMat, -w / 2, 0, -d / 2, w / 2, baseT, d / 2, 0.004);
    // sisal post, set towards the back
    const r = Math.min(0.055, w / 8, d / 8);
    kit.prism(SISAL, 0, baseT, -d / 6, r, r, h - TOP, 14);
    const pw = w * 0.78;
    const pd = d * 0.78;
    for (let k = 1; k <= levels; k++) {
      const yTop = (h * k) / levels;
      const left = k % 2 === 1;
      const x0 = left ? -w / 2 : w / 2 - pw;
      const x1 = x0 + pw;
      const topLevel = k === levels;
      const zc0 = topLevel ? -d / 2 : -d / 2 + (d - pd) / 2;
      const z1 = topLevel ? -d / 2 + pd : zc0 + pd;
      const xa = topLevel ? -pw / 2 : x0;
      const xb = topLevel ? pw / 2 : x1;
      kit.box(wood, xa, yTop - TOP, zc0, xb, yTop - PAD, z1);
      kit.box(padMat, xa + 0.01, yTop - PAD, zc0 + 0.01, xb - 0.01, yTop, z1 - 0.01, 0.003);
    }
    if (cave) {
      const yRoof = h / levels - TOP;
      const ch = yRoof - baseT;
      if (ch >= 0.3) {
        const cw = Math.min(0.42, pw - 0.04);
        const cx0 = -w / 2 + 0.02;
        const cx1 = cx0 + cw;
        const t = 0.02;
        const cz0 = -d / 2 + (d - pd) / 2;
        const cz1 = cz0 + pd;
        kit.box(wood, cx0, baseT, cz0, cx0 + t, yRoof, cz1);
        kit.box(wood, cx1 - t, baseT, cz0, cx1, yRoof, cz1);
        kit.box(wood, cx0 + t, baseT, cz0, cx1 - t, yRoof, cz0 + t);
        const open = Math.min(0.22, cw - 2 * t - 0.08);
        const ox0 = (cx0 + cx1) / 2 - open / 2;
        const ox1 = ox0 + open;
        kit.box(wood, cx0 + t, baseT, cz1 - t, ox0, yRoof, cz1);
        kit.box(wood, ox1, baseT, cz1 - t, cx1 - t, yRoof, cz1);
        kit.box(wood, ox0, baseT + 0.24, cz1 - t, ox1, yRoof, cz1);
      }
    }
    return kit.build();
  },
};
