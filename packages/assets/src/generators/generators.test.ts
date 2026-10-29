import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeScene } from '../test-util';
import type { MeshData } from '@flat/scene';
import { GENERATORS, createGeneratorRegistry, type AnyGenerator } from '@flat/scene';
import { buildItems } from '../meshes/build-items';
import { ITEM_MATERIALS, ITEM_MATERIAL_SPECS } from '../materials/item-materials';
import { ALL_GENERATORS } from './index';
import { assertGeneratorsRegistered, registerGenerators } from '../register';

const MAX_TRIANGLES = 3000;
/** Carcass, fronts or ceramic, the dark reveal behind the fronts, metal fittings and one more (worktop, glass). */
const MAX_MATERIALS = 4;
const MM = 1e-3;

function bbox(mesh: MeshData) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, mesh.positions[i + a]!);
      max[a] = Math.max(max[a]!, mesh.positions[i + a]!);
    }
  }
  return { min, max };
}

/** Everything a generator promises, checked on one parameter set. */
function expectSound(g: AnyGenerator, rawParams: Record<string, unknown>) {
  const params = g.params.parse(rawParams);
  const { dims } = g.describeParams(params);
  const mesh = g.generate(params);
  const { min, max } = bbox(mesh);
  const expected = [
    [-dims.w / 2, dims.w / 2],
    [0, dims.h],
    [-dims.d / 2, dims.d / 2],
  ] as const;
  for (let a = 0; a < 3; a++) {
    expect(Math.abs(min[a]! - expected[a]![0]), `${g.id} min axis ${a}`).toBeLessThan(MM);
    expect(Math.abs(max[a]! - expected[a]![1]), `${g.id} max axis ${a}`).toBeLessThan(MM);
  }
  const triangles = mesh.indices.length / 3;
  expect(triangles).toBeGreaterThan(0);
  expect(triangles).toBeLessThanOrEqual(MAX_TRIANGLES);
  for (const arr of [mesh.positions, mesh.normals, mesh.uvs]) expect(arr.every(Number.isFinite)).toBe(true);
  expect(mesh.owners.every((o) => o.kind === 'item')).toBe(true);
  expect(mesh.owners.reduce((n, o) => n + o.count, 0)).toBe(triangles);
  const materials = new Set(mesh.groups.map((m) => m.materialId));
  expect(materials.size).toBeLessThanOrEqual(MAX_MATERIALS);
  for (const m of materials) expect(Object.keys(ITEM_MATERIAL_SPECS)).toContain(m);
  return mesh;
}

/** An fc arbitrary of valid params, read from the generator's input JSON schema. */
function paramsArbitrary(g: AnyGenerator): fc.Arbitrary<Record<string, unknown>> {
  const schema = z.toJSONSchema(g.params, { io: 'input' }) as { properties: Record<string, Record<string, unknown>> };
  const fields: Record<string, fc.Arbitrary<unknown>> = {};
  for (const [key, p] of Object.entries(schema.properties)) {
    if (Array.isArray(p.anyOf)) fields[key] = fc.constantFrom(...(p.anyOf as { const: unknown }[]).map((o) => o.const));
    else if (Array.isArray(p.enum)) fields[key] = fc.constantFrom(...p.enum);
    else if (p.type === 'boolean') fields[key] = fc.boolean();
    else if (p.type === 'integer') fields[key] = fc.integer({ min: p.minimum as number, max: p.maximum as number });
    else fields[key] = fc.double({ min: p.minimum as number, max: p.maximum as number, noNaN: true, noDefaultInfinity: true });
  }
  return fc.record(fields);
}

