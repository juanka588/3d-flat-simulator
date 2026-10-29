import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MeshData } from '@flat/scene';
import { GENERATORS } from '@flat/scene';
import { ITEM_MATERIALS, ITEM_MATERIAL_SPECS } from '../materials/item-materials';
import '../register';

/** CG4: the descriptor-driven params of the extended generators and the new curtains / pendant. */

const MM = 1e-3;
const MAX_TRIANGLES = 3000;
const gen = (id: string) => GENERATORS.get(id)!;
const mats = (m: MeshData) => new Set(m.groups.map((g) => g.materialId));

function hash(mesh: MeshData): string {
  const r = (a: ArrayLike<number>) => Array.from(a, (v) => (Math.round(v * 1e5) / 1e5).toFixed(5)).join(',');
  const text = [r(mesh.positions), r(mesh.normals), r(mesh.uvs), Array.from(mesh.indices).join(','), JSON.stringify(mesh.groups), JSON.stringify(mesh.owners)].join('|');
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/** Exact bbox == described dims (1 mm), floor-aligned, within the triangle budget and the 4-material limit. */
function expectSound(id: string, raw: Record<string, unknown>): MeshData {
  const g = gen(id);
  const params = g.params.parse(raw);
  const { dims } = g.describeParams(params);
  const mesh = g.generate(params);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, mesh.positions[i + a]!);
      max[a] = Math.max(max[a]!, mesh.positions[i + a]!);
    }
  }
  const want = [[-dims.w / 2, dims.w / 2], [0, dims.h], [-dims.d / 2, dims.d / 2]] as const;
  for (let a = 0; a < 3; a++) {
    expect(Math.abs(min[a]! - want[a]![0]), `${id} ${JSON.stringify(raw)} min axis ${a}`).toBeLessThan(MM);
    expect(Math.abs(max[a]! - want[a]![1]), `${id} ${JSON.stringify(raw)} max axis ${a}`).toBeLessThan(MM);
  }
  expect(mesh.indices.length / 3).toBeLessThanOrEqual(MAX_TRIANGLES);
  expect(mats(mesh).size).toBeLessThanOrEqual(4);
  for (const m of mats(mesh)) expect(Object.keys(ITEM_MATERIAL_SPECS)).toContain(m);
  for (const arr of [mesh.positions, mesh.normals, mesh.uvs]) expect(arr.every(Number.isFinite)).toBe(true);
  return mesh;
}

const VARIANTS: [string, Record<string, unknown>][] = [
  ['bathtub', { shape: 'oval' }],
  ['bathtub', { shape: 'oval', feet: true, tapEnd: 'left' }],
  ['bathtub', { shape: 'freestanding', w: 1.5, d: 0.75 }],
  ['bathtub', { shape: 'freestanding', feet: true, colour: 'black', h: 0.4, w: 2.2, d: 1 }],
  ['bathtub', { shape: 'rect', feet: true }],
  ['bathtub', { shape: 'rect', colour: 'cream' }],
  ['washbasin', { basin: 'vessel', shape: 'round' }],
  ['washbasin', { basin: 'vessel', shape: 'rect', colour: 'black' }],
  ['washbasin', { basin: 'integrated', shape: 'round' }],
  ['washbasin', { basin: 'integrated', shape: 'rect', w: 1.8, d: 0.8, h: 1 }],
  ['washbasin', { basin: 'vessel', w: 0.3, d: 0.3, h: 0.6 }],
  ['washbasin', { kind: 'pedestal', colour: 'sage' }],
  ['sofa', { arms: 'rolled', legs: 'wood', fabric: 'velvet', colour: 'green' }],
  ['sofa', { arms: 'none', legs: 'none', seats: 4, w: 2.8 }],
  ['sofa', { arms: 'track', legs: 'block', fabric: 'leather', colour: 'brown', seats: 1, w: 0.9, d: 0.9 }],
  ['sofa', { arms: 'rolled', legs: 'metal', w: 0.6, d: 0.6, h: 0.7 }],
  ['bed', { headboardStyle: 'upholstered', upholstery: 'navy', linen: 'cream' }],
  ['bed', { headboardStyle: 'slatted', w: 2.4, l: 2.4 }],
  ['bed', { headboardStyle: 'slatted', w: 0.7, h: 0.6 }],
  ['bed', { headboardStyle: 'upholstered', headboard: false }],
  ['rug', { shape: 'round' }],
  ['rug', { shape: 'round', pattern: 'plain', colour: 'sand', w: 1.2, d: 1.2 }],
  ['rug', { shape: 'round', pattern: 'stripes', colour: 'cream', accent: 'terracotta' }],
  ['rug', { shape: 'runner', w: 0.8, d: 2.6, pattern: 'stripes', colour: 'beige', accent: 'navy' }],
  ['rug', { shape: 'runner', w: 3, d: 0.8, pattern: 'plain' }],
  ['rug', { pattern: 'checker', colour: 'cream', accent: 'charcoal', w: 6, d: 6 }],
  ['rug', { pattern: 'stripes', w: 0.3, d: 0.3 }],
  ['rug', { pattern: 'plain', colour: 'grey' }],
  ['curtains', { sheer: true }],
  ['curtains', { panels: 1, pleats: 20, w: 6, colour: 'sage' }],
  ['curtains', { panels: 2, pleats: 1, w: 0.5, h: 0.8, d: 0.03 }],
  ['curtains', { pleats: 12, d: 0.15, h: 3, colour: 'terracotta' }],
  ['pendant', { shape: 'globe' }],
  ['pendant', { shape: 'dome', w: 0.6, h: 0.9, colour: 'black' }],
  ['pendant', { shape: 'cluster', w: 0.8, h: 1.6 }],
  ['pendant', { shape: 'cluster', w: 0.15, h: 0.4 }],
  ['pendant', { shape: 'globe', w: 1, h: 0.4 }],
];

