import { describe, expect, it } from 'vitest';
import charmeContext from '../../fixtures/charme-3205.context.json';
import charmeFlat from '../../fixtures/charme-3205.flat.json';
import { triangles } from '../geometry/testUtil';
import type { Vec2 } from '../schema';
import { CONTEXT_MATERIALS, buildContextMeshes } from './mesh';
import { SiteContext } from './schema';

const ctx = (buildings: SiteContext['buildings']): SiteContext => ({
  version: 1,
  source: 'test',
  origin: { latitude: 48.8, longitude: 2.3 },
  northAngle: 0,
  buildings,
});

const shoelace = (p: Vec2[]) => Math.abs(p.reduce((a, q, i) => a + q[0] * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * q[1], 0) / 2);

// Concave L, in plan coordinates (y down), listed counter-clockwise on screen.
const L: Vec2[] = [
  [0, 0],
  [0, 10],
  [4, 10],
  [4, 4],
  [10, 4],
  [10, 0],
];
const L_AREA = 40 + 24; // 4x10 leg + 6x4 bar

function build(buildings: SiteContext['buildings']) {
  return buildContextMeshes(SiteContext.parse(ctx(buildings)));
}

describe('buildContextMeshes', () => {
  it('is empty without buildings', () => {
    expect(build([]).indices.length).toBe(0);
  });

  it.each([
    ['clockwise on screen', L],
    ['counter-clockwise on screen', [...L].reverse()],
  ])('extrudes a concave footprint (%s) with outward walls and a roof of the footprint area', (_n, footprint) => {
    const mesh = build([{ id: 'b1', footprint, base: -5.8, height: 9, host: false }]);
    const mine = (o: { entityId: string }) => o.entityId === 'b1';
    const all = triangles(mesh, mine);
    const up = all.filter((t) => t.n[1]! > 0.99);
    const side = all.filter((t) => Math.abs(t.n[1]!) < 1e-6);
    expect(up.reduce((s, t) => s + t.area, 0)).toBeCloseTo(L_AREA, 4);
    expect(up.every((t) => t.p.every((p) => Math.abs(p[1]! - 3.2) < 1e-5))).toBe(true);
    // Walls: total area = perimeter * height, every normal points away from the solid.
    expect(side.reduce((s, t) => s + t.area, 0)).toBeCloseTo((10 + 4 + 6 + 6 + 4 + 10) * 9, 3);
    expect(all.length).toBe(up.length + side.length); // no underside at ground level
    for (const t of side) {
      const cx = (t.p[0][0]! + t.p[1][0]! + t.p[2][0]!) / 3;
      const cz = (t.p[0][2]! + t.p[1][2]! + t.p[2][2]!) / 3;
      // Step slightly outwards along the normal: that point must be outside the footprint.
      const px = cx + t.n[0]! * 0.01;
      const pz = cz + t.n[2]! * 0.01;
      expect(inside(footprint, [px, pz])).toBe(false);
      expect(inside(footprint, [cx - t.n[0]! * 0.01, cz - t.n[2]! * 0.01])).toBe(true);
    }
  });

  it('spans base to base + height and stores the plan y in world z', () => {
    const mesh = build([{ id: 'b1', footprint: [[0, 0], [2, 0], [2, 3], [0, 3]], base: -5.8, height: 21.1, host: false }]);
    const tris = triangles(mesh, (o) => o.entityId === 'b1');
    const ys = tris.flatMap((t) => t.p.map((p) => p[1]!));
    expect(Math.min(...ys)).toBeCloseTo(-5.8, 4);
    expect(Math.max(...ys)).toBeCloseTo(15.3, 4);
    const zs = tris.flatMap((t) => t.p.map((p) => p[2]!));
    expect(Math.max(...zs)).toBeCloseTo(3, 4);
  });

  it('closes an elevated building from below', () => {
    const sq: Vec2[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
    const mesh = build([
      { id: 'ground', footprint: sq, base: -5.8, height: 3, host: false },
      { id: 'upper', footprint: sq, base: 2.8, height: 5, host: true },
    ]);
    const under = triangles(mesh, (o) => o.entityId === 'upper').filter((t) => t.n[1]! < -0.99);
    expect(under.reduce((s, t) => s + t.area, 0)).toBeCloseTo(16, 4);
    expect(triangles(mesh, (o) => o.entityId === 'ground').filter((t) => t.n[1]! < -0.99)).toHaveLength(0);
  });

  it('assigns owners and materials, and puts a ground plane at the lowest base', () => {
    const mesh = build([
      { id: 'n1', footprint: [[0, 0], [4, 0], [4, 4], [0, 4]], base: -5.8, height: 6, host: false },
      { id: 'h1', footprint: [[10, 0], [14, 0], [14, 4], [10, 4]], base: -5.8, height: 6, host: true },
      { id: 'far', footprint: [[0, 20], [2, 20], [2, 22], [0, 22]], base: -4, height: 3, host: false },
    ]);
    expect(new Set(mesh.owners.map((o) => o.kind))).toEqual(new Set(['context']));
    expect(new Set(mesh.owners.map((o) => o.entityId))).toEqual(new Set(['n1', 'h1', 'far', 'ground']));
    const materialOf = (entity: string) => {
      const o = mesh.owners.find((x) => x.entityId === entity)!;
      return mesh.groups.find((g) => g.start <= o.start * 3 && o.start * 3 < g.start + g.count)!.materialId;
    };
    expect(materialOf('n1')).toBe(CONTEXT_MATERIALS.building);
    expect(materialOf('h1')).toBe(CONTEXT_MATERIALS.host);
    expect(materialOf('ground')).toBe('builtin:ground');
    expect(CONTEXT_MATERIALS.building).toBe('builtin:context-building');
    expect(CONTEXT_MATERIALS.host).toBe('builtin:context-host');

    const ground = triangles(mesh, (o) => o.entityId === 'ground');
    expect(ground).toHaveLength(2);
    expect(ground.every((t) => t.n[1]! > 0.99 && t.p.every((p) => Math.abs(p[1]! + 5.8) < 1e-5))).toBe(true);
    const xs = ground.flatMap((t) => t.p.map((p) => p[0]!));
    const zs = ground.flatMap((t) => t.p.map((p) => p[2]!));
    expect(Math.min(...xs)).toBeLessThanOrEqual(-50);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(64);
    expect(Math.min(...zs)).toBeLessThanOrEqual(-50);
    expect(Math.max(...zs)).toBeGreaterThanOrEqual(72);
    // Owner table covers every triangle exactly once, in order.
    let next = 0;
    for (const o of mesh.owners) {
      expect(o.start).toBe(next);
      next += o.count;
    }
    expect(next).toBe(mesh.indices.length / 3);
  });

  it('ignores degenerate footprints', () => {
    const mesh = build([
      { id: 'line', footprint: [[0, 0], [1, 1], [2, 2]], base: 0, height: 3, host: false },
      { id: 'ok', footprint: [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], base: 0, height: 3, host: false },
    ]);
    expect(new Set(mesh.owners.map((o) => o.entityId))).toEqual(new Set(['ok', 'ground']));
  });
});

function inside(poly: Vec2[], pt: [number, number]): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}