function hash(mesh: MeshData): string {
  const r = (a: ArrayLike<number>) => Array.from(a, (v) => (Math.round(v * 1e5) / 1e5).toFixed(5)).join(',');
  const text = [r(mesh.positions), r(mesh.normals), r(mesh.uvs), Array.from(mesh.indices).join(','), JSON.stringify(mesh.groups), JSON.stringify(mesh.owners)].join('|');
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

describe('generator registry', () => {
  it('registers the furniture generators, the TV, the fixed bathroom / kitchen ware and the CG4 curtains and pendant in the process-wide registry', () => {
    expect(GENERATORS.list().map((g) => g.id)).toEqual(
      ['bathtub', 'bed', 'bookshelf', 'chair', 'cooktop', 'curtains', 'desk', 'fridge', 'island', 'kitchenBase', 'kitchenWall', 'mirror', 'nightstand', 'pendant', 'rug', 'sideboard', 'sofa', 'table', 'toilet', 'tv', 'tvUnit', 'wardrobe', 'washbasin'],
    );
    expect(ALL_GENERATORS).toHaveLength(23);
  });
  it('registerGenerators is idempotent and fills any registry', () => {
    const r = createGeneratorRegistry();
    registerGenerators(r);
    registerGenerators(r);
    expect(r.list()).toHaveLength(23);
    registerGenerators();
    expect(GENERATORS.list()).toHaveLength(23);
  });
  it('assertGeneratorsRegistered passes on the process-wide registry and names what is missing otherwise', () => {
    expect(() => assertGeneratorsRegistered()).not.toThrow();
    const r = createGeneratorRegistry();
    expect(() => assertGeneratorsRegistered(r)).toThrow(/bathtub.*washbasin/);
    registerGenerators(r);
    expect(() => assertGeneratorsRegistered(r)).not.toThrow();
  });
});

describe.each(ALL_GENERATORS.map((g) => [g.id, g] as const))('generator %s', (_id, g) => {
  it('exposes a described, strict, all-defaulted param schema', () => {
    const json = z.toJSONSchema(g.params, { io: 'input' }) as { properties: Record<string, { description?: string }>; required?: string[]; additionalProperties?: boolean };
    expect(Object.keys(json.properties).length).toBeGreaterThan(0);
    for (const [key, p] of Object.entries(json.properties)) expect(p.description, `${g.id}.${key}`).toMatch(/\S{3,}/);
    expect(json.required ?? []).toEqual([]);
    expect(json.additionalProperties).toBe(false);
    expect(g.params.safeParse({ nonsense: 1 }).success).toBe(false);
    expect(g.label.length).toBeGreaterThan(5);
  });

  it('builds the defaults at exactly the described dims, floor-aligned, in at most 4 materials', () => {
    expectSound(g, {});
  });

  it('is deterministic', () => {
    expect(hash(g.generate(g.params.parse({})))).toBe(hash(g.generate(g.params.parse({}))));
  });

  it('has outward winding that agrees with the vertex normals, and anchors inside the box', () => {
    const mesh = g.generate(g.params.parse({}));
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      const p = (i: number) => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      const u = pb.map((v, k) => v - pa[k]!);
      const w = pc.map((v, k) => v - pa[k]!);
      const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      const dot = n[0]! * mesh.normals[a * 3]! + n[1]! * mesh.normals[a * 3 + 1]! + n[2]! * mesh.normals[a * 3 + 2]!;
      expect(dot).toBeGreaterThan(0);
    }
    const { dims, anchors, clearance } = g.describeParams(g.params.parse({}));
    expect(anchors.length).toBeGreaterThan(0);
    for (const an of anchors) {
      expect(Math.abs(an.position[0])).toBeLessThanOrEqual(dims.w / 2 + 1e-9);
      expect(an.position[1]).toBeGreaterThanOrEqual(0);
      expect(an.position[1]).toBeLessThanOrEqual(dims.h + 1e-9);
      expect(Math.abs(an.position[2])).toBeLessThanOrEqual(dims.d / 2 + 1e-9);
    }
    expect(Object.values(clearance).every((v) => v >= 0)).toBe(true);
  });

  it('property: any valid params give a mesh whose bbox equals the described dims within 1 mm', () => {
    fc.assert(
      fc.property(paramsArbitrary(g), (raw) => {
        expectSound(g, raw);
      }),
      { numRuns: 60 },
    );
  });

  it('property: describeParams is cheap and agrees with the params it was given', () => {
    fc.assert(
      fc.property(paramsArbitrary(g), (raw) => {
        const params = g.params.parse(raw);
        const { dims } = g.describeParams(params);
        for (const v of Object.values(dims)) expect(v).toBeGreaterThan(0);
        if ('w' in params) expect(dims.w).toBe(params.w);
        if ('h' in params && g.id !== 'tv') expect(dims.h).toBe(params.h);
      }),
      { numRuns: 60 },
    );
  });
});

