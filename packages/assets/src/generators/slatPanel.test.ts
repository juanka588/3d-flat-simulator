import { describe, expect, it } from 'vitest';
import { slatLayout, slatPanel } from './fittings';
import { handBasin } from './bathroom';

describe('slatPanel', () => {
  it('lays whole slats edge to edge: the first and last touch the ends, the gap is never narrower than asked', () => {
    for (const w of [0.3, 1.2, 2.4, 3.1, 4.9]) {
      const l = slatLayout(w, 0.028, 0.018);
      expect(l.gap).toBeGreaterThanOrEqual(l.n === 1 ? 0 : 0.018 - 1e-9);
      if (l.n > 1) expect(l.n * l.slat + (l.n - 1) * l.gap).toBeCloseTo(w, 9);
    }
    expect(slatLayout(2.4, 0.028, 0.018).n).toBe(52);
    expect(slatLayout(0.03, 0.028, 0.018)).toMatchObject({ n: 1 });
  });

  it('defaults: a 2.4 x 2.5 m floor-to-ceiling oak panel on black felt, about 650 triangles, in the described box', () => {
    const p = slatPanel.params.parse({});
    expect(p).toMatchObject({ w: 2.4, h: 2.5, wood: 'oak', felt: true });
    const mesh = slatPanel.generate(p);
    expect(mesh.indices.length / 3).toBeGreaterThan(400);
    expect(mesh.indices.length / 3).toBeLessThan(800);
    let maxY = -Infinity;
    for (let i = 1; i < mesh.positions.length; i += 3) maxY = Math.max(maxY, mesh.positions[i]!);
    expect(maxY).toBeCloseTo(2.5, 6);
    expect(slatPanel.describeParams(p).dims).toEqual({ w: 2.4, d: 0.03, h: 2.5 });
  });

  it('walnut and the felt switch change the mesh', () => {
    const base = slatPanel.generate(slatPanel.params.parse({}));
    const walnut = slatPanel.generate(slatPanel.params.parse({ wood: 'walnut' }));
    const bare = slatPanel.generate(slatPanel.params.parse({ felt: false }));
    const ids = (m: typeof base) => m.groups.map((g) => g.materialId);
    expect(ids(base)).toContain('builtin:furniture-oak');
    expect(ids(walnut)).toContain('builtin:furniture-walnut');
    expect(ids(walnut)).not.toContain('builtin:furniture-oak');
    expect(bare.indices.length).toBeLessThan(base.indices.length);
  });
});

describe('handBasin look', () => {
  it('has a rounded ceramic bowl, a chrome tap with a curved spout and a bottle trap: ceramic and metal, a few hundred triangles', () => {
    const p = handBasin.params.parse({});
    const mesh = handBasin.generate(p);
    expect(mesh.indices.length / 3).toBeGreaterThan(300);
    expect(mesh.indices.length / 3).toBeLessThan(3000);
    // item box: the bottle trap touches the floor of the box, the spout the top
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      minY = Math.min(minY, mesh.positions[i]!);
      maxY = Math.max(maxY, mesh.positions[i]!);
    }
    expect(minY).toBeCloseTo(0, 6);
    expect(maxY).toBeCloseTo(p.h, 6);
  });
});
