import { describe, expect, it } from 'vitest';
import charme from '../../fixtures/charme-3205.flat.json';
import sample from '../../fixtures/sample.flat.json';
import { parseScene } from '../parse';
import type { Scene } from '../schema';
import { buildFittings } from './fittings';
import { bounds, makeScene, triangles } from './testUtil';
import type { MeshData } from './types';
import { BUILTIN_MATERIALS } from './types';

const wall = { id: 'w', start: [0, 0] as [number, number], end: [6, 0] as [number, number], thickness: 0.2, height: 2.5 };
const mat = (m: MeshData, ownerIdx: number) => {
  const o = m.owners[ownerIdx]!;
  return m.groups.find((g) => g.start <= o.start * 3 && o.start * 3 < g.start + g.count)!.materialId;
};

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
    const leafOwners = fittings.owners.filter((_, i) => mat(fittings, i) === BUILTIN_MATERIALS.door);
    expect(new Set(leafOwners.map((o) => o.entityId))).toEqual(new Set(['door']));
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

  it('draws glass on both sides', () => {
    const tris = triangles(glass, (o) => o.entityId === 'win');
    expect(tris.some((t) => t.n[2]! > 0.99)).toBe(true);
    expect(tris.some((t) => t.n[2]! < -0.99)).toBe(true);
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
