import { describe, expect, it } from 'vitest';
import charme from '../../fixtures/charme-3205.flat.json';
import { makeScene } from '../geometry/testUtil';
import type { MeshData } from '../geometry/types';
import { ownerAt } from '../geometry/builder';
import { buildShell } from '../geometry/shell';
import { parseScene } from '../parse';
import type { Item, Scene, Vec2 } from '../schema';
import { wallLength } from '../schema';
import { validateScene } from '../validate';
import { BUILTIN_ASSETS, ITEM_MATERIALS, TV_55_DIAGONAL_M, buildItems, itemBlocksWalking, itemFrontDirection } from './builtin';

const parsed = parseScene(charme);
if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
const flat: Scene = parsed.scene;

function bounds(mesh: MeshData, owner?: string) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    if (owner && ownerAt(mesh.owners, t)?.entityId !== owner) continue;
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k]!;
      for (let a = 0; a < 3; a++) {
        const c = mesh.positions[v * 3 + a]!;
        min[a] = Math.min(min[a]!, c);
        max[a] = Math.max(max[a]!, c);
      }
    }
  }
  return { min, max };
}

/** Convex polygon overlap depth by separating axes (> 0 means interiors intersect). */
function overlapDepth(a: Vec2[], b: Vec2[]): number {
  let depth = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const n: Vec2 = [q[1] - p[1], p[0] - q[0]];
      const len = Math.hypot(n[0], n[1]);
      const range = (pts: Vec2[]) => {
        const d = pts.map((pt) => (pt[0] * n[0] + pt[1] * n[1]) / len);
        return [Math.min(...d), Math.max(...d)] as const;
      };
      const [a0, a1] = range(a);
      const [b0, b1] = range(b);
      depth = Math.min(depth, Math.min(a1, b1) - Math.max(a0, b0));
    }
  }
  return depth;
}

function wallFootprint(w: Scene['walls'][number]): Vec2[] {
  const len = wallLength(w);
  const dx = (w.end[0] - w.start[0]) / len;
  const dy = (w.end[1] - w.start[1]) / len;
  const h = w.thickness / 2;
  const [nx, ny] = [-dy * h, dx * h];
  return [
    [w.start[0] + nx, w.start[1] + ny],
    [w.end[0] + nx, w.end[1] + ny],
    [w.end[0] - nx, w.end[1] - ny],
    [w.start[0] - nx, w.start[1] - ny],
  ];
}

