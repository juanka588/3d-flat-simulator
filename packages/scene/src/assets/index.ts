export { buildItems } from './build-items';
export { buildBedDressing } from './bed-dressing';
export * from './mesh-catalog';
export * from './resolve';
export * from './products/records';
export * from './products/api';
export { ITEM_MATERIALS, ITEM_MATERIAL_SPECS } from './item-materials';
export type { ItemMaterialId, ItemMaterialSpec } from './item-materials';
// Importing the generators registers them in `GENERATORS` (side effect), so any import of `@flat/scene` has the registry filled.
export { ALL_GENERATORS, MIRROR_DEPTH, RUG_THICKNESS, registerGenerators } from './generators';
