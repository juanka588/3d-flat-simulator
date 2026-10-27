import { z } from 'zod';

/**
 * Leaf building blocks shared by `schema.ts`, `products.ts`, `placement/types.ts` and
 * `assets/catalog.ts`. They live here (and import nothing from the scene modules) so those modules
 * can depend on each other without import cycles. `schema.ts` re-exports the ones that were always
 * part of its public surface (`Vec2`, `EntityId`, `NAME_MAX`, `stripControlChars`).
 */

export const Vec2 = z.tuple([z.number(), z.number()]);
export type Vec2 = z.infer<typeof Vec2>;

/** Entity id: 1-64 characters. The same bound applies wherever an id is defined or referenced. */
export const EntityId = z.string().min(1).max(64);

/** Maximum length of human-readable names. */
export const NAME_MAX = 120;

/**
 * Control characters (newlines, tabs, C0/C1 controls, line and paragraph separators) never survive in
 * a name or address: names reach an LLM as text, so a name must not be able to start a new line of
 * "instructions". Each run becomes one space.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
export function stripControlChars(s: string): string {
  const out = s.replace(CONTROL_CHARS, ' ');
  return out === s ? s : out.trim();
}

/** A human-readable name: at most `max` characters (counted before stripping), control characters removed. */
export const NameString = (description?: string, max: number = NAME_MAX) => {
  const base = z.string().max(max);
  return (description ? base.describe(description) : base).transform(stripControlChars);
};

/** Largest single dimension accepted for an item or a product, in metres (a 20 m "sofa" is a unit mistake). */
export const DIM_MAX_M = 20;

/**
 * Width (item-local x), depth (local z) and height (local y) in metres; see the item frame in
 * `assets/builtin.ts`. Always strictly positive.
 */
export const Dims = z.strictObject({
  w: z.number().positive().max(DIM_MAX_M).describe('Width in metres (item-local x).'),
  d: z.number().positive().max(DIM_MAX_M).describe('Depth in metres (item-local z; the front is at +d/2).'),
  h: z.number().positive().max(DIM_MAX_M).describe('Height in metres (item-local y, measured up from the item bottom).'),
});
export type Dims = z.infer<typeof Dims>;

/** Where an item is fixed: on the floor, hung on a wall, or hung from the ceiling. */
export const ItemMount = z.enum(['floor', 'wall', 'ceiling']);
export type ItemMount = z.infer<typeof ItemMount>;

/**
 * Free space (metres) the item wants around it, in the item frame: `front` is the side that opens
 * (drawers, doors, seat), `back` the wall side, `left`/`right` as seen from the front.
 */
export const Clearance = z.strictObject({
  front: z.number().min(0).max(5).optional(),
  back: z.number().min(0).max(5).optional(),
  left: z.number().min(0).max(5).optional(),
  right: z.number().min(0).max(5).optional(),
});
export type Clearance = z.infer<typeof Clearance>;

/** Provider id: lowercase slug, e.g. `ikea-fr`, `pasted-url`, `mock`. */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const ProviderId = z.string().regex(PROVIDER_ID_RE, 'expected a provider id like "ikea-fr" (lowercase letters, digits, hyphens; at most 32 characters)');

/** Maximum length of a SKU. */
export const SKU_MAX = 64;
/** A provider-scoped product code. Control characters are stripped; must not end up empty. */
export const Sku = z
  .string()
  .min(1)
  .max(SKU_MAX)
  .transform(stripControlChars)
  .refine((s) => s.length > 0, 'sku is empty');

/** Maximum length of a product name. */
export const PRODUCT_NAME_MAX = 200;
export const ProductName = NameString('Product name, at most 200 characters.', PRODUCT_NAME_MAX).refine((s) => s.length > 0, 'name is empty');

/** ISO 8601 timestamp, e.g. `2026-10-27T10:00:00.000Z`. */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** An `http(s)` URL of at most 2048 characters. */
export const HttpUrl = z
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), 'expected an http(s) URL');
