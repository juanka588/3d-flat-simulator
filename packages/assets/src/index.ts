// @flat/assets: the shape and look of items, and where they come from (docs/architecture/modules.md section 1.2).
//
// Step A4: the implementations live here. This list of explicit named exports is the public API (index.test.ts pins it). Add a name here, never `export *`.
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

// ---- library: catalog JSON parsing and loading, asset URLs and routes, the pure fit maths of a loaded model
export {
  catalogFromAssets,
  catalogWithout,
  createCatalogLoader,
  fetchCatalogAssets,
  hdModelsBase,
  parseCatalogJson,
} from './library/catalog-loader';
export type { CatalogLoaderOptions, CatalogLoaderUrls } from './library/catalog-loader';
export { ASSET_PATH_PREFIX, ASSET_ROUTES, libraryModelUrl, providerModelUrl, serverMeshUrl } from './library/urls';
export {
  DIMS_MISMATCH_LIMIT,
  HARD_DIMS_LIMIT,
  boxSize,
  checkDims,
  frontRotationY,
  rotateBoxY,
  scaleDistortion,
  scaleSizeToDims,
} from './library/fit-math';
export type { Box, DimsCheck, Front, ModelKind, Vec3 } from './library/fit-math';

// ---- cache: generic caches (no WebGL, no node)
export { MEMORY_CACHE_ENTRY_BYTES, MEMORY_CACHE_TOTAL_BYTES, MemoryCache } from './cache/memory-cache';
export type { MemoryCacheOptions, ScopedCache } from './cache/memory-cache';
export { MAX_MODELS, MAX_MODEL_BYTES, createModelCache } from './cache/model-cache';
export type { Loaded, ModelCache, ModelCacheOptions, ModelCacheStats, ModelHandle } from './cache/model-cache';
export { RECORD_TTL_MS, RecordCache } from './cache/record-cache';

// ---- generators and meshes
export { ALL_GENERATORS, GENERATOR_OWNER_ID, MIRROR_DEPTH, RUG_THICKNESS } from './generators';
export { assertGeneratorsRegistered, registerGenerators } from './register';
export { buildBedDressing } from './meshes/bed-dressing';
export { buildItems } from './meshes/build-items';

// ---- materials: item materials and the texture catalog
export { COLOUR_HEX, COLOUR_NAMES, FABRIC_KINDS, ITEM_MATERIALS, ITEM_MATERIAL_SPECS, ITEM_SLOTS, SHEER_MATERIAL, ceramicMaterial, fabricMaterial, itemMaterialFor, parseProductMaterial, photoMaterial, productMaterial, tintMaterial } from './materials/item-materials';
export type { ColourName, FabricKind, ItemMaterialId, ItemMaterialSpec, ProductMaterialKind } from './materials/item-materials';
export { dominantColour } from './materials/dominant-colour';
export { Catalog, CatalogEntry, LicenseEvidence, MaterialCategory, libraryTextureUrl, materialFromCatalog } from './materials/texture-catalog';
export type { MaterialFromCatalogOptions } from './materials/texture-catalog';
export { createCatalogSource } from './materials/texture-catalog-source';
export type { CatalogSource, LibraryCatalog } from './materials/texture-catalog-source';

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
