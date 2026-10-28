// Item contracts a Scene file depends on (docs/architecture/modules.md section 1.1): the mesh source and the generator
// registry (empty by default), the category -> generator defaults, the legacy `builtin:*` assets, pure item helpers and the
// bed-dressing spec. Nothing here builds a mesh.
export * from './mesh-source';
export * from './parametric-defaults';
export * from './builtin-assets';
export * from './item-helpers';
export * from './dressing';