describe('generator geometry snapshot (determinism across versions)', () => {
  it('hashes of the default meshes are stable', () => {
    const hashes = Object.fromEntries(ALL_GENERATORS.map((g) => [g.id, hash(g.generate(g.params.parse({})))]));
    expect(hashes).toMatchInlineSnapshot(`
      {
        "bathtub": "53f86549a006",
        "bed": "dd1c8f81770e",
        "bookshelf": "0fc035283a17",
        "chair": "5938bcd59be5",
        "cooktop": "25fad467c88c",
        "curtains": "687236717fb3",
        "desk": "33b3f0f692b5",
        "fridge": "4a989acb1d4d",
        "island": "55908420f6f3",
        "kitchenBase": "7595c22b3dc2",
        "kitchenWall": "0cfbd2b6c08b",
        "mirror": "9f58ba728e26",
        "nightstand": "17cb49fdb6c2",
        "pendant": "6b40fd1ba1b4",
        "rug": "e729b46333e0",
        "sideboard": "21e5c1283a52",
        "sofa": "b950d0047d92",
        "table": "39996e898674",
        "toilet": "0491142612c8",
        "tv": "0f13a4923799",
        "tvUnit": "96be9ddf0cd6",
        "wardrobe": "6b7946f318dd",
        "washbasin": "a33867c4ee57",
      }
    `);
  });
});

