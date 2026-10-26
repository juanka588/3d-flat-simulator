import { describe, expect, it } from 'vitest';
import charme from '../../fixtures/charme-3205.flat.json';
import sample from '../../fixtures/sample.flat.json';
import { parseScene } from '../parse';
import type { Scene } from '../schema';
import { buildFittings } from './fittings';
import { computeWallJunctions } from './junctions';
import { bounds, makeScene, materialTriangles, triangles, uRatios } from './testUtil';
import { BUILTIN_MATERIALS } from './types';

const wall = { id: 'w', start: [0, 0] as [number, number], end: [6, 0] as [number, number], thickness: 0.2, height: 2.5 };

function load(fixture: unknown): Scene {
  const r = parseScene(fixture);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.scene;
}

describe('buildFittings', () => {
  const scene = makeScene([wall], [
    { id: 'win', wallId: 'w', type: 'window', offset: 1.5, width: 1.0, height: 1.2, sill: 0.9 },
    { id: 'door', wallId: 'w', type: 'door', offset: 3.5, width: 0.9, height: 2.1 },
    { id: 'gdoor', wallId: 'w', type: 'door', offset: 5.2, width: 0.9, height: 2.1, sill: 0.1, glazed: true },
    { id: 'pass', wallId: 'w', type: 'passage', offset: 0.4, width: 0.5, height: 2.0 },
  ]);
  const { fittings, glass } = buildFittings(scene);

  it('creates nothing for passages and owns everything by its opening', () => {
    const ids = new Set([...fittings.owners, ...glass.owners].map((o) => o.entityId));
    expect(ids).toEqual(new Set(['win', 'door', 'gdoor']));
    for (const o of [...fittings.owners, ...glass.owners]) expect(o.kind).toBe('opening');
  });

  it('uses frame, door and glass materials in the right meshes', () => {
    const fittingMats = new Set(fittings.groups.map((g) => g.materialId));
    expect(fittingMats).toEqual(new Set([BUILTIN_MATERIALS.frame, BUILTIN_MATERIALS.door]));
    expect(new Set(glass.groups.map((g) => g.materialId))).toEqual(new Set([BUILTIN_MATERIALS.glass]));
    // Leaf only for the unglazed door.
    const leaf = materialTriangles(fittings, BUILTIN_MATERIALS.door);
    expect(leaf.length).toBeGreaterThan(0);
    for (const o of scene.openings) {
      const own = materialTriangles(fittings, BUILTIN_MATERIALS.door, (ow) => ow.entityId === o.id);
      expect(own.length > 0).toBe(o.id === 'door');
    }
    // Glass for the window and the glazed door only.
    expect(new Set(glass.owners.map((o) => o.entityId))).toEqual(new Set(['win', 'gdoor']));
  });

  it('keeps every fitting inside its hole within 1 mm', () => {
    const tol = 1e-3;
    for (const o of scene.openings.filter((x) => x.type !== 'passage')) {
      for (const mesh of [fittings, glass]) {
        const tris = triangles(mesh, (ow) => ow.entityId === o.id);
        if (!tris.length) continue;
        const b = bounds(tris);
        expect(b.min[0]).toBeGreaterThanOrEqual(o.offset - o.width / 2 - tol);
        expect(b.max[0]).toBeLessThanOrEqual(o.offset + o.width / 2 + tol);
        expect(b.min[1]).toBeGreaterThanOrEqual(o.sill - tol);
        expect(b.max[1]).toBeLessThanOrEqual(o.sill + o.height + tol);
      }
      // Frames and glass stay inside the wall slab (the open door leaf is checked separately).
      const slab = materialTriangles(fittings, BUILTIN_MATERIALS.frame, (ow) => ow.entityId === o.id);
      const gl = triangles(glass, (ow) => ow.entityId === o.id);
      for (const tris of [slab, gl]) {
        if (!tris.length) continue;
        const b = bounds(tris);
        expect(b.min[2]).toBeGreaterThanOrEqual(-0.1 - tol);
        expect(b.max[2]).toBeLessThanOrEqual(0.1 + tol);
      }
    }
  });

  it('has no threshold member for sill-0 doors', () => {
    const b = bounds(triangles(fittings, (o) => o.entityId === 'door'));
    expect(b.min[1]).toBeCloseTo(0, 6);
    // Leaf reaches the floor; the frame has no bottom bar above it.
    const frameBottom = triangles(fittings, (o) => o.entityId === 'door').filter(
      (t) => t.n[1]! > 0.99 && t.p[0][1]! > 0.001 && t.p[0][1]! < 0.1,
    );
    expect(frameBottom).toHaveLength(0);
  });

  it('has valid, unit-normal, non-degenerate geometry', () => {
    for (const mesh of [fittings, glass]) {
      expect(mesh.positions.every(Number.isFinite)).toBe(true);
      for (const t of triangles(mesh)) expect(t.area).toBeGreaterThan(1e-9);
      let n = 0;
      for (const o of mesh.owners) {
        expect(o.start).toBe(n);
        n += o.count;
      }
      expect(n * 3).toBe(mesh.indices.length);
      for (let v = 0; v < mesh.normals.length; v += 3) {
        expect(Math.hypot(mesh.normals[v]!, mesh.normals[v + 1]!, mesh.normals[v + 2]!)).toBeCloseTo(1, 5);
      }
    }
  });

  it('draws exactly one glass quad per pane', () => {
    for (const id of ['win', 'gdoor']) {
      const tris = triangles(glass, (o) => o.entityId === id);
      expect(tris).toHaveLength(2);
      for (const t of tris) expect(Math.abs(t.n[2]!)).toBeGreaterThan(0.99);
    }
  });

  it('makes u grow to the viewer\'s right on both faces', () => {
    // Wall along +x: left normal is world -z (viewer's right is -x); right normal is +z (right is +x).
    for (const mesh of [fittings, glass]) {
      const leftRatios = uRatios(mesh, [0, 0, -1], [-1, 0, 0]);
      expect(leftRatios.length).toBeGreaterThan(0);
      for (const r of leftRatios) expect(r).toBeCloseTo(1, 4);
    }
    const rightRatios = uRatios(fittings, [0, 0, 1], [1, 0, 0]);
    expect(rightRatios.length).toBeGreaterThan(0);
    for (const r of rightRatios) expect(r).toBeCloseTo(1, 4);
  });

  it('builds both fixtures finitely and cheaply', () => {
    for (const fixture of [charme, sample]) {
      const s = load(fixture);
      const m = buildFittings(s);
      expect(m.fittings.positions.every(Number.isFinite)).toBe(true);
      expect(m.glass.positions.every(Number.isFinite)).toBe(true);
      expect(m.fittings.indices.length / 3 + m.glass.indices.length / 3).toBeLessThan(
        s.openings.length * 80,
      );
      const withFittings = new Set([...m.fittings.owners, ...m.glass.owners].map((o) => o.entityId));
      for (const o of s.openings) expect(withFittings.has(o.id)).toBe(o.type !== 'passage');
    }
  });
});