describe('builtin:tv-55', () => {
  const tv = BUILTIN_ASSETS['builtin:tv-55']!;

  it('is a 55 inch 16:9 panel (diagonal 1.397 m within 1 cm) with a thin bezel', () => {
    expect(TV_55_DIAGONAL_M).toBeCloseTo(1.397, 3);
    expect(tv).toMatchObject({ category: 'electronics', mount: 'wall' });
    expect(tv.dims.w).toBeCloseTo(1.23, 2);
    expect(tv.dims.h).toBeCloseTo(0.71, 2);
    expect(tv.dims.d).toBeCloseTo(0.05, 3);
    const panelW = tv.dims.w - 0.012;
    const panelH = tv.dims.h - 0.025;
    expect(Math.abs(Math.hypot(panelW, panelH) - 1.397)).toBeLessThan(0.01);
    expect(panelW / panelH).toBeCloseTo(16 / 9, 2);
  });

  it('front direction follows rotation CCW from above (rotation 0 faces plan +y)', () => {
    const f = (rotation: number) => itemFrontDirection({ rotation }).map((v) => Math.round(v * 1e6) / 1e6 + 0);
    expect(f(0)).toEqual([0, 1]);
    expect(f(90)).toEqual([1, 0]);
    expect(f(180)).toEqual([0, -1]);
    expect(f(270)).toEqual([-1, 0]);
  });

  it('builds screen, body and bracket meshes owned by the item, with outward normals', () => {
    const mesh = buildShell(flat).items;
    expect(mesh.groups.map((g) => g.materialId).sort()).toEqual([ITEM_MATERIALS.tvBody, ITEM_MATERIALS.tvScreen]);
    expect(mesh.owners.every((o) => o.kind === 'item' && o.entityId === 'tv-sejour')).toBe(true);
    const owned = mesh.owners.reduce((n, o) => n + o.count, 0);
    expect(owned).toBe(mesh.indices.length / 3);
    // Screen faces +y: its +z-ish normals must point to plan +y (world +Z).
    const screenGroup = mesh.groups.find((g) => g.materialId === ITEM_MATERIALS.tvScreen)!;
    const normals = new Set<string>();
    for (let i = screenGroup.start; i < screenGroup.start + screenGroup.count; i++) {
      const v = mesh.indices[i]!;
      normals.add([0, 1, 2].map((a) => mesh.normals[v * 3 + a]!.toFixed(3)).join(','));
    }
    expect(normals.has('0.000,0.000,1.000')).toBe(true);
  });

  it('hangs flat against the séjour face of w-alcove, centred at about 1.10 m, clear of walls and the door', () => {
    expect(validateScene(flat).warnings).toEqual([]);
    const item = flat.items.find((i) => i.id === 'tv-sejour')!;
    expect(item).toMatchObject({ assetId: 'builtin:tv-55', roomId: 'sejour', rotation: 0 });
    expect(itemFrontDirection(item)).toEqual([0, 1]);

    const alcove = flat.walls.find((w) => w.id === 'w-alcove')!;
    const face = alcove.start[1] + alcove.thickness / 2; // 2.27
    const { min, max } = bounds(buildShell(flat).items, 'tv-sejour');
    expect(Math.abs(min[2]! - face)).toBeLessThan(0.01); // back against the face
    expect(max[2]! - min[2]!).toBeCloseTo(tv.dims.d, 3);
    expect((min[1]! + max[1]!) / 2).toBeCloseTo(1.1, 1);
    expect(max[0]! - min[0]!).toBeCloseTo(tv.dims.w, 3);
    expect(max[1]! - min[1]!).toBeCloseTo(tv.dims.h, 3);
    expect(max[1]!).toBeLessThan(alcove.height);

    const rect: Vec2[] = [
      [min[0]!, min[2]!],
      [max[0]!, min[2]!],
      [max[0]!, max[2]!],
      [min[0]!, max[2]!],
    ];
    for (const w of flat.walls) expect(overlapDepth(rect, wallFootprint(w)), w.id).toBeLessThan(1e-4);

    const door = flat.openings.find((o) => o.wallId === 'w-alcove')!;
    const doorFrom = door.offset - door.width / 2;
    const doorTo = door.offset + door.width / 2;
    expect(min[0]! >= doorTo || max[0]! <= doorFrom).toBe(true);
    // And it is centred on the free part of the wall east of the door.
    expect(min[0]!).toBeGreaterThan(doorTo + 0.5);
    expect(max[0]!).toBeLessThan(wallLength(alcove));
  });

  it('rotation turns the model about the item origin (rotation 90 faces +x)', () => {
    const scene = makeScene([{ id: 'w', start: [0, 0], end: [4, 0] }], [], {
      items: [{ id: 'tv', assetId: 'builtin:tv-55', position: [2, 3], elevation: 1, rotation: 90 }],
    });
    const { min, max } = bounds(buildItems(scene));
    expect(max[0]! - min[0]!).toBeCloseTo(tv.dims.d, 3);
    expect(max[2]! - min[2]!).toBeCloseTo(tv.dims.w, 3);
    expect(min[0]!).toBeCloseTo(2 - tv.dims.d / 2, 3);
  });

  it('wall-mounted items above 0.6 m do not block walking', () => {
    expect(itemBlocksWalking({ assetId: 'builtin:tv-55', elevation: 0.745 })).toBe(false);
    expect(itemBlocksWalking({ assetId: 'builtin:tv-55', elevation: 0.3 })).toBe(true);
    expect(itemBlocksWalking({ assetId: 'nope', elevation: 1 })).toBe(true);
  });
});

describe('unknown assets', () => {
  const item: Item = { id: 'mystery', assetId: 'catalog:sofa-9', position: [1, 1], elevation: 0, rotation: 0 };
  const scene = makeScene([{ id: 'w', start: [0, 0], end: [4, 0] }], [], { items: [item] });

  it('get a 0.3 m placeholder box owned by the item', () => {
    const mesh = buildItems(scene);
    expect(mesh.groups.map((g) => g.materialId)).toEqual([ITEM_MATERIALS.placeholder]);
    expect(mesh.owners).toEqual([{ start: 0, count: 12, kind: 'item', entityId: 'mystery' }]);
    const { min, max } = bounds(mesh);
    for (let a = 0; a < 3; a++) expect(max[a]! - min[a]!).toBeCloseTo(0.3, 5);
  });

  it('produce an unknown_asset validation warning', () => {
    const warnings = validateScene(scene).warnings.filter((w) => w.code === 'unknown_asset');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.entityIds).toEqual(['mystery']);
  });
});