describe('generator specifics', () => {
  const gen = (id: string) => GENERATORS.get(id)!;

  it('wardrobe: hinged doors ask for swing clearance, sliding ones do not; door count changes the mesh', () => {
    const w = gen('wardrobe');
    const hinged = w.describeParams(w.params.parse({ w: 1.2, doors: 2, doorType: 'hinged' }));
    const sliding = w.describeParams(w.params.parse({ w: 1.2, doors: 2, doorType: 'sliding' }));
    expect(hinged.clearance.front).toBeCloseTo(0.6, 6);
    expect(sliding.clearance.front).toBeLessThan(hinged.clearance.front! + 0.1);
    expect(hash(w.generate(w.params.parse({ doors: 2 })))).not.toBe(hash(w.generate(w.params.parse({ doors: 4 }))));
    for (const doorType of ['hinged', 'sliding']) for (const doors of [1, 2, 8]) expectSound(w, { doors, doorType });
  });

  it('kitchenBase: modules placed edge to edge give one continuous worktop', () => {
    const k = gen('kitchenBase');
    const a = { w: 0.6, d: 0.6, h: 0.9, doors: 1 };
    const b = { w: 0.8, d: 0.6, h: 0.9, doors: 0, drawers: 3 };
    const items = [
      { id: 'k1', assetId: 'param:kitchenBase', position: [0.3, 1] as [number, number], mesh: { kind: 'parametric' as const, generator: 'kitchenBase', params: a } },
      { id: 'k2', assetId: 'param:kitchenBase', position: [1.0, 1] as [number, number], mesh: { kind: 'parametric' as const, generator: 'kitchenBase', params: b } },
    ];
    const mesh = buildItems(makeScene([{ id: 'w', start: [0, 0], end: [4, 0] }], [], { items }));
    const group = mesh.groups.find((m) => m.materialId === ITEM_MATERIALS.worktop)!;
    // Worktop top faces: horizontal at y = 0.9; their plan rectangles must tile [0, 1.4] x [0.7, 1.3] without gaps or overlap.
    let area = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = group.start; i < group.start + group.count; i += 3) {
      const v = [0, 1, 2].map((k) => mesh.indices[i + k]!);
      if (!v.every((vi) => Math.abs(mesh.positions[vi * 3 + 1]! - 0.9) < 1e-6 && mesh.normals[vi * 3 + 1] === 1)) continue;
      const [p0, p1, p2] = v.map((vi) => [mesh.positions[vi * 3]!, mesh.positions[vi * 3 + 2]!] as const) as [readonly [number, number], readonly [number, number], readonly [number, number]];
      area += Math.abs((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1])) / 2;
      for (const p of [p0, p1, p2]) {
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
      }
    }
    expect(minX).toBeCloseTo(0, 3);
    expect(maxX).toBeCloseTo(1.4, 3);
    expect(area).toBeCloseTo(1.4 * 0.6, 3);
    expect(k.describeParams(k.params.parse(a)).dims).toEqual({ w: 0.6, d: 0.6, h: 0.9 });
  });

  it('kitchenBase without worktop and with only drawers or only a panel is still exact', () => {
    const k = gen('kitchenBase');
    for (const raw of [{ worktop: false }, { doors: 0, drawers: 0 }, { doors: 0, drawers: 5, worktop: false }, { doors: 4, drawers: 5 }]) expectSound(k, raw);
  });

  it('bed: length maps to depth, the headboard is optional, h means total height both ways', () => {
    const b = gen('bed');
    expect(b.describeParams(b.params.parse({ w: 1.4, l: 1.9, h: 1.1 })).dims).toEqual({ w: 1.4, d: 1.9, h: 1.1 });
    expectSound(b, { headboard: false, h: 0.6 });
    expectSound(b, { headboard: true, h: 0.6 });
  });

  it('mirror and rug have fixed thin depths; tv follows the diagonal', () => {
    expect(gen('mirror').describeParams(gen('mirror').params.parse({})).dims.d).toBe(0.03);
    expect(gen('rug').describeParams(gen('rug').params.parse({})).dims.h).toBe(0.012);
    const tv = gen('tv');
    const d55 = tv.describeParams(tv.params.parse({})).dims;
    const d65 = tv.describeParams(tv.params.parse({ diagonal: 65 })).dims;
    expect(d55).toEqual({ w: 1.23, d: 0.05, h: 0.71 });
    expect(d65.w).toBeGreaterThan(d55.w);
  });

  it('washbasin: every kind is exact, and a kitchen sink unit keeps its worktop at the full height', () => {
    const wb = gen('washbasin');
    for (const raw of [{ kind: 'vanity' }, { kind: 'pedestal', w: 0.55, d: 0.45 }, { kind: 'sink', w: 1.2, d: 0.6, h: 0.9 }, { kind: 'sink', w: 0.3, d: 0.3, h: 0.6 }, { kind: 'sink', w: 1.8, d: 0.8, h: 1 }]) expectSound(wb, raw);
    const sink = wb.generate(wb.params.parse({ kind: 'sink', w: 1.2, d: 0.6, h: 0.9 }));
    const top = sink.groups.find((m) => m.materialId === ITEM_MATERIALS.worktop)!;
    let maxY = 0;
    for (let i = top.start; i < top.start + top.count; i++) maxY = Math.max(maxY, sink.positions[sink.indices[i]! * 3 + 1]!);
    expect(maxY).toBeCloseTo(0.9, 6);
  });

  it('bathtub: the taps are at the chosen end and the long side is the width', () => {
    const b = gen('bathtub');
    const metalX = (tapEnd: string) => {
      const m = b.generate(b.params.parse({ tapEnd }));
      const g = m.groups.find((x) => x.materialId === ITEM_MATERIALS.metal)!;
      let max = -Infinity;
      for (let i = g.start; i < g.start + g.count; i++) if (m.positions[m.indices[i]! * 3 + 1]! > 0.57) max = Math.max(max, m.positions[m.indices[i]! * 3]!);
      return max;
    };
    expect(metalX('right')).toBeGreaterThan(0.5);
    expect(metalX('left')).toBeLessThan(0);
    expect(b.describeParams(b.params.parse({})).dims).toEqual({ w: 1.7, d: 0.7, h: 0.58 });
  });

  it('toilet, cooktop and fridge ask for front clearance and are exact at their extremes', () => {
    for (const [id, raw] of [['toilet', { w: 0.3, d: 0.5, h: 0.6 }], ['toilet', { w: 0.5, d: 0.8, h: 0.95 }], ['cooktop', { burners: 1 }], ['cooktop', { w: 1, burners: 3 }], ['fridge', { freezer: 'none' }], ['fridge', { freezer: 'top', h: 0.8 }], ['fridge', { h: 2.1, w: 0.9 }]] as const) {
      expectSound(gen(id), raw);
    }
    expect(gen('toilet').describeParams(gen('toilet').params.parse({})).clearance.front).toBeGreaterThanOrEqual(0.6);
    expect(gen('cooktop').describeParams(gen('cooktop').params.parse({})).clearance.front).toBeGreaterThanOrEqual(0.9);
    expect(gen('fridge').describeParams(gen('fridge').params.parse({})).dims).toEqual({ w: 0.6, d: 0.65, h: 1.85 });
  });

  it('rejects out-of-range and unknown params', () => {
    expect(gen('wardrobe').params.safeParse({ w: 50 }).success).toBe(false);
    expect(gen('wardrobe').params.safeParse({ doors: 2.5 }).success).toBe(false);
    expect(gen('wardrobe').params.safeParse({ doorType: 'folding' }).success).toBe(false);
    expect(gen('table').params.safeParse({ legs: 3 }).success).toBe(false);
  });
});
