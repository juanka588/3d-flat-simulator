import { z } from 'zod';
import { Material } from '@flat/scene';

export const MaterialCategory = z.enum(['floor-wood', 'floor-tile', 'wall-plaster', 'wall-paper', 'stone', 'metal', 'outdoor']);
export type MaterialCategory = z.infer<typeof MaterialCategory>;

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'expected a lowercase slug like "parquet-light-oak"');
const Hex = z.string().regex(/^#[0-9a-f]{6}$/, 'expected a lowercase hex colour like #a1b2c3');
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const MapName = z.enum(['color', 'normal', 'roughness', 'thumb']);

/** What was checked to assert the licence of one entry (see scripts/materials/lib.mjs). */
export const LicenseEvidence = z.strictObject({
  /** `site-policy`: the API knows the asset and the site's licence page links the CC0 deed. `asset-field`: the API reported a CC0 licence for the asset itself. */
  basis: z.enum(['site-policy', 'asset-field']),
  policyUrl: z.url(),
  /** The text that had to appear on the policy page. */
  needle: z.string().min(1),
  /** The API record of the asset that was fetched. */
  assetApiUrl: z.url(),
  /** The licence value the API reported for the asset (`asset-field` only). */
  assetField: z.string().min(1).optional(),
  /** The build that last changed this entry's output (stable across no-op rebuilds). */
  checkedAt: z.iso.datetime(),
});
export type LicenseEvidence = z.infer<typeof LicenseEvidence>;

/** One processed library material, as written to `apps/web/public/materials/catalog.json` by `pnpm materials:build`. */
export const CatalogEntry = z.strictObject({
  id: Slug,
  name: z.string().min(1),
  category: MaterialCategory,
  /** Real-world edge length of one texture repeat, in metres. */
  tileSizeM: z.number().positive(),
  /** Whether `tileSizeM` comes from the source API's physical size or is an estimate. */
  tileSizeBasis: z.enum(['api', 'estimate']),
  /** Pixel edge length of the shipped maps (thumb excluded). */
  resolution: z.number().int().positive(),
  /** Mean colour as sRGB hex, averaged in linear light. */
  meanColor: Hex,
  /** The same mean in linear RGB (0..1). */
  meanLinear: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]),
  roughness: z.number().min(0).max(1),
  /** Total bytes of all files. */
  bytes: z.number().int().positive(),
  /** File names relative to `materials/<id>/`. */
  files: z.record(MapName, z.string().min(1)),
  fileBytes: z.record(MapName, z.number().int().positive()),
  source: z.enum(['ambientcg', 'polyhaven']),
  sourceId: z.string().min(1),
  sourceUrl: z.url(),
  license: z.literal('CC0-1.0'),
  licenseEvidence: LicenseEvidence.optional(),
  /** sha256 of each downloaded original (also pinned in scripts/materials/manifest.json). */
  sourceSha256: z.record(z.string(), Sha256).optional(),
  retrievedAt: z.iso.datetime(),
  sha256: z.record(MapName, Sha256),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

export const Catalog = z.array(CatalogEntry).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  entries.forEach((e, i) => {
    if (seen.has(e.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate material id "${e.id}"` });
    seen.add(e.id);
  });
});
export type Catalog = z.infer<typeof Catalog>;

export interface MaterialFromCatalogOptions {
  /** Override the scene material id (default `lib-<slug>`). */
  id?: string;
  /** Override the roughness (default: the catalog's). */
  roughness?: number;
}

/** Texture-set reference for a library material, resolved by the viewer to `${BASE_URL}materials/<slug>/`. */
export const libraryTextureUrl = (slug: string): string => `lib:${slug}`;

/** The scene `Material` that applies a library entry. Pure and deterministic, so defining it twice is idempotent. */
export function materialFromCatalog(entry: CatalogEntry, opts: MaterialFromCatalogOptions = {}): Material {
  return Material.parse({
    id: opts.id ?? `lib-${entry.id}`,
    name: entry.name,
    kind: 'texture',
    color: entry.meanColor,
    roughness: opts.roughness ?? entry.roughness,
    textureUrl: libraryTextureUrl(entry.id),
    textureScale: entry.tileSizeM,
  });
}
