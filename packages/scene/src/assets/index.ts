export * from './builtin';
export * from './catalog';
// Importing the generators registers them in `GENERATORS` (side effect), so any import of `@flat/scene` has the registry filled.
export { ALL_GENERATORS, MIRROR_DEPTH, RUG_THICKNESS, registerGenerators, tvDims } from './generators';