describe('open door leaves', () => {
  const W = { id: 'w', start: [0, 0] as [number, number], end: [6, 0] as [number, number], thickness: 0.2, height: 2.5 };
  const combos = [
    ['start', 'left'],
    ['start', 'right'],
    ['end', 'left'],
    ['end', 'right'],
  ] as const;
  const tol = 1e-3;
  // Door at offset 3, width 0.9: frame members are 0.05 wide, leaf thickness 0.04.
  const s0 = 3 - 0.45 + 0.05;
  const s1 = 3 + 0.45 - 0.05;
  const width = s1 - s0;

  it.each(combos)('hinge %s, swing %s: leaf lies against the wall face, within one leaf width of the hinge', (hinge, swing) => {
    const s = makeScene([W], [{ id: 'd', wallId: 'w', type: 'door', offset: 3, width: 0.9, height: 2.1, hinge, swing }]);
    const { fittings } = buildFittings(s);
    const leaf = materialTriangles(fittings, BUILTIN_MATERIALS.door);
    expect(leaf.length).toBeGreaterThan(0);
    const b = bounds(leaf);
    if (hinge === 'start') {
      expect(b.min[0]).toBeCloseTo(s0, 3);
      expect(b.max[0]).toBeLessThanOrEqual(s0 + 0.04 + tol);
    } else {
      expect(b.max[0]).toBeCloseTo(s1, 3);
      expect(b.min[0]).toBeGreaterThanOrEqual(s1 - 0.04 - tol);
    }
    // The +x wall's left normal is world -z.
    if (swing === 'left') {
      expect(b.max[2]).toBeCloseTo(-0.1, 3);
      expect(b.min[2]).toBeCloseTo(-0.1 - width, 3);
    } else {
      expect(b.min[2]).toBeCloseTo(0.1, 3);
      expect(b.max[2]).toBeCloseTo(0.1 + width, 3);
    }
    expect(b.min[1]).toBeCloseTo(0, 3);
  });

  it('defaults to hinge start, swing left', () => {
    const s = makeScene([W], [{ id: 'd', wallId: 'w', type: 'door', offset: 3, width: 0.9, height: 2.1 }]);
    const { fittings } = buildFittings(s);
    const b = bounds(materialTriangles(fittings, BUILTIN_MATERIALS.door));
    expect(b.min[0]).toBeCloseTo(s0, 3);
    expect(b.min[2]).toBeCloseTo(-0.1 - width, 3);
  });

  it.each(combos)('hinge %s, swing %s: no leaf triangle lies in the passable volume of the hole', (hinge, swing) => {
    const s = makeScene([W], [{ id: 'd', wallId: 'w', type: 'door', offset: 3, width: 0.9, height: 2.1, hinge, swing }]);
    const { fittings } = buildFittings(s);
    for (const t of materialTriangles(fittings, BUILTIN_MATERIALS.door)) {
      const c = [0, 1, 2].map((k) => (t.p[0][k]! + t.p[1][k]! + t.p[2][k]!) / 3);
      const inside = c[0]! > s0 + 0.04 && c[0]! < s1 - 0.04 && Math.abs(c[2]!) < 0.1 - tol && c[1]! > 0 && c[1]! < 2.1;
      expect(inside).toBe(false);
      // Stricter: the whole doorway (between the frame jambs) is clear of the leaf's triangles.
      for (const p of t.p) {
        const within = p[0]! > s0 + 0.04 + tol && p[0]! < s1 - 0.04 - tol && Math.abs(p[2]!) < 0.1 - tol;
        expect(within).toBe(false);
      }
    }
  });
});