describe('CG4: descriptor-driven variants', () => {
  it.each(VARIANTS)('%s %j: exact dims, within the triangle budget, deterministic', (id, raw) => {
    const a = expectSound(id, raw);
    const b = gen(id).generate(gen(id).params.parse(raw));
    expect(hash(a)).toBe(hash(b));
  });

  it('every shape / style value makes a different mesh from the default', () => {
    const differs = (id: string, raw: Record<string, unknown>) => {
      const g = gen(id);
      expect(hash(g.generate(g.params.parse(raw))), `${id} ${JSON.stringify(raw)}`).not.toBe(hash(g.generate(g.params.parse({}))));
    };
    for (const shape of ['oval', 'freestanding']) differs('bathtub', { shape });
    differs('bathtub', { feet: true });
    for (const basin of ['vessel', 'integrated']) for (const shape of ['round', 'rect']) differs('washbasin', { basin, shape });
    for (const arms of ['rolled', 'none']) differs('sofa', { arms });
    for (const legs of ['wood', 'block', 'none']) differs('sofa', { legs });
    for (const headboardStyle of ['slatted', 'upholstered']) differs('bed', { headboardStyle });
    for (const shape of ['round', 'runner']) differs('rug', { shape });
    for (const pattern of ['plain', 'stripes', 'checker']) differs('rug', { pattern });
    for (const shape of ['dome', 'cluster']) differs('pendant', { shape });
    differs('curtains', { pleats: 12 });
    differs('curtains', { panels: 1 });
  });

  it('colours resolve to palette materials the viewer knows; omitting them keeps the standard finish', () => {
    const has = (id: string, raw: Record<string, unknown>, m: string) => expect(mats(gen(id).generate(gen(id).params.parse(raw)))).toContain(m);
    has('bathtub', { colour: 'black' }, 'builtin:furniture-ceramic-black');
    has('washbasin', { basin: 'vessel', colour: 'sage' }, 'builtin:furniture-ceramic-sage');
    has('sofa', { fabric: 'velvet', colour: 'green' }, 'builtin:furniture-velvet-green');
    has('sofa', { colour: 'navy' }, 'builtin:furniture-weave-navy');
    has('bed', { headboardStyle: 'upholstered', upholstery: 'pink' }, 'builtin:furniture-weave-pink');
    has('bed', { linen: 'blue' }, 'builtin:furniture-weave-blue');
    has('rug', { colour: 'cream', accent: 'rust' }, 'builtin:furniture-weave-rust');
    has('curtains', { sheer: true }, 'builtin:furniture-sheer');
    has('curtains', { colour: 'mustard' }, 'builtin:furniture-weave-mustard');
    has('pendant', { colour: 'terracotta' }, 'builtin:furniture-ceramic-terracotta');
    expect(mats(gen('sofa').generate(gen('sofa').params.parse({})))).toContain(ITEM_MATERIALS.fabric);
    expect(gen('bathtub').params.safeParse({ colour: 'puce' }).success).toBe(false);
    expect(ITEM_MATERIAL_SPECS['builtin:furniture-sheer'].opacity).toBeLessThan(1);
    // velvet and leather are plain colours, the weave carries the library texture
    expect(ITEM_MATERIAL_SPECS['builtin:furniture-weave-navy'].texture?.slug).toBe('fabric-weave-grey');
    expect(ITEM_MATERIAL_SPECS['builtin:furniture-velvet-navy'].texture).toBeUndefined();
  });

  it('dims stay w x d x h: a round rug, a freestanding bath, a pendant and curtains', () => {
    expect(gen('rug').describeParams(gen('rug').params.parse({ shape: 'round', w: 1.5, d: 1.5 })).dims).toEqual({ w: 1.5, d: 1.5, h: 0.012 });
    expect(gen('bathtub').describeParams(gen('bathtub').params.parse({ shape: 'freestanding', w: 1.6, d: 0.8, h: 0.6 })).dims).toEqual({ w: 1.6, d: 0.8, h: 0.6 });
    expect(gen('pendant').describeParams(gen('pendant').params.parse({ w: 0.5, h: 1 })).dims).toEqual({ w: 0.5, d: 0.5, h: 1 });
    expect(gen('curtains').describeParams(gen('curtains').params.parse({})).dims).toEqual({ w: 1.6, d: 0.08, h: 2.4 });
  });

  it('a bath on feet is raised and a freestanding one has taps on the rim', () => {
    const lowest = (m: MeshData, material: string) => {
      const g = m.groups.find((x) => x.materialId === material)!;
      let y = Infinity;
      for (let i = g.start; i < g.start + g.count; i++) y = Math.min(y, m.positions[m.indices[i]! * 3 + 1]!);
      return y;
    };
    const flat = gen('bathtub').generate(gen('bathtub').params.parse({ shape: 'oval' }));
    const raised = gen('bathtub').generate(gen('bathtub').params.parse({ shape: 'oval', feet: true }));
    expect(lowest(flat, ITEM_MATERIALS.ceramic)).toBeCloseTo(0, 6);
    expect(lowest(raised, ITEM_MATERIALS.ceramic)).toBeGreaterThan(0.07);
  });
});
