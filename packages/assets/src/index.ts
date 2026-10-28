// @flat/assets: the shape and look of items, and where they come from (docs/architecture/modules.md section 1.2).
//
// Step A4: the implementations live here. This list of explicit named exports is the public API and drives the import
// codemod (scripts/refactor/rewrite-imports.mjs) and the ESLint `importNames` rule. Add a name here, never `export *`.
//
// Importing this module registers the generators in @flat/scene's `GENERATORS` (side effect of `./register`). Scene no
// longer does it, so every app entry imports `@flat/assets` and calls `assertGeneratorsRegistered()`.
import './register';

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
  scaleToDims,
} from './catalog/mesh-catalog';
export type { LookalikeMatch, MeshCatalog } from './catalog/mesh-catalog';
export { resolveMesh } from './catalog/resolve';
export type { MeshResolveContext, ResolvedMesh, ResolvedMeshSource } from './catalog/resolve';

// ---- generators and meshes
export { ALL_GENERATORS, GENERATOR_OWNER_ID, MIRROR_DEPTH, RUG_THICKNESS } from './generators';
export { assertGeneratorsRegistered, registerGenerators } from './register';
export { buildBedDressing } from './meshes/bed-dressing';
export { buildItems } from './meshes/build-items';

// ---- materials: item materials and the texture catalog
export { ITEM_MATERIALS, ITEM_MATERIAL_SPECS, ITEM_SLOTS } from './materials/item-materials';
export type { ItemMaterialId, ItemMaterialSpec } from './materials/item-materials';
export { Catalog, CatalogEntry, LicenseEvidence, MaterialCategory, libraryTextureUrl, materialFromCatalog } from './materials/texture-catalog';
export type { MaterialFromCatalogOptions } from './materials/texture-catalog';

// ---- products: wire types of the product API
export {
  CircuitState,
  GetProductResponse,
  IsSeenResponse,
  LocalCatalogInfo,
  MarkSeenBody,
  MarkSeenResponse,
  ProductSearchParams,
  ProductSearchResponse,
  ProviderCapabilities,
  ProviderInfo,
  ProviderStatus,
  ProvidersResponse,
  ResolveUrlBody,
  matchProducts,
} from './products/api';
export type { ProductSearchParamsInput } from './products/api';
export {
  LOCAL_STALE_DAYS,
  MAX_VARIANTS,
  ProductRecord,
  ProductSource,
  ProductSummary,
  ProductVariant,
  WeightKind,
  productIdOf,
  productSnapshot,
  summarizeProduct,
} from './products/records';
export type { ProductRecordInput } from './products/records';
