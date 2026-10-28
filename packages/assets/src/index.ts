// @flat/assets: the shape and look of items, and where they come from (docs/architecture/modules.md section 1.2).
//
// Step A2: a FACADE. Everything is re-exported from @flat/scene as an explicit named list; this list is the future public
// API and drives the import codemod (scripts/refactor/rewrite-imports.mjs) and the ESLint `importNames` rule. Step A4
// moves the implementations here and turns each line into a local export. Add a name here, never `export *`.
//
// Importing this module (like importing @flat/scene today) registers the generators in `GENERATORS`.

// ---- catalog: mesh catalog, lookalike matching, resolution chain
export {
  EMPTY_MESH_CATALOG,
  FrontAxis,
  MAX_LOOKALIKE_DISTORTION,
  MeshAsset,
  MeshAssetSource,
  MeshAssetTier,
  createMeshCatalog,
  parametricMeshAssets,
  pickLookalike,
  resolveMesh,
  scaleToDims,
} from '@flat/scene';
export type { LookalikeMatch, MeshCatalog, MeshResolveContext, ResolvedMesh, ResolvedMeshSource } from '@flat/scene';

// ---- generators and meshes
export { ALL_GENERATORS, MIRROR_DEPTH, RUG_THICKNESS, buildBedDressing, buildItems, registerGenerators } from '@flat/scene';

// ---- materials: item materials and the texture catalog
export { ITEM_MATERIALS, ITEM_MATERIAL_SPECS } from '@flat/scene';
export type { ItemMaterialId, ItemMaterialSpec } from '@flat/scene';
export { Catalog, CatalogEntry, LicenseEvidence, MaterialCategory, libraryTextureUrl, materialFromCatalog } from '@flat/scene';
export type { MaterialFromCatalogOptions } from '@flat/scene';

// ---- products: wire types of the product API
export {
  CircuitState,
  GetProductResponse,
  IsSeenResponse,
  LOCAL_STALE_DAYS,
  LocalCatalogInfo,
  MAX_VARIANTS,
  MarkSeenBody,
  MarkSeenResponse,
  ProductRecord,
  ProductSearchParams,
  ProductSearchResponse,
  ProductSource,
  ProductSummary,
  ProductVariant,
  ProviderCapabilities,
  ProviderInfo,
  ProviderStatus,
  ProvidersResponse,
  ResolveUrlBody,
  WeightKind,
  matchProducts,
  productIdOf,
  productSnapshot,
  summarizeProduct,
} from '@flat/scene';
export type { ProductRecordInput, ProductSearchParamsInput } from '@flat/scene';