describe('fittings next to junctions', () => {
  const walls = [
    { id: 'host', start: [0, 0] as [number, number], end: [10, 0] as [number, number], thickness: 0.2, height: 2.5 },
    { id: 'stem', start: [5, 4] as [number, number], end: [5, 0] as [number, number], thickness: 0.1, height: 2.5 },
  ];

  it('keeps every fitting inside its (clamped) wall hole, also on a T-stem door reaching the host face', () => {
    // Stem is 4 m long; the door spans 3.7..4.3 and runs past the end, up to the host face.
    const scene = makeScene(walls, [
      { id: 'd', wallId: 'stem', type: 'door', offset: 3.7, width: 0.6, height: 2.1 },
      { id: 'w', wallId: 'stem', type: 'window', offset: 1, width: 0.6, height: 1, sill: 1 },
    ]);
    const fp = computeWallJunctions(scene.walls).get('stem')!;
    const hi = Math.min(fp.endLeft, fp.endRight);
    expect(hi).toBeLessThan(4);
    const { fittings, glass } = buildFittings(scene);
    const door = bounds(triangles(fittings, (o) => o.entityId === 'd'));
    // Stem runs from (5,4) to (5,0), so s = 4 - z.
    const sOf = (z: number) => 4 - z;
    expect(sOf(door.min[2]!)).toBeGreaterThanOrEqual(3.4 - 1e-3);
    expect(sOf(door.max[2]!)).toBeLessThanOrEqual(hi + 1e-3);
    for (const mesh of [fittings, glass]) {
      for (const t of triangles(mesh, (o) => o.entityId === 'd')) {
        for (const p of t.p) expect(sOf(p[2]!)).toBeLessThanOrEqual(hi + 1e-3);
      }
    }
  });
});
