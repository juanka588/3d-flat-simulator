import { describe, expect, it } from 'vitest';
import { ITEM_MATERIALS, buildItems } from '@flat/assets';
import type { Item } from '@flat/scene';
import { itemMatrix } from './model-math';
import type { Box, Front } from './model-math';

/**
 * The mattress / duvet / pillows we draw on a bed FRAME (`buildItems`, world space) must sit exactly on the sleeping area of the
 * frame MODEL (`itemMatrix`, the transform the viewer gives the GLB) for any item rotation, whether the file was authored the right
 * way round or needs the quarter turn (`front: '+x'`). Synthetic MANDAL-like bed: 240 cm headboard, 205.6 cm long, 160 x 200 mattress.
 */

const DIMS = { w: 2.4, d: 2.056, h: 0.835 };
const MATTRESS = { w: 1.6, d: 2.0 };

const item = (rotation: number): Item =>
  ({
    id: 'bed',
    assetId: 'product:ikea-fr',
    position: [3.7, -1.2],
    elevation: 0,
    rotation,
    mesh: { kind: 'provider' },
    dims: DIMS,
    product: { provider: 'ikea-fr', sku: '89094948', name: 'MANDAL Structure lit avec tête de lit - bouleau/blanc 160x200 cm', url: 'https://shop.example/p/x-89094948/', price: 599, currency: 'EUR', dims: DIMS, category: 'bed', snapshotAt: '2026-10-27T10:00:00.000Z' },
  }) as Item;

/** Native boxes of the model (arbitrary pivot, to prove the auto-pivot is accounted for) and where its sleeping area is in them. */
const CASES: { name: string; front: Front; native: Box; sleeping: (n: Box) => { x: [number, number]; z: [number, number] } }[] = [
  {
    // authored the right way round: headboard along x, head at -z, foot at +z
    name: 'unturned model (front +z)',
    front: '+z',
    native: { min: [5, 0, -3], max: [5 + DIMS.w, DIMS.h, -3 + DIMS.d] },
    sleeping: (n) => ({ x: [(n.min[0] + n.max[0]) / 2 - MATTRESS.w / 2, (n.min[0] + n.max[0]) / 2 + MATTRESS.w / 2], z: [n.max[2] - MATTRESS.d, n.max[2]] }),
  },
  {
    // a file whose front is +x (headboard along z, head at -x, foot at +x): the viewer turns it a quarter
    name: 'model turned a quarter at load (front +x)',
    front: '+x',
    native: { min: [-2, 0, 4], max: [-2 + DIMS.d, DIMS.h, 4 + DIMS.w] },
    sleeping: (n) => ({ x: [n.max[0] - MATTRESS.d, n.max[0]], z: [(n.min[2] + n.max[2]) / 2 - MATTRESS.w / 2, (n.min[2] + n.max[2]) / 2 + MATTRESS.w / 2] }),
  },
];

/** World vertices of the mattress (and pillows, which lie on it): the `whiteMatte` group of the dressing. */
function mattressVertices(rotation: number): [number, number][] {
  const mesh = buildItems({ items: [] }, { dressed: [item(rotation)] });
  const group = mesh.groups.find((g) => g.materialId === ITEM_MATERIALS.whiteMatte)!;
  const out: [number, number][] = [];
  for (let k = group.start; k < group.start + group.count; k++) {
    const v = mesh.indices[k]!;
    out.push([mesh.positions[v * 3]!, mesh.positions[v * 3 + 2]!]);
  }
  return out;
}

describe('bed dressing stays on the sleeping area of the model', () => {
  for (const c of CASES) {
    for (const rotation of [0, 90, 180, 270, 37]) {
      it(`${c.name}, item rotated ${rotation} degrees: centre within 1 cm, axes within 0.5 degrees`, () => {
        const it0 = item(rotation);
        const m = itemMatrix({ position: it0.position, elevation: 0, rotation }, c.native, c.front, DIMS);
        const s = c.sleeping(c.native);
        const e = m.elements;
        const world = (x: number, z: number): [number, number] => [e[0]! * x + e[8]! * z + e[12]!, e[2]! * x + e[10]! * z + e[14]!];
        // Expected sleeping rectangle in the world: centre, width axis (across the bed) and length axis (head to foot).
        const [cx, cz] = world((s.x[0] + s.x[1]) / 2, (s.z[0] + s.z[1]) / 2);
        const sx = c.front === '+z' ? 1 : 0; // which native axis runs across the bed
        const across = world((s.x[0] + s.x[1]) / 2 + (sx ? 1 : 0), (s.z[0] + s.z[1]) / 2 + (sx ? 0 : 1));
        const ua: [number, number] = [across[0] - cx, across[1] - cz];
        const ul: [number, number] = [-ua[1], ua[0]]; // perpendicular: along the bed (sign irrelevant)
        const verts = mattressVertices(rotation);
        const along = (p: [number, number], u: [number, number]) => (p[0] - cx) * u[0] + (p[1] - cz) * u[1];
        const range = (u: [number, number]) => {
          const a = verts.map((p) => along(p, u));
          return [Math.min(...a), Math.max(...a)] as const;
        };
        const [a0, a1] = range(ua);
        const [l0, l1] = range(ul);
        // Centre: the mattress is symmetric about the expected centre across the bed, and its length range matches the sleeping area.
        expect(Math.abs((a0 + a1) / 2)).toBeLessThan(0.01);
        expect(Math.abs((l0 + l1) / 2)).toBeLessThan(0.01);
        expect(Math.abs(a1 - a0 - MATTRESS.w)).toBeLessThan(0.01);
        expect(Math.abs(l1 - l0 - MATTRESS.d)).toBeLessThan(0.01);
        // Axes: every vertex lies within the expected rectangle (+ 1 cm), so a rotation error would push corners out of it.
        // 0.5 degrees over a 2 m length is 1.7 cm, so the 1 cm band also bounds the angle.
        for (const p of verts) {
          expect(Math.abs(along(p, ua))).toBeLessThanOrEqual(MATTRESS.w / 2 + 0.01);
          expect(Math.abs(along(p, ul))).toBeLessThanOrEqual(MATTRESS.d / 2 + 0.01);
        }
      });
    }
  }
});
