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

/**
 * The placard of Chambre 2 is a closet in the wall thickness: Chambre 2's polygon keeps it (the official 11.13 m2 includes
 * it) but its doors open onto the Entrée, so neither room has a wall along the closet front; same for the TE cupboard in the
 * SDB corner. These four `room-edge-unwalled` warnings are expected and nothing else is.
 */
const PLACARD_CH2_WARNINGS = [
  { code: 'room-edge-unwalled', room: 'ch2' },
  { code: 'room-edge-unwalled', room: 'entree' },
  // The TE cupboard, recessed in the SDB corner and open onto the Entrée: the gap of w-sdb-north leaves one unwalled edge on
  // each side (the SDB polygon keeps the recess, the Entrée's south edge has no wall along the cupboard front).
  { code: 'room-edge-unwalled', room: 'entree' },
  { code: 'room-edge-unwalled', room: 'sdb' },
];
const warningsOf = (scene: Scene) => validateScene(scene).warnings.map((w) => ({ code: w.code, room: w.entityIds[0] }));

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
    const mesh = buildItems({ items: flat.items.filter((i) => i.id === 'tv-sejour') }); // the TV alone (the flat also has locked placards)
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
    expect(warningsOf(flat)).toEqual(PLACARD_CH2_WARNINGS);
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

describe('buildItems with M5 mesh sources', () => {
  const wall = [{ id: 'w', start: [0, 0] as Vec2, end: [8, 0] as Vec2 }];
  const dims = { w: 1.8, d: 0.6, h: 2.4 };
  const base = { id: 'it', assetId: 'x', position: [3, 2] as Vec2 };
  const build = (patch: Record<string, unknown>) => buildItems(makeScene(wall, [], { items: [{ ...base, ...patch }] as never }));
  const box = (m: MeshData) => {
    const { min, max } = bounds(m);
    return { size: max.map((v, i) => v - min[i]!), min, max };
  };

  it('parametric items are generated at their exact dims, floor-aligned, centred on the position, owned by the item', () => {
    const mesh = build({ assetId: 'param:wardrobe', dims, locked: true, mesh: { kind: 'parametric', generator: 'wardrobe', params: { w: 1.8, d: 0.6, h: 2.4 } } });
    const b = box(mesh);
    expect(b.size[0]).toBeCloseTo(1.8, 3);
    expect(b.size[1]).toBeCloseTo(2.4, 3);
    expect(b.size[2]).toBeCloseTo(0.6, 3);
    expect(b.min[1]).toBeCloseTo(0, 5);
    expect((b.min[0]! + b.max[0]!) / 2).toBeCloseTo(3, 4);
    expect((b.min[2]! + b.max[2]!) / 2).toBeCloseTo(2, 4);
    expect(mesh.owners.every((o) => o.kind === 'item' && o.entityId === 'it')).toBe(true);
    expect(mesh.groups.length).toBeGreaterThan(1);
  });

  it('rotation 180 turns the front to plan -y (the doors face the room when the back is on the south wall)', () => {
    const mesh = build({ assetId: 'param:wardrobe', dims, rotation: 180, mesh: { kind: 'parametric', generator: 'wardrobe', params: { w: 1.8, d: 0.6, h: 2.4 } } });
    // Handles protrude furthest at the front: the front-most point (largest local z) must be at the smallest world z.
    const { min, max } = bounds(mesh);
    expect(min[2]).toBeCloseTo(2 - 0.3, 4);
    expect(max[2]).toBeCloseTo(2 + 0.3, 4);
    let handleZ = Infinity;
    const metal = mesh.groups.find((g) => g.materialId === ITEM_MATERIALS.metal)!;
    for (let i = metal.start; i < metal.start + metal.count; i++) handleZ = Math.min(handleZ, mesh.positions[mesh.indices[i]! * 3 + 2]!);
    expect(handleZ).toBeCloseTo(2 - 0.3, 3);
  });

  it('item dims stretch the generated shape (the scene check allows 2% slack, the footprint stays exact)', () => {
    const mesh = build({ assetId: 'param:wardrobe', dims: { w: 1.8, d: 0.6, h: 2.4 }, mesh: { kind: 'parametric', generator: 'wardrobe', params: { w: 1.79, d: 0.6, h: 2.4 } } });
    expect(box(mesh).size[0]).toBeCloseTo(1.8, 3);
  });

  it('provider and lookalike meshes are exact-dims placeholder boxes (the viewer swaps in the GLB)', () => {
    const provider = build({ assetId: 'product:mock', dims, productRef: { provider: 'mock', sku: 'A' }, mesh: { kind: 'provider' } });
    const lookalike = build({ assetId: 'lib:wardrobe', dims, mesh: { kind: 'lookalike', assetId: 'lib:wardrobe' } });
    for (const m of [provider, lookalike]) {
      expect(m.groups.map((g) => g.materialId)).toEqual([ITEM_MATERIALS.placeholder]);
      expect(m.owners).toEqual([{ start: 0, count: 12, kind: 'item', entityId: 'it' }]);
      const b = box(m);
      expect(b.size.map((v) => +v.toFixed(4))).toEqual([1.8, 2.4, 0.6]);
      expect(b.min[1]).toBeCloseTo(0, 6);
    }
  });

  it('a parametric mesh with an unknown generator is a placeholder box at its dims (bad params are rejected at parse time)', () => {
    for (const mesh of [{ kind: 'parametric', generator: 'no-such', params: {} }]) {
      const m = build({ assetId: 'param:x', dims, mesh });
      expect(m.groups.map((g) => g.materialId)).toEqual([ITEM_MATERIALS.placeholder]);
      expect(box(m).size.map((v) => +v.toFixed(4))).toEqual([1.8, 2.4, 0.6]);
    }
  });

  it('an item with no mesh but known dims gets a placeholder box at those dims; none keeps the 0.3 m cube', () => {
    expect(box(build({ assetId: 'custom:thing', dims })).size.map((v) => +v.toFixed(4))).toEqual([1.8, 2.4, 0.6]);
    expect(box(build({ assetId: 'custom:thing' })).size.map((v) => +v.toFixed(4))).toEqual([0.3, 0.3, 0.3]);
  });

  it('identical items share one generation but stay independently placed', () => {
    const mk = (id: string, x: number) => ({ id, assetId: 'param:chair', position: [x, 2] as Vec2, mesh: { kind: 'parametric' as const, generator: 'chair', params: {} } });
    const m = buildItems(makeScene(wall, [], { items: [mk('c1', 1), mk('c2', 2)] }));
    expect(new Set(m.owners.map((o) => o.entityId))).toEqual(new Set(['c1', 'c2']));
    expect(bounds(m, 'c2').min[0]! - bounds(m, 'c1').min[0]!).toBeCloseTo(1, 4);
  });
});