// ------------------------------------------------------------------ the generated fixture

/** Area of polygon ∩ axis-aligned rectangle (Sutherland-Hodgman against the four sides). */
function overlapArea(poly: Vec2[], r: { minX: number; maxX: number; minY: number; maxY: number }): number {
  const sides: ((p: Vec2) => number)[] = [(p) => p[0] - r.minX, (p) => r.maxX - p[0], (p) => p[1] - r.minY, (p) => r.maxY - p[1]];
  let p = poly;
  for (const f of sides) {
    const out: Vec2[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % p.length]!;
      const fa = f(a);
      const fb = f(b);
      if (fa >= 0) out.push(a);
      if (fa >= 0 !== fb >= 0) {
        const t = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    p = out;
    if (p.length < 3) return 0;
  }
  return shoelace(p);
}

describe('charme-3205.context.json', () => {
  const context = SiteContext.parse(charmeContext);
  const walls = charmeFlat.walls;
  const pts = walls.flatMap((w) => [w.start, w.end]);
  const flatBounds = {
    minX: Math.min(...pts.map((p) => p[0]!)) - 0.1,
    maxX: Math.max(...pts.map((p) => p[0]!)) + 0.1,
    minY: Math.min(...pts.map((p) => p[1]!)) - 0.1,
    maxY: Math.max(...pts.map((p) => p[1]!)) + 0.1,
  };
  const floor = charmeFlat.site.floorElevation;
  const flatTop = Math.max(...walls.map((w) => w.height ?? 2.5));

  it('validates against the SiteContext schema', () => {
    expect(SiteContext.safeParse(charmeContext).success).toBe(true);
    expect(context.buildings.length).toBeGreaterThan(20);
  });

  it('matches the flat file: northAngle and origin', () => {
    expect(context.northAngle).toBe(charmeFlat.site.northAngle);
    expect(context.origin.latitude).toBeCloseTo(charmeFlat.site.latitude, 5);
    expect(context.origin.longitude).toBeCloseTo(charmeFlat.site.longitude, 5);
  });

  it('puts ground at -floorElevation and gives every building a height', () => {
    for (const b of context.buildings.filter((x) => !x.host)) {
      expect(b.base).toBeCloseTo(-floor, 6);
      expect(b.height).toBeGreaterThan(1);
      expect(b.height).toBeLessThan(80);
    }
  });

  it('marks the host building (Hall Charme, about 21 m) and leaves the flat out of its solid', () => {
    const host = context.buildings.filter((b) => b.host);
    expect(host.length).toBeGreaterThanOrEqual(2);
    const roof = Math.max(...host.map((b) => b.base + b.height));
    expect(roof - -floor).toBeCloseTo(21.1, 1);
    // No host solid occupies the flat's bounds at the flat's own height.
    for (const b of host) {
      const z0 = b.base;
      const z1 = b.base + b.height;
      const overlapsHeight = z0 < flatTop && z1 > 0;
      if (overlapsHeight) expect(overlapArea(b.footprint as Vec2[], flatBounds), b.id).toBeLessThan(1e-6);
    }
    // ...but the building does surround it: the host footprint covers most of the flat.
    const below = host.find((b) => b.id.endsWith(':below'))!;
    expect(overlapArea(below.footprint as Vec2[], flatBounds)).toBeGreaterThan(50);
  });

  it('does not let any non-host building intersect the flat', () => {
    for (const b of context.buildings.filter((x) => !x.host)) {
      expect(overlapArea(b.footprint as Vec2[], flatBounds), b.id).toBeLessThan(1e-6);
    }
  });

  it('meshes with host and neighbour materials and a ground plane', () => {
    const mesh = buildContextMeshes(context);
    const materials = new Set(mesh.groups.map((g) => g.materialId));
    expect(materials).toEqual(new Set(['builtin:context-building', 'builtin:context-host', 'builtin:ground']));
    expect(mesh.indices.length / 3).toBeGreaterThan(500);
    expect(mesh.owners.some((o) => o.entityId === 'ground')).toBe(true);
  });
});
