import { IsoDateTime } from '@flat/scene';
import { ProductRecord } from '@flat/assets';
import { z } from 'zod';

/**
 * On-disk format of the LOCAL product catalogue (`pnpm catalog:build`), PERSONAL USE ONLY.
 *
 *   apps/server/local-assets/ikea-fr/
 *     catalog.json            this file (`LocalCatalogFile`)
 *     models/<sku>.glb        normalised GLBs (Meshopt, textures <= 1024 px, front +z, proportions checked)
 *     photos/<sku>.webp       small product photos (<= 320 px)
 *
 * The folder is gitignored, denied in `scripts/ci/retailer-hosts.json` and never part of the Pages build. Records are
 * validated at build time, so the server and the viewer can trust them: a record without a usable model says why
 * (`has3d: false` + `noModelReason`) and nothing 404s at runtime.
 */

export const LOCAL_CATALOG_MARKER = 'flat-local-catalog';
export const LOCAL_PROVIDER_ID = 'ikea-fr-local';
/** The provider the records belong to: product ids stay `ikea-fr:<sku>` so scenes and the seen registry keep working. */
export const LOCAL_RECORD_PROVIDER = 'ikea-fr';
export const LOCAL_SKU = /^\d{8}$/;

/** How the model's native axes map onto the item frame (x = width, y = height, z = depth; front +z). */
export const ModelFit = z.strictObject({
  /** The GLB as shipped had its long side along the other axis than the shop's width/depth: a quarter turn is baked into the file. */
  quarterTurn: z.boolean(),
  /** Aspect distortion when the model is scaled to the listed dims (0 = exact; the viewer warns above 0.10 and refuses above 0.50). */
  distortion: z.number().min(0),
  /** Bounding box of the normalised model, metres: width (x), height (y), depth (z). */
  size: z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()]),
});
export type ModelFit = z.infer<typeof ModelFit>;

export const ModelStats = z.strictObject({
  file: z.string().regex(/^models\/\d{8}\.glb$/),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  triangles: z.number().int().nonnegative(),
  fit: ModelFit,
  /** Estimated decoded size in the browser (textures with mipmaps + vertex/index buffers), as downloaded and after normalisation. */
  decodedBytesBefore: z.number().int().nonnegative(),
  decodedBytesAfter: z.number().int().nonnegative(),
  bytesBefore: z.number().int().nonnegative(),
});
export type ModelStats = z.infer<typeof ModelStats>;

export const AVAILABILITY = ['in_stock', 'out_of_stock', 'discontinued', 'unknown'] as const;
export const Availability = z.enum(AVAILABILITY);
export type Availability = z.infer<typeof Availability>;

export const LocalEntry = z.strictObject({
  /** The validated product record, as read from the product page (its `modelRef` is dropped: the catalogue has its own model). */
  record: ProductRecord,
  /** The shop's own product type ("Canapé 3 places"), used by the search. */
  typeName: z.string().max(120).default(''),
  /** The curated queries that found this product (extra search words). */
  queries: z.array(z.string().max(80)).max(12).default([]),
  /** A normalised model exists and passed the checks. */
  has3d: z.boolean(),
  /** Why there is no model (`has3d` false): shown in `catalog:status`, never an error at runtime. */
  noModelReason: z.string().max(300).optional(),
  model: ModelStats.optional(),
  /** Small photo, `photos/<sku>.webp`. */
  photo: z.strictObject({ file: z.string().regex(/^photos\/\d{8}\.webp$/), bytes: z.number().int().positive() }).optional(),
  availability: Availability.default('unknown'),
  /** Non-fatal observations from the build ("dims_mismatch 18%", "textures resized"). */
  flags: z.array(z.string().max(200)).max(12).default([]),
  /** Parts a transient failure left out (`model`, `photo`): the next build retries them. */
  incomplete: z.array(z.enum(['model', 'photo'])).max(2).default([]),
  /** Last time the page was read (price/availability verified). */
  checkedAt: IsoDateTime,
});
export type LocalEntry = z.infer<typeof LocalEntry>;

export const LocalCatalogFile = z.strictObject({
  marker: z.literal(LOCAL_CATALOG_MARKER),
  version: z.literal(1),
  provider: z.literal(LOCAL_RECORD_PROVIDER),
  /** Store/locale the prices belong to. */
  locale: z.string().max(16),
  builtAt: IsoDateTime,
  entries: z.array(LocalEntry),
  /** `query -> { at, skus }` of the searches already made: a fresh query is not repeated on resume. */
  queryLog: z.record(z.string(), z.strictObject({ at: IsoDateTime, skus: z.array(z.string().regex(LOCAL_SKU)).max(60) })).default({}),
  /** Hits dropped at build time and why (`sku -> reason`), so they are not retried every run. */
  rejected: z.record(z.string().regex(LOCAL_SKU), z.strictObject({ at: IsoDateTime, reason: z.string().max(300) })).default({}),
});
export type LocalCatalogFile = z.infer<typeof LocalCatalogFile>;

export const emptyCatalog = (now: string): LocalCatalogFile => ({
  marker: LOCAL_CATALOG_MARKER,
  version: 1,
  provider: LOCAL_RECORD_PROVIDER,
  locale: 'fr/fr',
  builtAt: now,
  entries: [],
  queryLog: {},
  rejected: {},
});