describe('built-in placard of Chambre 1 (M5.17, transcribed from the plan, locked); the one of Chambre 2 is in charme-fixtures.test.ts', () => {
  const wardrobes = [{ id: 'placard-ch1', room: 'ch1', wall: 'w-ch1-south', door: 'door-ch1' }];

  it.each(wardrobes)('$id is a locked sliding wardrobe flush against the inner face of $wall, opening north into the room', ({ id, room, wall }) => {
    const item = flat.items.find((i) => i.id === id)!;
    expect(item).toMatchObject({ assetId: 'param:wardrobe', locked: true, roomId: room, mount: 'floor', rotation: 180, mesh: { kind: 'parametric', generator: 'wardrobe', params: { doorType: 'sliding', h: 2.4 } } });
    expect(item.product).toBeUndefined(); // existing furniture: no invented product, EUR 0 in the budget
    expect(itemFrontDirection(item)).toEqual([expect.closeTo(0, 9), -1]);

    const w = flat.walls.find((x) => x.id === wall)!;
    const face = w.start[1] - w.thickness / 2; // north (room) face of a south wall
    const { min, max } = bounds(buildShell(flat).items, id);
    expect(max[2]!).toBeCloseTo(face, 3);
    expect(max[1]! - min[1]!).toBeCloseTo(2.4, 3);
    expect(max[2]! - min[2]!).toBeCloseTo(0.6, 3);
    expect(max[1]!).toBeLessThan(w.height);

    const poly = flat.rooms.find((r) => r.id === room)!.polygon;
    for (const [x, z] of [[min[0]!, min[2]!], [max[0]!, min[2]!], [max[0]!, max[2]!], [min[0]!, max[2]!]] as Vec2[]) {
      expect(x).toBeGreaterThanOrEqual(Math.min(...poly.map((p) => p[0])) - 1e-3);
      expect(x).toBeLessThanOrEqual(Math.max(...poly.map((p) => p[0])) + 1e-3);
      expect(z).toBeGreaterThanOrEqual(Math.min(...poly.map((p) => p[1])) - 1e-3);
      expect(z).toBeLessThanOrEqual(face + 1e-3);
    }
    const rect: Vec2[] = [[min[0]!, min[2]!], [max[0]!, min[2]!], [max[0]!, max[2]!], [min[0]!, max[2]!]];
    for (const other of flat.walls) expect(overlapDepth(rect, wallFootprint(other)), other.id).toBeLessThan(1e-3);
  });

  it.each(wardrobes)('$id stays clear of the swing of $door and leaves the doorway free', ({ id, wall, door }) => {
    const w = flat.walls.find((x) => x.id === wall)!;
    const o = flat.openings.find((x) => x.id === door)!;
    const { min, max } = bounds(buildShell(flat).items, id);
    const from = w.start[0] + o.offset - o.width / 2;
    const to = w.start[0] + o.offset + o.width / 2;
    const hinge = o.hinge === 'end' ? to : from;
    const face = w.start[1] - w.thickness / 2;
    // Distance from the hinge point (on the room face) to the placard rectangle must exceed the leaf width.
    const dx = Math.max(min[0]! - hinge, 0, hinge - max[0]!);
    const dz = Math.max(min[2]! - face, 0, face - max[2]!);
    expect(Math.hypot(dx, dz)).toBeGreaterThan(o.width);
    expect(min[0]! >= to || max[0]! <= from).toBe(true);
  });

  it('the Charme flat has only the documented placard warnings and the existing furniture costs nothing in the bill of materials', async () => {
    expect(warningsOf(flat)).toEqual(PLACARD_CH2_WARNINGS);
    const { billOfMaterials } = await import('../bill-of-materials');
    const bom = billOfMaterials(flat);
    const locked = bom.lines.filter((l) => l.locked);
    expect(locked.length).toBe(flat.items.filter((i) => i.locked).length);
    expect(locked.map((l) => [l.itemId, l.roomId, l.amount]).slice(0, 2)).toEqual([['placard-ch1', 'ch1', 0], ['placard-ch2', 'entree', 0]]);
    expect(locked.every((l) => l.existing && l.amount === 0)).toBe(true);
    expect(bom.missingPrice).toEqual(['tv-sejour']); // the legacy TV is the only unpriced, unlocked item
    expect(bom.totalEur).toBe(0);
  });
});
