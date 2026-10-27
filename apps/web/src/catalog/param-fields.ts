import type { AnyGenerator } from '@flat/scene';

/** One input of a generator's mini parameter form. */
export type ParamField =
  | { key: string; kind: 'number'; label: string; min?: number; max?: number; int: boolean; step: number; def: number; hint?: string }
  | { key: string; kind: 'boolean'; label: string; def: boolean; hint?: string }
  | { key: string; kind: 'choice'; label: string; options: string[]; def: string; hint?: string };

type ZodLike = { _zod?: { def?: { type?: string; innerType?: ZodLike } }; description?: string; minValue?: number | null; maxValue?: number | null; isInt?: boolean; options?: unknown[]; shape?: Record<string, ZodLike> };

/** Strips default / optional wrappers. */
function inner(z: ZodLike): ZodLike {
  let cur = z;
  for (let i = 0; i < 4; i++) {
    const t = cur._zod?.def?.type;
    if ((t === 'default' || t === 'optional' || t === 'prefault') && cur._zod?.def?.innerType) cur = cur._zod.def.innerType;
    else break;
  }
  return cur;
}

const humanize = (key: string): string => key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

/** Describes the scalar fields of a generator's params schema (numbers, switches, choices); other fields are left out. */
export function paramFields(g: Pick<AnyGenerator, 'params'>): ParamField[] {
  const shape = (g.params as unknown as ZodLike).shape;
  if (!shape) return [];
  const defaults = g.params.parse({}) as Record<string, unknown>;
  const out: ParamField[] = [];
  for (const [key, field] of Object.entries(shape)) {
    const z = inner(field);
    const type = z._zod?.def?.type;
    const description = field.description ?? z.description;
    const hint = description ? description.replace(/\s*(In metres|Whole number)[^.]*\.[^.]*$/i, '').trim() || undefined : undefined;
    const def = defaults[key];
    if (type === 'number' && typeof def === 'number') {
      const int = z.isInt === true;
      out.push({ key, kind: 'number', label: humanize(key), ...(typeof z.minValue === 'number' ? { min: z.minValue } : {}), ...(typeof z.maxValue === 'number' ? { max: z.maxValue } : {}), int, step: int ? 1 : 0.01, def, ...(hint ? { hint } : {}) });
    } else if (type === 'boolean' && typeof def === 'boolean') {
      out.push({ key, kind: 'boolean', label: humanize(key), def, ...(hint ? { hint } : {}) });
    } else if (type === 'enum' && Array.isArray(z.options) && typeof def === 'string') {
      out.push({ key, kind: 'choice', label: humanize(key), options: z.options.map(String), def, ...(hint ? { hint } : {}) });
    }
  }
  return out;
}

export type ParamValues = Record<string, number | string | boolean>;

/** The defaults of a generator, as form values. */
export function defaultParams(g: Pick<AnyGenerator, 'params'>): ParamValues {
  const out: ParamValues = {};
  for (const [k, v] of Object.entries(g.params.parse({}) as Record<string, unknown>)) if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
  return out;
}

export type ParamResult = { ok: true; params: ParamValues; dims: { w: number; d: number; h: number } } | { ok: false; error: string };

/** Validates form values against the generator and reads the exact dims it promises for them. */
export function resolveParams(g: Pick<AnyGenerator, 'params' | 'describeParams'>, values: ParamValues): ParamResult {
  const parsed = g.params.safeParse(values);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0] ? `${parsed.error.issues[0].path.join('.') || 'params'}: ${parsed.error.issues[0].message}` : 'invalid parameters' };
  const params: ParamValues = {};
  for (const [k, v] of Object.entries(parsed.data as Record<string, unknown>)) if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') params[k] = v;
  return { ok: true, params, dims: g.describeParams(parsed.data).dims };
}
