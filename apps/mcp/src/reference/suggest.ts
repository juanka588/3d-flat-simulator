import { GENERATORS, defaultParametricFor, type AnyGenerator } from '@flat/scene';
import { z } from 'zod';
import type { DescriptorItem } from './descriptor';
import { nearestColourName, tokenSet } from './vocab';

/**
 * `suggest_generator` (CG4): which parametric generator, with which params, would stand for a descriptor item when no real
 * product fits. The result is a CONCEPT: never purchasable, placed only with `place_item {concept:true}`, listed apart in the bill.
 */

export interface GeneratorSuggestion {
  generator: string;
  params: Record<string, number | string | boolean>;
  /** The exact dims the generator makes with these params. */
  dims: { w: number; d: number; h: number };
  concept: true;
  /** What was read from the descriptor into the params, and what could not be expressed. */
  notes: string[];
}

type Params = Record<string, number | string | boolean>;

/** Clamps the numeric fields of `params` to the generator's declared ranges (the descriptor's size is a guess). */
function clampToSchema(g: AnyGenerator, params: Params): Params {
  const json = z.toJSONSchema(g.params, { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, { minimum?: number; maximum?: number; type?: string }> };
  const out: Params = { ...params };
  for (const [k, v] of Object.entries(out)) {
    const p = json.properties?.[k];
    if (typeof v === 'number' && p && (p.type === 'number' || p.type === 'integer')) {
      let x = v;
      if (p.minimum !== undefined) x = Math.max(p.minimum, x);
      if (p.maximum !== undefined) x = Math.min(p.maximum, x);
      out[k] = p.type === 'integer' ? Math.round(x) : Math.round(x * 1000) / 1000;
    }
  }
  return out;
}

const FINISHES: [string, string][] = [['walnut', 'walnut'], ['oak', 'oak'], ['wood', 'wood'], ['anthracite', 'anthracite'], ['black', 'dark'], ['charcoal', 'anthracite'], ['white', 'white']];

const has = (t: ReadonlySet<string>, ...words: string[]) => words.some((w) => t.has(w));

/** Params from the descriptor for one generator id, or `undefined` when the generator does not fit the item. */
function paramsFor(it: DescriptorItem, t: ReadonlySet<string>, notes: string[]): { generator: string; params: Params } | undefined {
  const { w, d, h } = it.approxDims;
  const colour = nearestColourName(it.colour);
  const long = Math.max(w, d);
  const short = Math.min(w, d);
  const text = `${it.subtype} ${it.shape}`.toLowerCase();

  if (has(t, 'bathtub')) {
    const shape = has(t, 'freestanding', 'island') ? 'freestanding' : has(t, 'oval', 'round') ? 'oval' : 'rect';
    return { generator: 'bathtub', params: { w: long, d: short, h, shape, feet: has(t, 'foot', 'claw', 'leg'), ...(colour ? { colour } : {}) } };
  }
  if (has(t, 'washbasin', 'basin', 'vanity') && !has(t, 'kitchen')) {
    const basin = has(t, 'vessel', 'bowl', 'basin') && !has(t, 'integrated') ? 'vessel' : 'integrated';
    return { generator: 'washbasin', params: { kind: has(t, 'pedestal', 'column') ? 'pedestal' : 'vanity', w, d, h, basin, shape: has(t, 'rect', 'square') ? 'rect' : 'round', ...(colour ? { colour } : {}) } };
  }
  if (has(t, 'toilet')) return { generator: 'toilet', params: { w: short, d: long, h } };

  switch (it.category) {
    case 'sofa':
    case 'armchair': {
      const m = text.match(/(\d)\s*[- ]?(seat|seater|place)/);
      const seats = it.category === 'armchair' || has(t, 'armchair') ? 1 : m ? Number(m[1]) : Math.round((long - 0.3) / 0.65);
      const fabric = has(t, 'velvet') ? 'velvet' : has(t, 'leather') ? 'leather' : undefined;
      return {
        generator: 'sofa',
        params: {
          w: long,
          d: short,
          h,
          seats,
          arms: has(t, 'armless') || /no arms|sans accoudoir/.test(text) ? 'none' : has(t, 'round', 'rolled', 'padded') ? 'rolled' : 'track',
          legs: has(t, 'wood') && has(t, 'foot', 'leg') ? 'wood' : has(t, 'plinth', 'block', 'skirt') ? 'block' : /no legs/.test(text) ? 'none' : 'metal',
          ...(fabric ? { fabric } : {}),
          ...(colour ? { colour } : {}),
        },
      };
    }
    case 'bed': {
      const headboardStyle = has(t, 'upholstered', 'padded', 'tufted', 'fabric') ? 'upholstered' : has(t, 'slat', 'rattan', 'spindle') ? 'slatted' : 'panel';
      return { generator: 'bed', params: { w: short, l: long, h, headboard: !/no headboard|without headboard|sans tete/.test(text), headboardStyle, ...(headboardStyle === 'upholstered' && colour ? { upholstery: colour } : {}) } };
    }
    case 'rug': {
      const shape = has(t, 'round', 'oval') ? 'round' : has(t, 'runner') ? 'runner' : 'rect';
      const pattern = has(t, 'stripe') ? 'stripes' : has(t, 'check', 'gingham', 'plaid') ? 'checker' : has(t, 'plain', 'solid') ? 'plain' : 'border';
      return { generator: 'rug', params: { w, d, shape, pattern, ...(colour ? { colour } : {}) } };
    }
    case 'curtain':
      return { generator: 'curtains', params: { w, h, panels: w > 1.2 ? 2 : 1, pleats: has(t, 'pleat', 'gather', 'wave') ? 10 : 8, sheer: has(t, 'sheer', 'gauze', 'translucent', 'light'), ...(colour ? { colour } : {}) } };
    case 'lamp': {
      if (!has(t, 'pendant', 'hanging', 'drop')) return undefined;
      const shape = has(t, 'cluster', 'multiple', 'several', 'bunch') ? 'cluster' : has(t, 'dome', 'bell', 'cone', 'cloche', 'shade', 'rattan') ? 'dome' : 'globe';
      return { generator: 'pendant', params: { shape, w: long, h, ...(colour ? { colour } : {}) } };
    }
    case 'mirror':
      return { generator: 'mirror', params: { w, h } };
    case 'plant':
    case 'vase':
    case 'frame':
    case 'cushion':
    case 'throw':
    case 'decor':
    case 'appliance':
      return undefined;
    default: {
      const base = defaultParametricFor(it.category, { w, d, h }, it.subtype);
      if (!base) return undefined;
      const finish = FINISHES.find(([word]) => has(t, word))?.[1];
      notes.push('generic category shape (no descriptor-specific style)');
      return { generator: base.generator, params: { ...base.params, ...(finish && GENERATORS.get(base.generator)?.params.safeParse({ finish }).success ? { finish } : {}) } };
    }
  }
}

/** The generator suggestion for an item, validated against the registry; `{why}` when none fits. */
export function suggestGenerator(it: DescriptorItem): { suggestion: GeneratorSuggestion } | { why: string } {
  const t = tokenSet(`${it.subtype} ${it.shape} ${it.material}`);
  const notes: string[] = [];
  const base = paramsFor(it, t, notes);
  if (!base) return { why: `no parametric generator for "${it.subtype}" (${it.category}); only a real product (or leaving it out) can stand for it` };
  const g = GENERATORS.get(base.generator);
  if (!g) return { why: `generator "${base.generator}" is not registered` };
  const params = clampToSchema(g, base.params);
  const parsed = g.params.safeParse(params);
  if (!parsed.success) return { why: `the descriptor does not fit generator "${g.id}": ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  const dims = g.describeParams(parsed.data).dims;
  const want = it.approxDims;
  const off = (a: number, b: number) => Math.abs(a - b) > 0.1 * b;
  if (off(dims.w, want.w) && off(dims.w, want.d)) notes.push(`width limited to ${Math.round(dims.w * 100)} cm by the generator range (target ${Math.round(want.w * 100)} cm)`);
  if (off(dims.h, want.h)) notes.push(`height limited to ${Math.round(dims.h * 100)} cm by the generator range (target ${Math.round(want.h * 100)} cm)`);
  const named = Object.entries(params).filter(([k]) => !['w', 'd', 'h', 'l'].includes(k)).map(([k, v]) => `${k}=${String(v)}`);
  if (named.length) notes.push(`read from the descriptor: ${named.join(', ')}`);
  if (nearestColourName(it.colour) === undefined) notes.push(`colour "${it.colour}" is not in the palette; the generator keeps its standard finish`);
  return { suggestion: { generator: g.id, params, dims: { w: dims.w, d: dims.d, h: dims.h }, concept: true, notes } };
}
